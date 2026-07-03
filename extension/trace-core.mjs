/**
 * trace-core.mjs — pure-node resolver for pi-dynamic-workflows run state.
 *
 * Zero deps beyond node builtins so `checks/02-resolver.mjs` can run it with
 * plain `node`. The TS extension entry imports it relatively (jiti handles it).
 *
 * Storage layout (verified against @quintinshaw/pi-dynamic-workflows
 * src/workflow-paths.ts + src/run-persistence.ts):
 *   projectKey = sanitize(basename(cwd)) + "-" + sha256(resolve(cwd)).slice(0,12)
 *   runsDir    = ~/.pi/workflows/projects/<projectKey>/runs/
 *   legacyDir  = <cwd>/.pi/workflows/runs/           (read-only fallback)
 *   one <runId>.json per run, atomic tmp+rename, previous good save at .json.bak
 */

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve, sep } from "node:path";

/** Mirror of pi-dynamic-workflows sanitizePathSegment. */
function sanitizePathSegment(value) {
  const sanitized = value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return sanitized || "project";
}

/**
 * @param {string} cwd
 * @returns {string} e.g. "avax-1aed70b2cb9f"
 */
export function workflowProjectKey(cwd) {
  const projectPath = resolve(cwd);
  const slug = sanitizePathSegment(basename(projectPath) || "project");
  const hash = createHash("sha256").update(projectPath).digest("hex").slice(0, 12);
  return `${slug}-${hash}`;
}

/**
 * @param {string} cwd
 * @param {string} [home]
 */
export function runsDirFor(cwd, home = homedir()) {
  return join(home, ".pi", "workflows", "projects", workflowProjectKey(cwd), "runs");
}

/** @param {string} cwd */
export function legacyRunsDirFor(cwd) {
  return resolve(cwd, ".pi", "workflows", "runs");
}

const RUN_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/i;

/**
 * Trust boundary: run ids come from user-typed command args. Reject anything
 * that is not a plain id token (no path separators, no dots, no traversal).
 * @param {unknown} id
 */
export function isSafeRunId(id) {
  return typeof id === "string" && RUN_ID_RE.test(id);
}

/**
 * Trust boundary: every file we read must live inside an allowed directory.
 * @param {string} dir
 * @param {string} filePath
 * @returns {string} resolved path
 */
export function assertInside(dir, filePath) {
  const root = resolve(dir) + sep;
  const target = resolve(filePath);
  if (!target.startsWith(root)) {
    throw new Error(`path escapes run storage sandbox: ${filePath}`);
  }
  return target;
}

/**
 * Read + parse one run file. On failure retries `<path>.bak` (mirrors the
 * workflow extension's own load()). Throws only if both fail.
 * @param {string} filePath
 * @returns {any} full PersistedRunState
 */
export function readRunFile(filePath) {
  let lastErr;
  for (const candidate of [filePath, `${filePath}.bak`]) {
    try {
      const data = JSON.parse(readFileSync(candidate, "utf8"));
      if (!data || typeof data !== "object" || typeof data.runId !== "string") {
        throw new Error("not a run state (missing runId)");
      }
      return data;
    } catch (err) {
      lastErr = err;
    }
  }
  throw new Error(
    `unreadable run file ${basename(filePath)} (primary + .bak): ${lastErr?.message ?? lastErr}`,
  );
}

/** @param {any} state @param {string} filePath */
function headerOf(state, filePath) {
  return {
    runId: state.runId,
    workflowName: typeof state.workflowName === "string" ? state.workflowName : undefined,
    status: typeof state.status === "string" ? state.status : "unknown",
    updatedAt: typeof state.updatedAt === "string" ? state.updatedAt : "",
    phases: Array.isArray(state.phases) ? state.phases : [],
    tokenUsage: state.tokenUsage && typeof state.tokenUsage === "object" ? state.tokenUsage : undefined,
    durationMs: typeof state.durationMs === "number" ? state.durationMs : undefined,
    agentCount: Array.isArray(state.agents) ? state.agents.length : 0,
    filePath,
  };
}

/**
 * List run headers, newest first (sorted by `updatedAt` ISO string inside the
 * JSON, matching pi-dynamic-workflows list() semantics — NOT fs mtime).
 * Corrupt files (primary AND .bak unreadable) are skipped and counted.
 *
 * @param {string} cwd
 * @param {{ runsDir?: string, legacyDir?: string }} [opts] test overrides
 * @returns {{ runs: ReturnType<typeof headerOf>[], skipped: { file: string, reason: string }[] }}
 */
export function listRuns(cwd, opts = {}) {
  const dirs = [opts.runsDir ?? runsDirFor(cwd), opts.legacyDir ?? legacyRunsDirFor(cwd)];
  const seen = new Set();
  const runs = [];
  const skipped = [];
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    let names;
    try {
      names = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      // ".json" suffix excludes *.json.bak, *.json.tmp, *.lock, run-*.log
      if (!name.endsWith(".json")) continue;
      const filePath = assertInside(dir, join(dir, name));
      let state;
      try {
        state = readRunFile(filePath);
      } catch (err) {
        skipped.push({ file: filePath, reason: String(err?.message ?? err) });
        continue;
      }
      if (seen.has(state.runId)) continue; // legacy dir dedupe by runId
      seen.add(state.runId);
      runs.push(headerOf(state, filePath));
    }
  }
  runs.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
  return { runs, skipped };
}

/**
 * Resolve the run to display.
 *  - runId given  → that run (id validated first)
 *  - doneOnly     → newest run with status not in {running, pending}
 *  - default      → newest run ("last executed")
 *
 * @param {string} cwd
 * @param {{ runId?: string, doneOnly?: boolean, runsDir?: string, legacyDir?: string }} [opts]
 * @returns {{ run: any | null, header: any | null, skipped: { file: string, reason: string }[], available: any[] }}
 */
export function resolveRun(cwd, opts = {}) {
  if (opts.runId !== undefined && !isSafeRunId(opts.runId)) {
    throw new Error(`invalid run id: ${JSON.stringify(opts.runId)}`);
  }
  const { runs, skipped } = listRuns(cwd, opts);
  let header;
  if (opts.runId) {
    header = runs.find((r) => r.runId === opts.runId);
  } else if (opts.doneOnly) {
    header = runs.find((r) => r.status !== "running" && r.status !== "pending");
  } else {
    header = runs[0];
  }
  if (!header) return { run: null, header: null, skipped, available: runs };
  const run = readRunFile(header.filePath);
  return { run, header, skipped, available: runs };
}

/**
 * Wrap text in a markdown code fence that is guaranteed longer than any
 * backtick run inside the text (nested-fence safe).
 * @param {string} text @param {string} [info]
 */
export function fence(text, info = "") {
  const runs = text.match(/`{3,}/g) ?? [];
  const max = runs.reduce((m, r) => Math.max(m, r.length), 2);
  const f = "`".repeat(max + 1);
  return `${f}${info}\n${text}\n${f}`;
}

/**
 * Render one agent's history[] as markdown. Defensive at the trust boundary:
 * malformed entries are skipped and counted, never thrown on.
 *
 * history entry kinds observed in real fixtures: text | toolCall | toolResult | error
 *
 * @param {any} agent
 * @returns {{ markdown: string, malformed: number }}
 */
export function historyToMarkdown(agent) {
  const parts = [];
  let malformed = 0;
  const history = Array.isArray(agent?.history) ? agent.history : [];
  for (const entry of history) {
    if (!entry || typeof entry !== "object" || typeof entry.kind !== "string") {
      malformed++;
      continue;
    }
    const text = typeof entry.text === "string" ? entry.text : "";
    const tool = typeof entry.toolName === "string" ? entry.toolName : "tool";
    switch (entry.kind) {
      case "text":
        parts.push(text);
        break;
      case "toolCall":
        parts.push(`**→ ${tool}**\n\n${fence(text, "json")}`);
        break;
      case "toolResult":
        parts.push(`${entry.isError ? `**⚠ ${tool} (error)**` : `**← ${tool}**`}\n\n${fence(text)}`);
        break;
      case "error":
        parts.push(`**✖ error**\n\n${fence(text)}`);
        break;
      default:
        malformed++;
        break;
    }
  }
  if (malformed > 0) {
    parts.push(`_${malformed} malformed history entr${malformed === 1 ? "y" : "ies"} skipped_`);
  }
  return { markdown: parts.join("\n\n"), malformed };
}

/** @param {number | undefined} n */
export function formatTokens(n) {
  if (typeof n !== "number" || !Number.isFinite(n)) return "?";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

/** @param {number | undefined} ms */
export function formatDuration(ms) {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) return "?";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${s % 60}s`;
  return `${Math.floor(m / 60)}h${m % 60}m`;
}
