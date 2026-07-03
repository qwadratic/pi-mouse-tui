/**
 * viewer.ts — two-screen trace viewer component (overlay).
 *
 * Screen A: run header + SelectList of agents (grouped by phase order).
 * Screen B: read-only pager over one agent's rendered history.
 *
 * Read-only by design: this component never executes anything; it only
 * renders run state already loaded from the sandboxed runs directory.
 */

import { getMarkdownTheme, type Theme } from "@earendil-works/pi-coding-agent";
import {
  Container,
  Markdown,
  SelectList,
  Text,
  matchesKey,
  truncateToWidth,
  type Component,
  type SelectItem,
} from "@earendil-works/pi-tui";
import { formatDuration, formatTokens, historyToMarkdown } from "./trace-core.mjs";

export interface RunAgent {
  id?: number;
  label?: string;
  phase?: string;
  status?: string;
  model?: string;
  prompt?: string;
  resultPreview?: string;
  error?: string;
  errorCode?: string;
  tokens?: number;
  startedAt?: string;
  endedAt?: string;
  history?: unknown[];
}

export interface RunState {
  runId: string;
  workflowName?: string;
  status?: string;
  phases?: string[];
  currentPhase?: string;
  agents?: RunAgent[];
  tokenUsage?: { total?: number; cost?: number };
  durationMs?: number;
  updatedAt?: string;
}

export interface ViewerDeps {
  tui: { requestRender(): void };
  theme: Theme;
  done: (value: null) => void;
  /** Re-read the run file; null on failure (viewer keeps current state). */
  reloadRun: () => RunState | null;
}

const LIST_PAGE = 10;

function hr(width: number): string {
  return "─".repeat(Math.max(0, width));
}

export class TraceViewer implements Component {
  private run: RunState;
  private readonly deps: ViewerDeps;

  private screen: "list" | "detail" = "list";
  private list!: Container;
  private selectList!: SelectList;
  private listIndex = 0;
  private note = "";

  private agentIdx = 0;
  private top = 0;
  private followTail = true; // spec: jump to last agent output on open
  private cachedBody: string[] | null = null;
  private cachedWidth = 0;

  constructor(run: RunState, deps: ViewerDeps) {
    this.run = run;
    this.deps = deps;
    const agents = this.agents();
    this.listIndex = Math.max(0, agents.length - 1); // preselect newest agent
    this.buildList();
  }

  private agents(): RunAgent[] {
    return Array.isArray(this.run.agents) ? this.run.agents : [];
  }

  // ---------- Screen A ----------

  private buildList(): void {
    const { theme } = this.deps;
    const agents = this.agents();
    const c = new Container();

    const usage = this.run.tokenUsage;
    const header =
      `${this.run.workflowName ?? "workflow"} · ${this.run.runId} · ${this.run.status ?? "?"}` +
      ` · ${formatTokens(usage?.total)} tok` +
      (typeof usage?.cost === "number" ? ` · $${usage.cost.toFixed(2)}` : "") +
      ` · ${formatDuration(this.run.durationMs)}`;
    c.addChild(new Text(theme.fg("accent", theme.bold(truncate(header))), 1, 0));
    if (this.note) c.addChild(new Text(theme.fg("warning", this.note), 1, 0));

    const items: SelectItem[] = agents.map((a, i) => ({
      value: String(i),
      label: `#${a.id ?? i + 1} [${a.phase ?? "?"}] ${a.label ?? "agent"}`,
      description: `${a.status ?? "?"} · ${(a.error ?? a.resultPreview ?? "").slice(0, 200)}`,
    }));
    this.selectList = new SelectList(items, Math.min(Math.max(items.length, 1), 12), {
      selectedPrefix: (t: string) => theme.fg("accent", t),
      selectedText: (t: string) => theme.fg("accent", t),
      description: (t: string) => theme.fg("muted", t),
      scrollInfo: (t: string) => theme.fg("dim", t),
      noMatch: (t: string) => theme.fg("warning", t),
    });
    this.selectList.setSelectedIndex(this.listIndex);
    this.selectList.onSelectionChange = (item) => {
      this.listIndex = Number(item.value);
    };
    this.selectList.onSelect = (item) => {
      this.agentIdx = Number(item.value);
      this.screen = "detail";
      this.followTail = true;
      this.cachedBody = null;
      this.deps.tui.requestRender();
    };
    this.selectList.onCancel = () => this.deps.done(null);
    c.addChild(this.selectList);
    c.addChild(
      new Text(
        theme.fg("dim", "↑↓ pgup/pgdn move · enter open agent · r reload · esc/q close"),
        1,
        0,
      ),
    );
    this.list = c;

    function truncate(s: string): string {
      return s.replace(/[\r\n]+/g, " ");
    }
  }

  // ---------- Screen B ----------

  private detailBody(width: number): string[] {
    if (this.cachedBody && this.cachedWidth === width) return this.cachedBody;
    const agent = this.agents()[this.agentIdx];
    const md = agent ? buildAgentMarkdown(agent) : "_agent not found_";
    let lines: string[];
    try {
      lines = new Markdown(md, 0, 0, getMarkdownTheme()).render(width);
    } catch (err) {
      lines = [`render error: ${String(err)}`];
    }
    // Defensive final pass: pager guarantees every line ≤ width.
    this.cachedBody = lines.map((l) => truncateToWidth(l, width));
    this.cachedWidth = width;
    return this.cachedBody;
  }

  private viewport(): number {
    const rows = process.stdout.rows ?? 30;
    return Math.max(8, Math.floor(rows * 0.8) - 7);
  }

  private renderDetail(width: number): string[] {
    const { theme } = this.deps;
    const agent = this.agents()[this.agentIdx];
    const body = this.detailBody(width);
    const vp = this.viewport();
    const maxTop = Math.max(0, body.length - vp);
    if (this.followTail) this.top = maxTop; // jump to last output
    this.top = Math.max(0, Math.min(this.top, maxTop));

    const title =
      `#${agent?.id ?? "?"} ${agent?.label ?? "agent"} · ${agent?.status ?? "?"}` +
      ` · ${agent?.model ?? "?"} · lines ${Math.min(this.top + 1, body.length)}–${Math.min(this.top + vp, body.length)}/${body.length}`;
    const out: string[] = [];
    out.push(theme.fg("borderAccent", hr(width)));
    out.push(truncateToWidth(theme.fg("accent", theme.bold(title.replace(/[\r\n]+/g, " "))), width));
    if (this.note) out.push(truncateToWidth(theme.fg("warning", this.note), width));
    out.push(...body.slice(this.top, this.top + vp));
    out.push(
      truncateToWidth(
        theme.fg("dim", "↑↓ line · pgup/pgdn page · g/G top/bottom · r reload · esc back · q close"),
        width,
      ),
    );
    out.push(theme.fg("borderAccent", hr(width)));
    return out;
  }

  // ---------- shared ----------

  private reload(): void {
    const next = this.deps.reloadRun();
    if (next) {
      this.run = next;
      this.note = "";
      const agents = this.agents();
      this.listIndex = Math.min(this.listIndex, Math.max(0, agents.length - 1));
      this.agentIdx = Math.min(this.agentIdx, Math.max(0, agents.length - 1));
    } else {
      this.note = "reload failed — showing previous snapshot";
    }
    this.cachedBody = null;
    this.buildList();
    this.deps.tui.requestRender();
  }

  render(width: number): string[] {
    if (this.screen === "detail") return this.renderDetail(width);
    const out: string[] = [];
    out.push(this.deps.theme.fg("borderAccent", hr(width)));
    out.push(...this.list.render(width).map((l) => truncateToWidth(l, width)));
    out.push(this.deps.theme.fg("borderAccent", hr(width)));
    return out;
  }

  handleInput(data: string): void {
    if (this.screen === "list") {
      if (matchesKey(data, "pageUp") || matchesKey(data, "pageDown")) {
        const delta = matchesKey(data, "pageUp") ? -LIST_PAGE : LIST_PAGE;
        this.listIndex = Math.max(0, Math.min(this.listIndex + delta, this.agents().length - 1));
        this.selectList.setSelectedIndex(this.listIndex);
      } else if (data === "r") {
        this.reload();
        return;
      } else if (data === "q") {
        this.deps.done(null);
        return;
      } else {
        this.selectList.handleInput(data);
      }
      this.deps.tui.requestRender();
      return;
    }

    // detail pager
    const vp = this.viewport();
    if (matchesKey(data, "up")) {
      this.followTail = false;
      this.top -= 1;
    } else if (matchesKey(data, "down")) {
      this.followTail = false;
      this.top += 1;
    } else if (matchesKey(data, "pageUp")) {
      this.followTail = false;
      this.top -= vp;
    } else if (matchesKey(data, "pageDown")) {
      this.followTail = false;
      this.top += vp;
    } else if (data === "g") {
      this.followTail = false;
      this.top = 0;
    } else if (data === "G") {
      this.followTail = true;
    } else if (data === "r") {
      this.reload();
      return;
    } else if (matchesKey(data, "escape")) {
      this.screen = "list";
      this.buildList();
    } else if (data === "q") {
      this.deps.done(null);
      return;
    }
    this.deps.tui.requestRender();
  }

  invalidate(): void {
    // Theme may have changed: rebuild all pre-baked themed content.
    this.cachedBody = null;
    this.cachedWidth = 0;
    this.buildList();
  }
}

function buildAgentMarkdown(agent: RunAgent): string {
  const head = [
    `# #${agent.id ?? "?"} ${agent.label ?? "agent"}`,
    `**status** ${agent.status ?? "?"} · **model** ${agent.model ?? "?"} · **tokens** ${formatTokens(agent.tokens)}`,
    `**time** ${agent.startedAt ?? "?"} → ${agent.endedAt ?? "…"}`,
  ];
  if (agent.error || agent.errorCode) {
    head.push(`**error** ${agent.errorCode ?? ""}${agent.errorCode && agent.error ? ": " : ""}${agent.error ?? ""}`);
  }
  const { markdown } = historyToMarkdown(agent);
  return `${head.join("\n\n")}\n\n---\n\n${markdown || "_no history recorded_"}`;
}
