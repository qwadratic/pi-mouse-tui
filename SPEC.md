# SPEC — pi TUI: mouse nav, paging, last-workflow-trace

Adjudication of scout findings (web / docs / wf-trace). Ladder per feature:
pi-native config (zero code) > adopt existing solution > extension code.
Only gaps get built.

Machine facts verified 2026-07-04:
- pi docs: `/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/docs/{tui,keybindings,extensions}.md` (read in full).
- Workflow runs dir exists: `~/.pi/workflows/projects/avax-1aed70b2cb9f/runs/` — 7 runs incl. fixtures `mr58z2jr-p953hb` (897K, 28 agents, 978 history entries), `mr5eqgsw-ndno2m` (677K).
- `jq '[.updatedAt,.runId,.status]' ... | sort -r` resolution baseline reproduced against real files.

---

## 1. Decisions per feature

### 1a. Mouse navigation (wheel scroll, text selection)

**DECISION: pi-native / terminal-native. Zero code. No build.**

Rationale:
- pi renders inline, never enters alt-screen (docs-scout source check: no `?1049` in `pi-tui/dist/terminal.js`) and never enables mouse reporting (no `?1000h/?1002h/?1003h/?1006h` anywhere in `pi-tui/dist/*.js` or `pi-coding-agent/dist/*.js`). `StdinBuffer` parses SGR mouse sequences defensively only.
- Consequence: terminal scrollback stays native → mouse wheel scroll and text selection **already work** in every emulator. Nothing to build; building would *degrade* this (enabling mouse reporting steals wheel/selection from the emulator).

Citations: docs `tui.md` (zero mouse mentions; `handleInput?(data: string)` raw-bytes contract), docs-scout source verification, web-scout row 3/4.

### 1b. Click-to-read-file

**DECISION: adopt terminal-emulator open-on-click (config only). Do NOT build in-pi mouse. Keyboard file-peek overlay = optional stretch, not core gap.**

Rationale:
- In-pi click is impossible on a supported path: pi never enables mouse reporting; events never reach extensions. Only route is an extension writing raw `?1006h` enables itself and parsing SGR through the focused component — unsupported, fragile, and disables native selection/scroll while on. Rejected.
- **Pix** (`pi-ui-extend` npm) delivers clickable file paths, but replaces pi's InteractiveMode wholesale (run `pix`, not `pi`), is Zed-coupled, and `/workflows` compat is load-order-fragile per its own docs. Cost > benefit when the underlying need is "open file I see on screen". Rejected as dependency; fine as idea source.
- Terminal-native covers the need at zero cost: iTerm2 `cmd+click`, WezTerm hyperlink rules, kitty `open_url`/path click → file opens in `$EDITOR` at line:col. Config-only.
- Nearest **in-pi** UX if ever wanted: keyboard fuzzy picker (`SelectList`) + read-only pager overlay. Shares the pager component built for 1d, so it's a cheap stretch (`/peek <path>`), but it is not one of the three scouted build gaps. ponytail: stretch only, ceiling = no syntax-aware jump/definition, upgrade path = open-in-`$EDITOR` fallback.

Citations: web-scout rows 1/3/8 ("no mouse-support extension exists anywhere"), docs-scout capability matrix ("practical answer: not clickable").

### 1c. PgDown / PgUp paging

**DECISION: pi-native, already bound. Zero code. Only our own overlay components implement paging internally.**

Rationale (docs `keybindings.md`):
- Input editor: `tui.editor.pageUp` / `tui.editor.pageDown` — default `pageUp`/`pageDown`.
- List UIs (SelectList-based, incl. `/workflows` navigator lists): `tui.select.pageUp` / `tui.select.pageDown` — default bound.
- Chat history: lives in terminal scrollback (no alt-screen) → terminal-native `Shift+PgUp/PgDn` + wheel. A pi-side history pager would fight the design; not built.
- Rebinding if desired: `~/.pi/agent/keybindings.json`, apply with `/reload`. Zero code.
- The one place paging must be *written*: the trace-viewer detail pager built in 1d handles `pageUp`/`pageDown` in its own `handleInput` via `matchesKey` (`tui.md` "Keyboard Input").

### 1d. Quick access to last executed workflow trace

**DECISION: adopt `/workflows` navigator (installed, covers drill-down) + BUILD the missing one-keystroke last-run jump. This is the only core build.**

Rationale:
- `pi-dynamic-workflows` v2.10.0 `/workflows` TUI already drills runs → phases → agents → detail (prompt, result, errors, tool history). Zero cost, installed.
- Gap (web-scout gap #2): no shortcut/command jumps straight to the latest run's trace; navigator also filters by current `sessionId`, hiding prior-session runs by default. Trivial extension closes it.
- Data source confirmed on disk (wf-scout, re-verified): one JSON per run, `PersistedRunState` shape, `agents[].history[]` pre-truncated (≤40 entries / ≤2000 chars each / ≤20K per agent) — TUI-friendly by design.

---

## 2. Build: `pi-last-trace` extension

Single extension file (jiti-loaded TypeScript, no build step — `extensions.md` "Writing an Extension"). No npm deps: `node:fs`, `node:path`, `node:crypto` + `@earendil-works/pi-tui` / `@earendil-works/pi-coding-agent` imports (`extensions.md` "Available Imports").

### 2.1 Surface

| Registration | Name / key | Behavior |
|---|---|---|
| `pi.registerCommand` | `/trace` | Open trace viewer on last executed run |
| `pi.registerCommand` args | `/trace <runId>` \| `/trace --done` | Specific run; `--done` = last with `status ∉ {running, pending}` |
| `getArgumentCompletions` | run IDs + `--done` | From runs dir listing (`extensions.md` registerCommand) |
| `pi.registerShortcut` | `ctrl+shift+t` | Same as `/trace` (no conflict: `ctrl+t` = thinking toggle, `ctrl+shift+t` unbound per `keybindings.md`) |

### 2.2 Trace resolution (from wf-scout, verified)

```
projectKey = sanitize(basename(cwd)) + "-" + sha256(resolve(cwd)).hex.slice(0,12)
runsDir    = ~/.pi/workflows/projects/<projectKey>/runs/
legacyDir  = <cwd>/.pi/workflows/runs/          # read-only fallback, dedupe by runId
```

1. List `*.json` in runsDir (+legacy), **exclude** `*.json.bak`, `*.json.tmp`, `*.lock`, `run-*.log`.
2. Parse minimal header per file: `{runId, workflowName, status, updatedAt, phases, tokenUsage, durationMs}` (skip `script`, `journal`, `agents[].history` at list stage — ~95% of bytes).
3. Sort by `updatedAt` **desc** (ISO string inside JSON, not fs mtime — matches pi-dynamic-workflows `list()` semantics). Last executed = first entry. `--done` filters `status ∉ {running, pending}` first.
4. Corruption-safe read: on JSON.parse failure of `X.json`, retry `X.json.bak` (mirrors extension's own `load()`); both fail → skip file, `ctx.ui.notify` warning.
5. `status:"running"` files are live (atomic tmp+rename writes): viewer reads a consistent snapshot; offer `r` = reload.

Sanity baseline (must match implementation output):

```bash
jq -r '[.updatedAt,.runId,.status]|@tsv' ~/.pi/workflows/projects/avax-1aed70b2cb9f/runs/*.json | sort -r
```

### 2.3 Viewer UI (components per `docs/tui.md`)

`ctx.ui.custom(factory, { overlay: true, overlayOptions: { anchor: "center", width: "80%", maxHeight: "80%", visible: (w) => w >= 60 } })` — promise resolves via `done()`; fresh instance per open ("Overlay Lifecycle": never reuse disposed components).

Two screens inside one container component (state machine, rebuild-on-invalidate pattern from `tui.md`):

**Screen A — run + agents list**
- `DynamicBorder` (top/bottom, `(s: string) => theme.fg("accent", s)` — typed param per tui.md Key Rules).
- `Text` header: `workflowName · runId · status · tokens/cost · durationMs`.
- `SelectList` of `agents[]` grouped by `phase`: label = `[phase] label — status`, description = truncated `result`/`error`. Paging free via built-in `tui.select.pageUp/pageDown`. `onSelect` → Screen B; `onCancel` → `done(null)`.

**Screen B — agent detail pager (the one custom component)**
- Content: agent header (`model`, `status`, `startedAt→endedAt`, `errorCode?`) + `history[]` rendered as `Markdown` (`getMarkdownTheme()`):
  - `text` → raw markdown; `toolCall` → fenced ` ```json ` block titled `toolName`; `toolResult` → fenced block, `theme.fg("error", …)` label when `isError`; `error` → `theme.fg("error", …)`.
- Pager = selected-line window over pre-rendered lines (pattern: `tui.md` "Creating Custom Components" selector + render cache `{cachedWidth, cachedLines}`; every line through `truncateToWidth`).
- `handleInput` (via `matchesKey`): `up/down` line, **`pageUp`/`pageDown` page**, `g`/`G` top/bottom, `esc`/`q` back to Screen A, `r` reload run file. `tui.requestRender()` after every state change.
- Component returns `{ render, invalidate, handleInput }` triple; `invalidate()` rebuilds themed content (theme-change rule from tui.md "Invalidation and Theme Changes").

ponytail: no search inside pager, no live-tail of running runs (manual `r` reload). Ceiling named; upgrade path = fs.watch on the run file.

### 2.4 Stretch (optional, not core): `/peek <path>`

Fuzzy file picker (`SelectList` + `enableSearch`) feeding the same Screen-B pager with `highlightCode()`/`getLanguageFromPath()` output. Only if in-pi file reading is later demanded; terminal cmd+click already covers the need (1b).

---

## 3. Config deliverables (zero-code features)

Documented in README (not built, just written down for the user):
1. Terminal open-on-click: iTerm2 `cmd+click` semantic history → `$EDITOR`; WezTerm `hyperlink_rules`; kitty path-click. Covers 1b.
2. Terminal paging: `Shift+PgUp/PgDn` scrollback. Covers 1c chat history.
3. Optional `~/.pi/agent/keybindings.json` sample rebinding editor/list paging if user wants non-default keys; apply with `/reload`.

---

## 4. Verification plan

### Auto-testable (scripted, `checks/` in this repo)

| Check | How |
|---|---|
| Typecheck / load | `jiti` import of extension file; call default factory with stub `ExtensionAPI` recording `registerCommand`/`registerShortcut` calls; assert `/trace` + `ctrl+shift+t` registered. `tsc --noEmit` on the file. |
| Trace resolution vs real runs | Run resolver against `~/.pi/workflows/projects/avax-1aed70b2cb9f/runs/`; assert output order == `jq ... | sort -r` baseline; assert fixture IDs `mr58z2jr-p953hb`, `mr5eqgsw-ndno2m` present and headers parse (`workflowName`, `phases`, `tokenUsage.total > 0`). |
| projectKey derivation | Assert derived key for `/Users/gerhardgustav/Desktop/hobby-dev/avax` == `avax-1aed70b2cb9f` (known-good from wf-scout). |
| `.bak` fallback | Copy real run to tmp dir, truncate `X.json` mid-file, keep `X.json.bak`; assert resolver returns run via bak. |
| `--done` filter | With a `status:"running"` fixture present, assert `--done` skips it, default doesn't. |
| history render | Feed one real `agents[].history` array through the pager's line builder; assert every line ≤ width (`visibleWidth`), no throw on all 4 kinds (`text/toolCall/toolResult/error`). |

No test framework — plain `node --test` or assert scripts (ponytail).

### Manual checklist (mouse & interactive — cannot automate)

- [ ] Wheel scroll through pi chat history (native scrollback) — no capture, smooth.
- [ ] Text selection with mouse works while pi running.
- [ ] `cmd+click` (iTerm2) / hyperlink click (WezTerm/kitty) on a file path printed by pi opens it in `$EDITOR`.
- [ ] `Shift+PgUp/PgDn` pages chat history in emulator.
- [ ] `PgUp/PgDn` in pi input editor pages multi-line draft.
- [ ] `PgUp/PgDn` in `/workflows` lists and in `/trace` Screen A pages the list.
- [ ] `ctrl+shift+t` opens last run instantly; header matches newest `updatedAt`.
- [ ] `/trace mr58z2jr-p953hb` opens that fixture; drill into an agent; page with `PgUp/PgDn`; `esc` back; `q` closes; overlay reopens cleanly (fresh instance).
- [ ] `/trace` while a workflow is running: shows running run; `r` reloads with newer state; `--done` skips it.
- [ ] Theme switch while viewer open → colors update (invalidate path).
- [ ] `/workflows` (pi-dynamic-workflows) still works with extension loaded — no command/shortcut collision.

---

## 5. Summary table

| Feature | Verdict | Cost |
|---|---|---|
| Mouse wheel/selection | terminal-native, pi never captures mouse | zero |
| Click-to-read-file | terminal cmd+click (config); in-pi click rejected (unsupported hack, UX regression); Pix rejected (replaces pi TUI) | zero (config) |
| PgUp/PgDn | native: `tui.editor.*` + `tui.select.*` bound; chat = terminal scrollback | zero |
| Last workflow trace | `/workflows` for drill-down + **BUILD `pi-last-trace`**: `/trace` + `ctrl+shift+t`, resolver on `~/.pi/workflows/projects/<key>/runs/*.json` sorted `updatedAt` desc, SelectList + custom pager overlay | one small extension |
