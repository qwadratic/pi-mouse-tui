/**
 * pi-last-trace — quick access to the last executed pi-dynamic-workflows trace.
 *
 * Surface:
 *   /trace            open viewer on last executed run (newest updatedAt)
 *   /trace <runId>    open a specific run (id validated, sandboxed lookup)
 *   /trace --done     last run with status ∉ {running, pending}
 *   ctrl+shift+t      same as /trace
 *
 * Trust boundaries:
 *   - run ids validated (isSafeRunId) before any fs use
 *   - only files inside the project runs dir / legacy runs dir are read
 *   - corrupt run files skipped with a count, .bak fallback per file
 *   - viewer is read-only; nothing is executed
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { isSafeRunId, listRuns, readRunFile, resolveRun } from "./trace-core.mjs";
import { TraceViewer, type RunState } from "./viewer.ts";

const DESCRIPTION = "Open trace viewer for the last executed workflow run";

export default function (pi: ExtensionAPI) {
  async function openTrace(args: string | undefined, ctx: ExtensionContext): Promise<void> {
    if (ctx.mode !== "tui") {
      if (ctx.hasUI) ctx.ui.notify("/trace requires interactive TUI mode", "warning");
      return;
    }

    const tokens = (args ?? "").trim().split(/\s+/).filter(Boolean);
    const doneOnly = tokens.includes("--done");
    const runId = tokens.find((t) => !t.startsWith("--"));
    if (runId !== undefined && !isSafeRunId(runId)) {
      ctx.ui.notify(`Invalid run id: ${runId}`, "error");
      return;
    }

    let resolved: ReturnType<typeof resolveRun>;
    try {
      resolved = resolveRun(ctx.cwd, { runId, doneOnly });
    } catch (err) {
      ctx.ui.notify(`Trace resolution failed: ${String((err as Error).message ?? err)}`, "error");
      return;
    }

    if (resolved.skipped.length > 0) {
      ctx.ui.notify(`Skipped ${resolved.skipped.length} corrupt run file(s)`, "warning");
    }
    if (!resolved.run || !resolved.header) {
      ctx.ui.notify(
        runId
          ? `Run not found: ${runId}`
          : doneOnly
            ? "No finished workflow runs for this project"
            : "No workflow runs found for this project",
        "warning",
      );
      return;
    }

    const runPath: string = resolved.header.filePath;
    await ctx.ui.custom<null>(
      (tui, theme, _keybindings, done) =>
        new TraceViewer(resolved.run as RunState, {
          tui,
          theme,
          done,
          reloadRun: () => {
            try {
              return readRunFile(runPath) as RunState;
            } catch {
              return null;
            }
          },
        }),
      {
        overlay: true,
        overlayOptions: {
          anchor: "center",
          width: "80%",
          maxHeight: "80%",
          visible: (termWidth: number) => termWidth >= 60,
        },
      },
    );
  }

  pi.registerCommand("trace", {
    description: `${DESCRIPTION} (args: <runId> | --done)`,
    getArgumentCompletions: (prefix: string): AutocompleteItem[] | null => {
      try {
        const { runs } = listRuns(process.cwd());
        const items: AutocompleteItem[] = [
          { value: "--done", label: "--done", description: "last finished run (skip running/pending)" },
          ...runs.map((r) => ({
            value: r.runId,
            label: r.runId,
            description: `${r.status} · ${r.workflowName ?? "workflow"} · ${r.updatedAt}`,
          })),
        ];
        const filtered = items.filter((i) => i.value.startsWith(prefix));
        return filtered.length > 0 ? filtered : null;
      } catch {
        return null;
      }
    },
    handler: openTrace,
  });

  // ctrl+t = thinking toggle, ctrl+shift+t is unbound per keybindings.md.
  pi.registerShortcut("ctrl+shift+t", {
    description: DESCRIPTION,
    handler: (ctx) => openTrace("", ctx),
  });

  if (process.env.PI_LAST_TRACE_DEBUG) {
    console.error("[pi-last-trace] registered command=/trace shortcut=ctrl+shift+t");
  }
}
