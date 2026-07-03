# pi-mouse-tui — mouse nav, paging, last-workflow-trace for pi

Scouted first, built last. Three of four features need **zero code** (pi/terminal
already cover them); the one real gap is quick access to the last executed
`pi-dynamic-workflows` trace → the **`pi-last-trace`** extension in
[`extension/`](extension/). Full adjudication in [SPEC.md](SPEC.md).

## Feature table

| Feature | Verdict | What you do |
|---|---|---|
| Mouse wheel scroll + text selection | **terminal-native** — pi never enters alt-screen and never enables mouse reporting, so your emulator keeps scrollback/selection | nothing |
| Click-to-read-file | **terminal config** — iTerm2 `cmd+click` (semantic history → `$EDITOR`), WezTerm `hyperlink_rules`, kitty path click | one-time emulator config |
| PgUp/PgDn paging | **pi-native** — editor: `tui.editor.pageUp/pageDown`; lists: `tui.select.pageUp/pageDown`; chat history: terminal `Shift+PgUp/PgDn` scrollback | nothing (rebind via `~/.pi/agent/keybindings.json` + `/reload` if wanted) |
| Last executed workflow trace | **BUILT** — `/trace` + `ctrl+shift+t` overlay viewer over `~/.pi/workflows/projects/<key>/runs/*.json` (newest `updatedAt` first) | install below |

## Install

Quick test:

```bash
pi -e /path/to/pi-mouse-tui/extension/index.ts
```

Permanent (auto-discovery + `/reload` support) — either:

```bash
ln -s /path/to/pi-mouse-tui/extension ~/.pi/agent/extensions/pi-last-trace
```

or add to `~/.pi/agent/settings.json`:

```json
{ "extensions": ["/path/to/pi-mouse-tui/extension"] }
```

## Usage

| Surface | Behavior |
|---|---|
| `/trace` | Viewer on the **last executed** run (newest `updatedAt`, running included) |
| `/trace <runId>` | Specific run (tab-completes real run ids) |
| `/trace --done` | Last run with status ∉ {running, pending} |
| `ctrl+shift+t` | Same as `/trace` |

Viewer (overlay, 80% width, centered):

- **Screen A** — run header (`workflow · runId · status · tokens · $cost · duration`) +
  agent list grouped by phase, newest agent preselected.
  Keys: `↑↓` `pgup/pgdn` move · `enter` open agent · `r` reload · `esc`/`q` close.
- **Screen B** — agent detail pager (header, then `history[]` as markdown:
  tool calls/results in fenced blocks, errors flagged). **Opens jumped to the
  last output.** Keys: `↑↓` line · `pgup/pgdn` page · `g`/`G` top/bottom ·
  `r` reload (for running runs) · `esc` back · `q` close.

Defensive by design: corrupt run files fall back to `.json.bak`, otherwise get
skipped with a count; malformed history entries are skipped with a count; run
ids are validated and all reads sandboxed to the workflow runs dirs; the viewer
executes nothing.

## Checks

```bash
bash checks/run-all.sh
```

| Check | What it proves |
|---|---|
| `02-resolver.mjs` | projectKey derivation == known-good; run order == raw `updatedAt` sort baseline; real fixtures `mr58z2jr-p953hb`/`mr5eqgsw-ndno2m` resolve + history renders (all kinds, 0 malformed); `.bak` fallback; `--done` filter; corrupt-file skip counting; run-id/path sandbox rejections; nested-fence safety |
| `03-typecheck.sh` | `tsc --noEmit` (pi types via global install paths — machine-specific) |
| `04-viewer-smoke.mjs` | headless TraceViewer against a real run: width invariant on both screens, paging, `g`/`G`, reload, esc/q, invalidate |
| `01-load.sh` | `pi -p -e extension/index.ts` trivial prompt exits 0 + registration line printed |

## Manual checklist (mouse & interactive — cannot automate)

- [ ] Wheel scroll through pi chat history (native scrollback) — no capture, smooth.
- [ ] Text selection with mouse works while pi running.
- [ ] `cmd+click` (iTerm2) / hyperlink click (WezTerm/kitty) on a file path printed by pi opens it in `$EDITOR`.
- [ ] `Shift+PgUp/PgDn` pages chat history in emulator.
- [ ] `PgUp/PgDn` in pi input editor pages a multi-line draft.
- [ ] `PgUp/PgDn` in `/workflows` lists and in `/trace` Screen A pages the list.
- [ ] `ctrl+shift+t` opens last run instantly; header matches newest `updatedAt`.
- [ ] `/trace mr58z2jr-p953hb` opens that fixture; drill into an agent; page with `PgUp/PgDn`; `esc` back; `q` closes; overlay reopens cleanly.
- [ ] `/trace` while a workflow is running: shows running run; `r` reloads with newer state; `--done` skips it.
- [ ] Theme switch while viewer open → colors update (invalidate path).
- [ ] `/workflows` (pi-dynamic-workflows) still works with extension loaded — no command/shortcut collision.

## Layout

```
extension/
  index.ts        entry — /trace command, completions, ctrl+shift+t
  viewer.ts       overlay component (Screen A list, Screen B pager)
  trace-core.mjs  pure-node resolver (plain `node`-importable for checks)
checks/           runnable self-checks (see table above)
```

ponytail ceilings (named in SPEC §2.3): no search inside pager, no live-tail of
running runs (`r` = manual reload; upgrade path: fs.watch on the run file).
`tsconfig.json` + checks 03/04 hardcode the Homebrew global pi install path.
