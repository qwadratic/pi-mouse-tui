#!/usr/bin/env node
/**
 * Headless viewer smoke — instantiates TraceViewer against a real fixture run
 * and drives both screens (render width invariant, paging, g/G, reload,
 * esc/q, invalidate). Uses jiti + the global pi install (machine-specific,
 * same as checks/03).
 */
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
process.chdir(join(dirname(fileURLToPath(import.meta.url)), ".."));
const PI = "/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent";
const { createJiti } = await import(PI + "/node_modules/jiti/lib/jiti.mjs");
const jiti = createJiti(import.meta.url, {
  alias: {
    "@earendil-works/pi-coding-agent": PI,
    "@earendil-works/pi-tui": PI + "/node_modules/@earendil-works/pi-tui",
  },
});
const themeMod = await jiti.import(PI + "/dist/modes/interactive/theme/theme.js");
themeMod.initTheme("dark", false);
const theme = themeMod.theme;

const { TraceViewer } = await jiti.import(process.cwd() + "/extension/viewer.ts");
const { resolveRun } = await import(process.cwd() + "/extension/trace-core.mjs");

const { run } = resolveRun("/Users/gerhardgustav/Desktop/hobby-dev/avax", { runId: "mr58z2jr-p953hb" });
let doneVal = "unset";
const v = new TraceViewer(run, {
  tui: { requestRender() {} },
  theme,
  done: (x) => { doneVal = x; },
  reloadRun: () => run,
});
const { visibleWidth } = await jiti.import(PI + "/node_modules/@earendil-works/pi-tui");

const W = 100;
// Screen A renders, every line <= width
let lines = v.render(W);
assert.ok(lines.length > 3, "list renders");
for (const l of lines) assert.ok(visibleWidth(l) <= W, `list line too wide: ${visibleWidth(l)}`);

// enter -> detail (send raw enter key \r)
v.handleInput("\r");
lines = v.render(W);
assert.ok(lines.length > 5, "detail renders");
for (const l of lines) assert.ok(visibleWidth(l) <= W, `detail line too wide: ${visibleWidth(l)}`);

// pageUp changes window
const before = v.render(W).join("\n");
v.handleInput("\x1b[5~"); // pageUp
const after = v.render(W).join("\n");
assert.notEqual(before, after, "pageUp scrolls");

// g -> top, G -> bottom
v.handleInput("g");
const top = v.render(W).join("\n");
v.handleInput("G");
const bottom = v.render(W).join("\n");
assert.notEqual(top, bottom, "g/G jump");
assert.equal(bottom, before, "G returns to tail (opened at last output)");

// r reload keeps rendering
v.handleInput("r");
assert.ok(v.render(W).length > 0);

// esc -> back to list, q -> done(null)
v.handleInput("\x1b");
v.handleInput("q");
assert.equal(doneVal, null, "q closes with null");

// invalidate (theme change path) doesn't throw and re-renders
v.invalidate();
assert.ok(v.render(W).length > 0);

console.log("viewer smoke OK — detail lines:", lines.length);
