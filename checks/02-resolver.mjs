#!/usr/bin/env node
/**
 * Resolver check — runs against REAL workflow runs on this machine plus
 * synthetic tmp fixtures. Plain node, no framework.
 *
 * Machine expectations (documented in SPEC.md):
 *   - project /Users/gerhardgustav/Desktop/hobby-dev/avax has runs incl.
 *     fixtures mr58z2jr-p953hb and mr5eqgsw-ndno2m
 */
import assert from "node:assert/strict";
import { copyFileSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertInside,
  fence,
  historyToMarkdown,
  isSafeRunId,
  listRuns,
  readRunFile,
  resolveRun,
  runsDirFor,
  workflowProjectKey,
} from "../extension/trace-core.mjs";

const AVAX = "/Users/gerhardgustav/Desktop/hobby-dev/avax";
const FIXTURES = ["mr58z2jr-p953hb", "mr5eqgsw-ndno2m"];

// --- 1. projectKey derivation (known-good from wf-scout) ---
assert.equal(workflowProjectKey(AVAX), "avax-1aed70b2cb9f", "projectKey derivation");

// --- 2. real-run listing: order matches independent baseline ---
const runsDir = runsDirFor(AVAX);
const { runs, skipped } = listRuns(AVAX);
assert.equal(skipped.length, 0, `no corrupt real runs expected, got: ${JSON.stringify(skipped)}`);
assert.ok(runs.length >= 2, "expected multiple real runs");

// independent baseline: raw JSON.parse of every *.json, sorted by updatedAt desc
const baseline = readdirSync(runsDir)
  .filter((n) => n.endsWith(".json"))
  .map((n) => JSON.parse(readFileSync(join(runsDir, n), "utf8")))
  .map((s) => `${s.updatedAt}\t${s.runId}`)
  .sort()
  .reverse();
assert.deepEqual(
  runs.map((r) => `${r.updatedAt}\t${r.runId}`),
  baseline,
  "listRuns order must equal `jq [.updatedAt,.runId] | sort -r` baseline",
);

for (const id of FIXTURES) {
  assert.ok(runs.some((r) => r.runId === id), `fixture ${id} present`);
}

// --- 3. newest resolution + header parse ---
const newest = resolveRun(AVAX, {});
assert.equal(newest.run.runId, runs[0].runId, "default = newest updatedAt");

for (const id of FIXTURES) {
  const { run, header } = resolveRun(AVAX, { runId: id });
  assert.equal(run.runId, id);
  assert.ok(typeof run.workflowName === "string" && run.workflowName.length > 0, `${id} workflowName`);
  assert.ok(Array.isArray(run.phases) && run.phases.length > 0, `${id} phases`);
  assert.ok(run.tokenUsage && run.tokenUsage.total > 0, `${id} tokenUsage.total > 0`);
  assert.ok(header.agentCount > 0, `${id} agents present`);

  // trace head: every agent's real history renders without throw, zero malformed
  const kinds = new Set();
  for (const agent of run.agents) {
    const { markdown, malformed } = historyToMarkdown(agent);
    assert.equal(malformed, 0, `${id} agent ${agent.id} real history has no malformed entries`);
    assert.ok(markdown.length > 0, `${id} agent ${agent.id} rendered non-empty`);
    for (const h of agent.history ?? []) kinds.add(h.kind);
  }
  assert.ok(kinds.has("text") && kinds.has("toolCall") && kinds.has("toolResult"), `${id} covers core kinds`);
}

// --- 4. synthetic fixtures in tmp dir ---
const tmp = mkdtempSync(join(tmpdir(), "pi-last-trace-check-"));
try {
  const realNewest = runs[0].filePath;

  // 4a. .bak fallback: truncated primary, intact .bak
  copyFileSync(realNewest, join(tmp, "bakked.json.bak"));
  const full = readFileSync(realNewest, "utf8");
  writeFileSync(join(tmp, "bakked.json"), full.slice(0, Math.floor(full.length / 2)));
  const viaBak = readRunFile(join(tmp, "bakked.json"));
  assert.equal(viaBak.runId, runs[0].runId, ".bak fallback returns the run");

  // 4b. --done filter: running run is newest, doneOnly skips it
  const mk = (runId, status, updatedAt) =>
    writeFileSync(join(tmp, `${runId}.json`), JSON.stringify({ runId, status, updatedAt, agents: [] }));
  rmSync(join(tmp, "bakked.json"));
  rmSync(join(tmp, "bakked.json.bak"));
  mk("aaa-running", "running", "2099-01-02T00:00:00.000Z");
  mk("bbb-done", "completed", "2099-01-01T00:00:00.000Z");
  const opts = { runsDir: tmp, legacyDir: join(tmp, "no-legacy") };
  assert.equal(resolveRun(AVAX, { ...opts }).run.runId, "aaa-running", "default includes running");
  assert.equal(resolveRun(AVAX, { ...opts, doneOnly: true }).run.runId, "bbb-done", "--done skips running");

  // 4c. corrupt file (no .bak) skipped with count, others still listed
  writeFileSync(join(tmp, "corrupt.json"), "{not json");
  const withCorrupt = listRuns(AVAX, opts);
  assert.equal(withCorrupt.skipped.length, 1, "corrupt file counted");
  assert.equal(withCorrupt.runs.length, 2, "healthy runs still listed");

  // 4d. non-run json (valid JSON, wrong shape) also skipped, not crashed on
  writeFileSync(join(tmp, "notarun.json"), JSON.stringify({ hello: "world" }));
  assert.equal(listRuns(AVAX, opts).skipped.length, 2, "wrong-shape json skipped");
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

// --- 5. trust boundaries ---
for (const bad of ["../etc", "a/b", "a\\b", ".", "", "x".repeat(70), "id.json"]) {
  assert.equal(isSafeRunId(bad), false, `unsafe id rejected: ${JSON.stringify(bad)}`);
}
assert.equal(isSafeRunId("mr58z2jr-p953hb"), true);
assert.throws(() => resolveRun(AVAX, { runId: "../escape" }), /invalid run id/);
assert.throws(() => assertInside("/tmp/sandbox", "/tmp/sandbox/../outside.json"), /escapes/);
assert.throws(() => assertInside("/tmp/sandbox", "/tmp/sandbox-evil/x.json"), /escapes/);

// --- 6. malformed history skipped with count; nested fences stay intact ---
const mangled = historyToMarkdown({
  history: [
    { kind: "text", text: "ok" },
    null,
    { kind: "wat", text: "?" },
    "garbage",
    { kind: "error", text: "boom" },
  ],
});
assert.equal(mangled.malformed, 3, "malformed entries counted");
assert.match(mangled.markdown, /3 malformed history entries skipped/);
assert.match(mangled.markdown, /boom/);

const nested = fence("uses ```js\ncode\n``` inside", "json");
assert.match(nested, /^````json\n/, "fence longer than inner backtick run");

console.log("resolver check OK —", runs.length, "real runs, newest:", runs[0].runId);
