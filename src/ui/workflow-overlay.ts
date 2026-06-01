/**
 * WorkflowOverlay — non-capturing overlay popup with live DAG progress
 * and streaming node output.
 *
 * Design mirrors Archon Web UI's WorkflowLogs + DagNodeProgress:
 *
 * ┌──────────────────────────────────────────────────────┐
 * │ Header: status icon + name + elapsed + current node  │
 * ├──────────────────────────────────────────────────────┤
 * │ Node list: state icons + names + details             │
 * │ (scrollable, selected node highlighted,              │
 * │  running node accent-emphasized,                     │
 * │  loop iterations expandable with 'i')                │
 * ├──────────────────────────────────────────────────────┤
 * │ Output panel: streaming AI text + tool call cards    │
 * │ ● Running node: live streaming text, "Thinking…"    │
 * │   placeholder, tool calls with live timers,          │
 * │   tool results with output preview (expandable)      │
 * │ ● Completed node: full output from API/logLines      │
 * │ (scrollable, auto-follows latest)                    │
 * ├──────────────────────────────────────────────────────┤
 * │ Footer: keybindings + status                         │
 * └──────────────────────────────────────────────────────┘
 *
 * Views:
 * Progress view (default): node list + output panel for running node
 * Log inspector view (Enter on a node): full-screen log for that node
 *
 * Data sources:
 * - DagProgressTracker: node state, streamingText, toolCalls, logLines
 * - SSE conversation stream → tracker.appendStreamingText + startToolCall/completeToolCall
 * - Archon API → tracker.setNodeOutput (full completed output)
 */

import type { Component, Theme, OverlayHandle } from "@mariozechner/pi-tui";
import {
	truncateToWidth,
	visibleWidth,
	matchesKey,
	Key,
} from "@mariozechner/pi-tui";
import type { DagProgressTracker } from "../dag-tracker";
import type { DagNodeInfo, DagNodeState, ToolCallRecord } from "../types";

// ── State icons ──────────────────────────────────────────────
const NODE_ICONS: Record<DagNodeState, string> = {
	queued: "○",
	running: "●",
	done: "✓",
	error: "✗",
	skipped: "⊘",
	approval: "⏸",
};

const NODE_COLORS: Record<
	DagNodeState,
	"accent" | "success" | "error" | "warning" | "muted" | "dim"
> = {
	queued: "dim",
	running: "accent",
	done: "success",
	error: "error",
	skipped: "warning",
	approval: "warning",
};

// ── Iteration state icons ────────────────────────────────────
const ITER_ICONS: Record<string, string> = {
	running: "●",
	completed: "✓",
	failed: "✗",
};

// ── View mode ────────────────────────────────────────────────
type OverlayView = "progress" | "logs";

// ── Public config ────────────────────────────────────────────
export interface WorkflowOverlayOptions {
	workflowName: string;
	queryPreview: string;
	dagTracker: DagProgressTracker;
	onCancel?: () => void;
	/** Called when overlay wants to resize */
	onResize?: (handle: OverlayHandle, width: number) => void;
	overlayHandle?: OverlayHandle;
}

// ── Component ────────────────────────────────────────────────
export class WorkflowOverlay implements Component {
	private readonly workflowName: string;
	private readonly queryPreview: string;
	private readonly tracker: DagProgressTracker;
	private readonly onCancel?: () => void;
	private theme: Theme;
	private startedAt: number;
	private _expanded = false;

	// Progress view state
	private scrollOffset = 0;
	private selectedNodeIdx = 0;

	// Log inspector view state
	private view: OverlayView = "progress";
	private inspectedNode: DagNodeInfo | null = null;
	private logScrollOffset = 0;

	// Output panel scroll (for progress view's bottom section)
	private outputScrollOffset = 0;
	private outputAutoFollow = true;

	constructor(opts: WorkflowOverlayOptions, theme: Theme) {
		this.workflowName = opts.workflowName;
		this.queryPreview = opts.queryPreview;
		this.tracker = opts.dagTracker;
		this.onCancel = opts.onCancel;
		this.theme = theme;
		this.startedAt = Date.now();
	}

	// ── Public API ────────────────────────────────────────────

	reset(): void {
		this.startedAt = Date.now();
		this.scrollOffset = 0;
		this.selectedNodeIdx = 0;
		this.view = "progress";
		this.inspectedNode = null;
		this.logScrollOffset = 0;
		this.outputScrollOffset = 0;
		this.outputAutoFollow = true;
	}

	get expanded(): boolean {
		return this._expanded;
	}

	set expanded(v: boolean) {
		this._expanded = v;
		this.scrollOffset = 0;
		this.selectedNodeIdx = 0;
	}

	get currentView(): OverlayView {
		return this.view;
	}

	// ── Component interface ───────────────────────────────────

	render(width: number, _height?: number): string[] {
		if (this.view === "logs" && this.inspectedNode) {
			return this.renderLogs(width, _height);
		}
		return this.renderProgress(width, _height);
	}

	handleInput(data: string): boolean {
		if (this.view === "logs") {
			return this.handleLogsInput(data);
		}
		return this.handleProgressInput(data);
	}

	// ── Progress view (3-section layout) ──────────────────────

	private renderProgress(width: number, _height?: number): string[] {
		const w = Math.max(width, 52);
		const th = this.theme;
		const elapsed = fmtElapsed(
			Math.floor((Date.now() - this.startedAt) / 1000),
		);
		const tracker = this.tracker;
		const progress = tracker.progressSummary(
			Math.floor((Date.now() - this.startedAt) / 1000),
		);
		const lines: string[] = [];
		const bl = "│";
		const border = (s: string) => th.fg("border", s);
		const innerWidth = w - 2;

		// ── Section 1: Header ──────────────────────────────
		const statusIcon = tracker.workflowDone
			? tracker.workflowError
				? th.fg("error", "✗")
				: th.fg("success", "✓")
			: th.fg("accent", "◆");

		const titleText = `${statusIcon} ${this.workflowName}`;
		const timeText = tracker.workflowDone ? elapsed : progress;
		lines.push(border("╭") + border("─".repeat(innerWidth)) + border("╮"));
		lines.push(
			border(bl) +
				padLine(`${titleText} ${th.fg("dim", timeText)}`, innerWidth) +
				border(bl),
		);

		// Currently executing indicator
		const runningNodeId = tracker.currentRunningNodeId;
		if (runningNodeId && !tracker.workflowDone) {
			const runNode = tracker.nodes.find((n) => n.id === runningNodeId);
			const nodeElapsed = runNode?.startedAt
				? fmtElapsed(Math.floor((Date.now() - runNode.startedAt) / 1000))
				: "";
			const execLabel = th.fg(
				"accent",
				`● Executing: ${truncateToWidth(runningNodeId, innerWidth - 20)}`,
			);
			const execTime = th.fg("dim", nodeElapsed);
			lines.push(
				border(bl) +
					padLine(` ${execLabel} ${execTime}`, innerWidth) +
					border(bl),
			);
		}

		if (this.queryPreview) {
			const preview = truncateToWidth(
				this.queryPreview.length > innerWidth - 4
					? `${this.queryPreview.slice(0, innerWidth - 5)}…`
					: this.queryPreview,
				innerWidth,
			);
			lines.push(
				border(bl) +
					padLine(th.fg("dim", ` ${preview}`), innerWidth) +
					border(bl),
			);
		}

		// ── Section 2: Node list ───────────────────────────
		lines.push(border(bl) + border("├" + "─".repeat(innerWidth - 1) + "┤"));

		const nodes = tracker.nodes;
		// Calculate visible node lines (accounting for expanded iterations)
		const nodeLineCount = this.countNodeLines(nodes);
		const maxNodeVisible = this._expanded ? 12 : 5;
		const maxScroll = Math.max(0, nodeLineCount - maxNodeVisible);
		if (this.scrollOffset > maxScroll) this.scrollOffset = maxScroll;
		if (this.scrollOffset < 0) this.scrollOffset = 0;

		if (nodes.length > 0) {
			this.selectedNodeIdx = Math.min(this.selectedNodeIdx, nodes.length - 1);
		}

		// Render node lines (with iteration expansion)
		const rendered = this.renderNodeList(nodes, innerWidth, maxNodeVisible);
		for (const line of rendered) {
			lines.push(border(bl) + padLine(` ${line}`, innerWidth) + border(bl));
		}

		if (nodes.length === 0) {
			lines.push(
				border(bl) +
					padLine(th.fg("dim", " (no nodes yet)"), innerWidth) +
					border(bl),
			);
		}

		// ── Section 3: Output panel ────────────────────────
		// Show the selected node's output (or running node if nothing selected)
		const outputNode = nodes.length > 0 ? nodes[this.selectedNodeIdx] : null;
		const runningNode = this.findRunningNode(nodes);

		// Prefer the selected node, but if it's the running node, show live output
		const displayNode =
			outputNode?.state === "running"
				? outputNode
				: (runningNode ?? outputNode);

		lines.push(border(bl) + border("├" + "─".repeat(innerWidth - 1) + "┤"));

		if (displayNode) {
			// Render the output panel with streaming text + tool calls
			const outputLines = this.renderOutputPanel(displayNode, innerWidth, th);
			for (const line of outputLines) {
				lines.push(border(bl) + padLine(line, innerWidth) + border(bl));
			}
		} else {
			lines.push(
				border(bl) +
					padLine(th.fg("dim", " (no output yet)"), innerWidth) +
					border(bl),
			);
			for (let i = 0; i < 3; i++) {
				lines.push(border(bl) + " ".repeat(innerWidth) + border(bl));
			}
		}

		// ── Footer ───────────────────────────────────────────
		const scrollHint = nodes.length > maxNodeVisible ? " · ↑/↓ nodes" : "";
		const enterHint = nodes.length > 0 ? " · Enter=logs" : "";
		const tabHint = " · Tab=scroll";
		const footerHint = tracker.workflowDone
			? tracker.workflowError
				? th.fg("error", " failed ")
				: th.fg("success", " complete ")
			: th.fg(
					"dim",
					` Esc=cancel · e=expand${scrollHint}${enterHint}${tabHint} `,
				);
		lines.push(border("╰") + padLine(footerHint, innerWidth) + border("╯"));

		return lines;
	}

	// ── Node list rendering with iteration expansion ──────────

	/** Count total display lines for node list (including expanded iterations) */
	private countNodeLines(nodes: readonly DagNodeInfo[]): number {
		let count = 0;
		for (const node of nodes) {
			count++; // Node line itself
			if (
				node.iterationsExpanded &&
				node.iterations &&
				node.iterations.length > 0
			) {
				count += node.iterations.length; // One line per iteration
			}
		}
		return count;
	}

	/** Render node lines (flat list including expanded iterations), with scroll window */
	private renderNodeList(
		nodes: readonly DagNodeInfo[],
		innerWidth: number,
		maxVisible: number,
	): string[] {
		const th = this.theme;
		const allLines: string[] = [];
		// Track which global line maps to which node index
		const lineNodeIdx: number[] = [];

		for (let ni = 0; ni < nodes.length; ni++) {
			const node = nodes[ni];
			allLines.push(this.renderNodeLine(node, ni, innerWidth));
			lineNodeIdx.push(ni);

			// Expanded iterations
			if (
				node.iterationsExpanded &&
				node.iterations &&
				node.iterations.length > 0
			) {
				for (const iter of node.iterations) {
					allLines.push(this.renderIterationLine(iter, innerWidth, th));
					lineNodeIdx.push(ni);
				}
			}
		}

		// Apply scroll window
		const maxScroll = Math.max(0, allLines.length - maxVisible);
		if (this.scrollOffset > maxScroll) this.scrollOffset = maxScroll;

		const result: string[] = [];
		if (this.scrollOffset > 0) {
			result.push(th.fg("dim", `↑ ${this.scrollOffset} more above`));
		}

		const start = this.scrollOffset;
		const end = Math.min(start + maxVisible, allLines.length);
		for (let i = start; i < end; i++) {
			result.push(allLines[i]);
		}

		if (end < allLines.length) {
			const remaining = allLines.length - end;
			// Replace last line with scroll indicator if needed
			result.push(th.fg("dim", `↓ ${remaining} more below`));
		}

		return result;
	}

	/** Render a single node line */
	private renderNodeLine(
		node: DagNodeInfo,
		nodeIdx: number,
		innerWidth: number,
	): string {
		const th = this.theme;
		const isSelected = nodeIdx === this.selectedNodeIdx;
		const isRunning = node.state === "running";
		const icon = NODE_ICONS[node.state] ?? "○";
		const color = NODE_COLORS[node.state] ?? "dim";

		const name = truncateToWidth(node.id, innerWidth - 14);

		// Status suffix
		let suffix = "";
		if (node.state === "running" && node.startedAt) {
			const nodeElapsed = Math.floor((Date.now() - node.startedAt) / 1000);
			suffix = th.fg("dim", ` ${fmtElapsed(nodeElapsed)}`);
		} else if (node.state === "done" && node.duration) {
			suffix = th.fg("dim", ` ${node.duration}`);
			if (node.costUsd != null) {
				suffix += th.fg("dim", ` · $${node.costUsd.toFixed(4)}`);
			}
			if (node.numTurns != null) {
				suffix += th.fg("dim", ` · ${node.numTurns}t`);
			}
		} else if (node.state === "error" && node.error) {
			const err = truncateToWidth(node.error, innerWidth - 16);
			suffix = th.fg("error", ` ${err}`);
		} else if (node.state === "skipped" && node.skipReason) {
			const reason = node.skipReason.replace(/_/g, " ");
			suffix = th.fg("dim", ` ${reason}`);
		} else if (node.state === "approval" && node.approvalMessage) {
			const msg = truncateToWidth(node.approvalMessage, innerWidth - 16);
			suffix = th.fg("warning", ` ${msg}`);
		}

		// Node type badge
		let typeBadge = "";
		if (node.nodeType) {
			typeBadge = th.fg("muted", ` [${node.nodeType}]`);
		}

		// Iteration badge (with expansion hint)
		let iterBadge = "";
		if (node.currentIteration != null && node.maxIterations != null) {
			const expandHint = node.iterationsExpanded ? "▾" : "▸";
			iterBadge = th.fg(
				"accent",
				` ${expandHint}${node.currentIteration}/${node.maxIterations}`,
			);
		} else if (node.currentIteration != null) {
			iterBadge = th.fg("accent", ` iter ${node.currentIteration}`);
		}

		// Active tool (from structured toolCalls — show the in-flight one)
		let toolBadge = "";
		if (isRunning) {
			const activeTc = node.toolCalls.find((tc) => tc.output === undefined);
			if (activeTc) {
				const tcElapsed = Math.floor((Date.now() - activeTc.startedAt) / 1000);
				toolBadge = th.fg(
					"accent",
					` 🔧${activeTc.name} ${fmtElapsed(tcElapsed)}`,
				);
			} else if (node.activeTool) {
				toolBadge = th.fg("dim", ` 🔧${node.activeTool}`);
			}
		}

		// Provider badge (show when no active tool)
		let providerBadge = "";
		if (isRunning && node.provider && !toolBadge) {
			providerBadge = th.fg("dim", ` via ${node.provider}`);
		}

		// Streaming/output indicator
		let logBadge = "";
		if (node.streamingText) {
			logBadge = th.fg("accent", " ✎"); // streaming in progress
		} else if (node.nodeOutput) {
			logBadge = th.fg("success", " 📋✓");
		} else if (node.logLines.length > 0) {
			logBadge = th.fg("dim", ` 📋${node.logLines.length}`);
		}

		// Tool call count badge
		let tcBadge = "";
		if (node.toolCalls.length > 0) {
			const running = node.toolCalls.filter(
				(tc) => tc.output === undefined,
			).length;
			const done = node.toolCalls.length - running;
			if (running > 0) {
				tcBadge = th.fg("accent", ` ⚡${running}+${done}`);
			} else {
				tcBadge = th.fg("dim", ` ⚡${done}`);
			}
		}

		// Selection marker — accent for running, dim for others
		const selectMarker = isSelected
			? isRunning
				? th.fg("accent", "▸")
				: th.fg("muted", "▸")
			: " ";

		return `${selectMarker}${th.fg(color, icon)} ${name}${typeBadge}${iterBadge}${toolBadge}${providerBadge}${tcBadge}${logBadge}${suffix}`;
	}

	/** Render a single iteration line (indented under the parent node) */
	private renderIterationLine(
		iter: {
			iteration: number;
			state: string;
			duration?: number;
			error?: string;
		},
		_innerWidth: number,
		th: Theme,
	): string {
		const icon = ITER_ICONS[iter.state] ?? "○";
		let color: "accent" | "success" | "error" | "dim" = "dim";
		if (iter.state === "running") color = "accent";
		else if (iter.state === "completed") color = "success";
		else if (iter.state === "failed") color = "error";

		let suffix = "";
		if (iter.duration != null) {
			suffix = th.fg("dim", ` ${fmtElapsed(iter.duration)}`);
		}
		if (iter.error) {
			suffix += th.fg("error", ` ${truncateToWidth(iter.error, 20)}`);
		}

		return `   ${th.fg(color, icon)} iter ${iter.iteration}${suffix}`;
	}

	// ── Output panel rendering (streaming text + tool calls) ─────

	/**
	 * Render the output panel for a node.
	 * This is the key observability surface — shows:
	 * - Streaming AI text (real-time from conversation SSE)
	 * - Tool call cards (structured, with live timers for in-flight tools)
	 * - Tool result cards (with output preview, expandable)
	 * - "Thinking…" placeholder when running but no output
	 * - Full output from API/logLines for completed nodes
	 */
	private renderOutputPanel(
		node: DagNodeInfo,
		innerWidth: number,
		th: Theme,
	): string[] {
		const maxOutVisible = this._expanded ? 10 : 4;
		const lines: string[] = [];

		// Output section header
		const isLive = node.state === "running";
		const outIcon = isLive ? "⟳" : "📋";
		const outLabel = isLive ? "Live Output" : "Output";
		const outName = truncateToWidth(node.id, innerWidth - 20);
		const outHeader = `${outIcon} ${outLabel}: ${outName}`;

		// Add streaming indicator
		if (isLive && node.streamingText) {
			lines.push(th.fg("muted", ` ${outHeader} ✎`));
		} else if (isLive && node.toolCalls.some((tc) => tc.output === undefined)) {
			lines.push(th.fg("muted", ` ${outHeader} 🔧`));
		} else {
			lines.push(th.fg("muted", ` ${outHeader}`));
		}

		// Build the content lines (streaming text + tool calls)
		const contentLines = this.buildOutputContent(node, innerWidth, th);

		// Auto-follow: scroll to bottom
		if (this.outputAutoFollow) {
			const maxOutScroll = Math.max(0, contentLines.length - maxOutVisible);
			this.outputScrollOffset = Math.max(0, maxOutScroll);
		}

		if (contentLines.length === 0) {
			// Empty state — show "Thinking…" or "waiting"
			if (isLive) {
				// Animated "thinking" indicator — the ● pulses via requestRender
				const dotPhase = Math.floor(Date.now() / 500) % 3;
				const dots = ".".repeat(dotPhase + 1);
				lines.push(th.fg("accent", ` ● Thinking${dots}`));
				for (let i = 1; i < maxOutVisible; i++) {
					lines.push("");
				}
			} else {
				lines.push(th.fg("dim", " (no output captured)"));
				for (let i = 1; i < maxOutVisible; i++) {
					lines.push("");
				}
			}
		} else {
			// Scroll indicator top
			if (this.outputScrollOffset > 0) {
				lines.push(th.fg("dim", `↑ ${this.outputScrollOffset} lines above`));
			}

			const maxOutScroll = Math.max(0, contentLines.length - maxOutVisible);
			if (this.outputScrollOffset > maxOutScroll)
				this.outputScrollOffset = maxOutScroll;

			const startIdx = this.outputScrollOffset;
			const endIdx = Math.min(
				startIdx + maxOutVisible - (this.outputScrollOffset > 0 ? 1 : 0),
				contentLines.length,
			);
			const visibleOut = contentLines.slice(startIdx, endIdx);

			for (const line of visibleOut) {
				lines.push(line);
			}

			// Pad remaining
			const usedLines =
				(this.outputScrollOffset > 0 ? 1 : 0) + visibleOut.length;
			const remaining = maxOutVisible - usedLines;
			for (let i = 0; i < remaining; i++) {
				lines.push("");
			}

			// Scroll indicator bottom
			if (this.outputScrollOffset + maxOutVisible < contentLines.length) {
				const moreBelow =
					contentLines.length - this.outputScrollOffset - maxOutVisible;
				lines[lines.length - 1] = th.fg("dim", `↓ ${moreBelow} lines below`);
			}
		}

		return lines;
	}

	/**
	 * Build structured output content for a node.
	 * Merges streaming AI text, tool call cards, system event logs,
	 * and fallback log lines into a unified list of rendered strings.
	 *
	 * Layout:
	 *   1. Primary content (AI text + tool calls, or API output, or logLines)
	 *   2. Separator (if we have both primary content and system events)
	 *   3. System event log (granular CLI stderr events) in dim color
	 */
	private buildOutputContent(
		node: DagNodeInfo,
		innerWidth: number,
		th: Theme,
	): string[] {
		const contentLines: string[] = [];

		// Priority 1: streaming text + tool calls from conversation SSE
		if (node.streamingText || node.toolCalls.length > 0) {
			// Streaming AI text block
			if (node.streamingText) {
				const textLines = this.wrapText(node.streamingText, innerWidth - 4);
				for (const tl of textLines) {
					contentLines.push(th.fg("text", tl));
				}
			}

			// Tool call cards
			for (const tc of node.toolCalls) {
				contentLines.push(...this.renderToolCallCard(tc, innerWidth, th));
			}
		}

		// Priority 2: Full nodeOutput from API (completed node)
		if (contentLines.length === 0 && node.nodeOutput) {
			const outLines = node.nodeOutput.split("\n");
			for (const line of outLines) {
				contentLines.push(this.renderLogLine(line, innerWidth - 4, th));
			}
		}

		// Priority 3: Live-captured logLines (fallback)
		if (contentLines.length === 0 && node.logLines.length > 0) {
			for (const line of node.logLines) {
				contentLines.push(this.renderLogLine(line, innerWidth - 4, th));
			}
		}

		// ALWAYS append system event logs at the end (if any),
		// providing granular per-step activity visible alongside AI output.
		if (node.systemEventLogs && node.systemEventLogs.length > 0) {
			// Add a dim separator if we have primary content above
			if (contentLines.length > 0) {
				contentLines.push(
					th.fg("muted", "─".repeat(Math.min(innerWidth - 6, 32))),
				);
			}
			// Show the last 8 system events (newest at bottom)
			const recentEvents = node.systemEventLogs.slice(-8);
			for (const eventLine of recentEvents) {
				contentLines.push(this.renderLogLine(eventLine, innerWidth - 4, th));
			}
		}

		return contentLines;
	}

	/**
	 * Render a tool call as a structured card.
	 * While in-flight: ▸ ToolName · 3s
	 * On completion:  ▾ ToolName (234ms) [expanded shows output]
	 */
	private renderToolCallCard(
		tc: ToolCallRecord,
		innerWidth: number,
		th: Theme,
	): string[] {
		const lines: string[] = [];
		const isCompleted = tc.output !== undefined;

		if (!isCompleted) {
			// In-flight tool call — show with live elapsed timer
			const elapsed = Math.floor((Date.now() - tc.startedAt) / 1000);
			const elapsedStr = fmtElapsed(elapsed);
			const inputPreview = this.formatToolInput(tc.input, innerWidth - 16);
			lines.push(
				th.fg("accent", `▸ ${tc.name}`) +
					th.fg("dim", ` · ${elapsedStr}`) +
					(inputPreview ? th.fg("dim", ` ${inputPreview}`) : ""),
			);
		} else {
			// Completed tool call — show with duration
			const durStr =
				tc.durationMs != null
					? tc.durationMs > 1000
						? `${Math.round(tc.durationMs / 100) / 10}s`
						: `${tc.durationMs}ms`
					: "";

			if (tc.expanded && tc.output) {
				// Expanded: show header + output
				lines.push(
					th.fg("success", `▾ ${tc.name}`) + th.fg("dim", ` (${durStr})`),
				);
				const outLines = this.wrapText(tc.output, innerWidth - 6);
				for (const ol of outLines.slice(0, 8)) {
					// Max 8 lines preview
					lines.push(th.fg("dim", `  ${ol}`));
				}
				if (outLines.length > 8) {
					lines.push(th.fg("dim", `  … ${outLines.length - 8} more lines`));
				}
			} else {
				// Collapsed: show header with output preview
				const outputPreview =
					tc.output && tc.output.length > 40
						? `${tc.output.slice(0, 40)}…`
						: (tc.output ?? "");
				lines.push(
					th.fg("success", `▸ ${tc.name}`) +
						th.fg("dim", ` (${durStr})`) +
						(outputPreview
							? th.fg(
									"dim",
									` ${truncateToWidth(outputPreview, innerWidth - 20)}`,
								)
							: ""),
				);
			}
		}

		return lines;
	}

	/** Format tool input as a compact preview string */
	private formatToolInput(
		input: Record<string, unknown>,
		maxLen: number,
	): string {
		const keys = Object.keys(input);
		if (keys.length === 0) return "";

		// Show first key's value as preview
		const firstKey = keys[0];
		const val = input[firstKey];
		if (typeof val === "string") {
			const truncated = val.length > maxLen ? `${val.slice(0, maxLen)}…` : val;
			return truncateToWidth(truncated, maxLen);
		}

		// Fallback: JSON preview
		const json = JSON.stringify(input);
		return truncateToWidth(
			json.length > maxLen ? `${json.slice(0, maxLen)}…` : json,
			maxLen,
		);
	}

	/** Wrap text to a max width, preserving word boundaries */
	private wrapText(text: string, maxWidth: number): string[] {
		if (maxWidth <= 0) return [text];

		const rawLines = text.split("\n");
		const result: string[] = [];

		for (const rawLine of rawLines) {
			if (rawLine.length <= maxWidth) {
				result.push(rawLine);
				continue;
			}
			// Simple word-wrap
			let remaining = rawLine;
			while (remaining.length > maxWidth) {
				// Find last space before maxWidth
				let breakAt = maxWidth;
				const lastSpace = remaining.lastIndexOf(" ", maxWidth);
				if (lastSpace > maxWidth * 0.4) {
					breakAt = lastSpace + 1;
				}
				result.push(remaining.slice(0, breakAt));
				remaining = remaining.slice(breakAt);
			}
			if (remaining) result.push(remaining);
		}

		return result;
	}

	/** Render a log line with smart formatting */
	private renderLogLine(line: string, maxWidth: number, th: Theme): string {
		// Color tool call indicators
		if (line.startsWith("⟳") || line.startsWith("↳")) {
			return th.fg("accent", truncateToWidth(line, maxWidth));
		}
		if (line.startsWith("✓")) {
			return th.fg("success", truncateToWidth(line, maxWidth));
		}
		if (line.startsWith("⚠")) {
			return th.fg("error", truncateToWidth(line, maxWidth));
		}

		// Color event log format: [nodeName] Started / Completed / Failed / Skipped
		const eventMatch = line.match(/^\[([^\]]+)\]\s+(Started|Running)/);
		if (eventMatch) {
			return th.fg("accent", truncateToWidth(line, maxWidth));
		}
		const completedMatch = line.match(/^\[([^\]]+)\]\s+(Completed|Skipped)/);
		if (completedMatch) {
			return th.fg("success", truncateToWidth(line, maxWidth));
		}
		const failedMatch = line.match(/^\[([^\]]+)\]\s+Failed/);
		if (failedMatch) {
			return th.fg("error", truncateToWidth(line, maxWidth));
		}
		const approvalMatch = line.match(/^\[([^\]]+)\]\s+Waiting for approval/);
		if (approvalMatch) {
			return th.fg("warning", truncateToWidth(line, maxWidth));
		}

		// Color tool event log format: [tool_started] tool: name (started)
		if (line.match(/^\[tool_started\]/)) {
			return th.fg("accent", truncateToWidth(line, maxWidth));
		}
		if (line.match(/^\[tool_completed\]/)) {
			return th.fg("success", truncateToWidth(line, maxWidth));
		}

		// Dim internal log lines
		if (
			line.startsWith("[INF]") ||
			line.startsWith("[WRN]") ||
			line.startsWith("[ERR]") ||
			line.startsWith("{") ||
			line.startsWith(" at ")
		) {
			return th.fg("dim", truncateToWidth(line, maxWidth));
		}

		return truncateToWidth(line, maxWidth);
	}

	/** Find the first running node */
	private findRunningNode(nodes: readonly DagNodeInfo[]): DagNodeInfo | null {
		return nodes.find((n) => n.state === "running") ?? null;
	}

	private handleProgressInput(data: string): boolean {
		// ESC = cancel
		if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
			this.onCancel?.();
			return true;
		}

		// 'e' = toggle expand
		if (data === "e") {
			this._expanded = !this._expanded;
			return true;
		}

		// Tab = toggle auto-follow in output panel
		if (data === "\t") {
			this.outputAutoFollow = !this.outputAutoFollow;
			return true;
		}

		// 'i' = toggle iteration expansion for selected node
		if (data === "i") {
			const nodes = this.tracker.nodes;
			if (nodes.length > 0 && this.selectedNodeIdx < nodes.length) {
				const node = nodes[this.selectedNodeIdx];
				if (node.iterations && node.iterations.length > 0) {
					this.tracker.toggleIterationsExpanded(node.id);
					return true;
				}
			}
			return false;
		}

		// 'x' = expand/collapse tool call output for selected node's last completed tool
		if (data === "x") {
			const nodes = this.tracker.nodes;
			if (nodes.length > 0 && this.selectedNodeIdx < nodes.length) {
				const node = nodes[this.selectedNodeIdx];
				// Find last completed tool call and toggle its expansion
				for (let i = node.toolCalls.length - 1; i >= 0; i--) {
					if (node.toolCalls[i].output !== undefined) {
						this.tracker.toggleToolCallExpanded(node.id, i);
						return true;
					}
				}
			}
			return false;
		}

		const nodes = this.tracker.nodes;

		// Enter = inspect selected node's logs
		if (matchesKey(data, Key.enter) || matchesKey(data, Key.space)) {
			if (nodes.length > 0 && this.selectedNodeIdx < nodes.length) {
				const node = nodes[this.selectedNodeIdx];
				if (
					node.nodeOutput ||
					node.streamingText ||
					node.logLines.length > 0 ||
					node.toolCalls.length > 0 ||
					node.state === "running" ||
					node.state === "done" ||
					node.state === "error"
				) {
					this.inspectedNode = node;
					this.view = "logs";
					this.logScrollOffset = 0;
					return true;
				}
			}
			return false;
		}

		// ↑ = move selection up
		if (matchesKey(data, Key.up)) {
			if (this.selectedNodeIdx > 0) {
				this.selectedNodeIdx--;
				this.outputAutoFollow = true;
				this.outputScrollOffset = 0;
				if (this.selectedNodeIdx < this.scrollOffset) {
					this.scrollOffset = this.selectedNodeIdx;
				}
			}
			return true;
		}

		// ↓ = move selection down
		if (matchesKey(data, Key.down)) {
			if (this.selectedNodeIdx < nodes.length - 1) {
				this.selectedNodeIdx++;
				this.outputAutoFollow = true;
				this.outputScrollOffset = 0;
				const maxVisible = this._expanded ? 12 : 5;
				if (this.selectedNodeIdx >= this.scrollOffset + maxVisible) {
					this.scrollOffset = this.selectedNodeIdx - maxVisible + 1;
				}
			}
			return true;
		}

		// Page Up
		if (matchesKey(data, "pageUp")) {
			this.selectedNodeIdx = Math.max(0, this.selectedNodeIdx - 5);
			if (this.selectedNodeIdx < this.scrollOffset) {
				this.scrollOffset = this.selectedNodeIdx;
			}
			return true;
		}

		// Page Down
		if (matchesKey(data, "pageDown")) {
			this.selectedNodeIdx = Math.min(
				nodes.length - 1,
				this.selectedNodeIdx + 5,
			);
			const maxVisible = this._expanded ? 12 : 5;
			if (this.selectedNodeIdx >= this.scrollOffset + maxVisible) {
				this.scrollOffset = this.selectedNodeIdx - maxVisible + 1;
			}
			return true;
		}

		return false;
	}

	// ── Log inspector view (full-screen for one node) ──────────

	private renderLogs(width: number, height?: number): string[] {
		const w = Math.max(width, 52);
		const th = this.theme;
		const node = this.inspectedNode!;
		const innerWidth = w - 2;
		const lines: string[] = [];
		const bl = "│";
		const border = (s: string) => th.fg("border", s);

		// ── Header ───────────────────────────────────────────
		const icon = NODE_ICONS[node.state] ?? "○";
		const color = NODE_COLORS[node.state] ?? "dim";
		const typeTag = node.nodeType ? ` [${node.nodeType}]` : "";
		const headerText = `${th.fg(color, icon)} ${th.bold(node.id)}${th.fg("muted", typeTag)}`;

		lines.push(border("╭") + border("─".repeat(innerWidth)) + border("╮"));
		lines.push(border(bl) + padLine(` ${headerText}`, innerWidth) + border(bl));

		// ── Status line ──────────────────────────────────────
		let statusLine = "";
		if (node.state === "running" && node.startedAt) {
			const elapsed = fmtElapsed(
				Math.floor((Date.now() - node.startedAt) / 1000),
			);
			statusLine = `${th.fg("accent", "running")} ${elapsed}`;
			// Show active tool call
			const activeTc = node.toolCalls.find((tc) => tc.output === undefined);
			if (activeTc) {
				const tcElapsed = fmtElapsed(
					Math.floor((Date.now() - activeTc.startedAt) / 1000),
				);
				statusLine += th.fg("accent", ` → ${activeTc.name} ${tcElapsed}`);
			} else if (node.activeTool) {
				statusLine += th.fg("dim", ` → ${node.activeTool}`);
			}
			if (node.provider) {
				statusLine += th.fg("dim", ` via ${node.provider}`);
			}
		} else if (node.state === "done") {
			statusLine = `${th.fg("success", "completed")}${node.duration ? th.fg("dim", ` ${node.duration}`) : ""}`;
			if (node.costUsd != null) {
				statusLine += th.fg("dim", ` · $${node.costUsd.toFixed(4)}`);
			}
			if (node.numTurns != null) {
				statusLine += th.fg("dim", ` · ${node.numTurns} turn(s)`);
			}
			// Show tool call count
			if (node.toolCalls.length > 0) {
				statusLine += th.fg("dim", ` · ${node.toolCalls.length} tool(s)`);
			}
		} else if (node.state === "error") {
			statusLine = `${th.fg("error", "failed")}${node.error ? `: ${truncateToWidth(node.error, innerWidth - 16)}` : ""}`;
		} else if (node.state === "skipped") {
			statusLine = `${th.fg("warning", "skipped")}${node.skipReason ? `: ${node.skipReason.replace(/_/g, " ")}` : ""}`;
		} else if (node.state === "approval") {
			statusLine = `${th.fg("warning", "awaiting approval")}${node.approvalMessage ? `: ${truncateToWidth(node.approvalMessage, innerWidth - 30)}` : ""}`;
		}

		if (statusLine) {
			lines.push(
				border(bl) + padLine(` ${statusLine}`, innerWidth) + border(bl),
			);
		}

		// ── Separator ────────────────────────────────────────
		lines.push(border(bl) + border("├" + "─".repeat(innerWidth - 1) + "┤"));

		// ── Log lines — structured output with tool calls ──
		// Build unified content: streaming text + tool call cards + fallback + system events
		const contentLines: string[] = [];

		if (node.streamingText || node.toolCalls.length > 0) {
			// Structured view: streaming text + tool call cards
			if (node.streamingText) {
				const textLines = this.wrapText(node.streamingText, innerWidth - 4);
				for (const tl of textLines) {
					contentLines.push(th.fg("text", tl));
				}
			}

			for (const tc of node.toolCalls) {
				contentLines.push(...this.renderToolCallCard(tc, innerWidth, th));
			}
		} else if (node.nodeOutput) {
			// API output
			const outLines = node.nodeOutput.split("\n");
			for (const line of outLines) {
				contentLines.push(this.renderLogLine(line, innerWidth - 4, th));
			}
		} else {
			// Fallback log lines
			for (const line of node.logLines) {
				contentLines.push(this.renderLogLine(line, innerWidth - 4, th));
			}
		}

		// Append system event logs at the end (granular CLI stderr events)
		if (node.systemEventLogs && node.systemEventLogs.length > 0) {
			if (contentLines.length > 0) {
				contentLines.push(
					th.fg("muted", "─".repeat(Math.min(innerWidth - 6, 32))),
				);
			}
			// Show all system events in log inspector (full view, no truncation)
			for (const eventLine of node.systemEventLogs) {
				contentLines.push(this.renderLogLine(eventLine, innerWidth - 4, th));
			}
		}

		const maxLogVisible = height ? Math.max(height - 6, 5) : 15;
		const maxLogScroll = Math.max(0, contentLines.length - maxLogVisible);
		if (this.logScrollOffset > maxLogScroll)
			this.logScrollOffset = maxLogScroll;
		if (this.logScrollOffset < 0) this.logScrollOffset = 0;

		if (contentLines.length === 0) {
			const emptyMsg =
				node.state === "running"
					? th.fg("accent", " ● Thinking…")
					: th.fg("dim", " (no log output captured)");
			lines.push(border(bl) + padLine(emptyMsg, innerWidth) + border(bl));
			for (let i = 1; i < maxLogVisible; i++) {
				lines.push(border(bl) + " ".repeat(innerWidth) + border(bl));
			}
		} else {
			if (this.logScrollOffset > 0) {
				lines.push(
					border(bl) +
						padLine(
							th.fg("dim", ` ↑ ${this.logScrollOffset} lines above`),
							innerWidth,
						) +
						border(bl),
				);
			}

			const visibleLogs = contentLines.slice(
				this.logScrollOffset,
				this.logScrollOffset +
					maxLogVisible -
					(this.logScrollOffset > 0 ? 1 : 0),
			);
			for (const logLine of visibleLogs) {
				lines.push(
					border(bl) + padLine(` ${logLine}`, innerWidth) + border(bl),
				);
			}

			// Pad remaining space
			const usedLines = (this.logScrollOffset > 0 ? 1 : 0) + visibleLogs.length;
			const remaining = maxLogVisible - usedLines;
			for (let i = 0; i < remaining; i++) {
				lines.push(border(bl) + " ".repeat(innerWidth) + border(bl));
			}

			if (this.logScrollOffset + maxLogVisible < contentLines.length) {
				const moreBelow =
					contentLines.length - this.logScrollOffset - maxLogVisible;
				lines[lines.length - 1] =
					border(bl) +
					padLine(th.fg("dim", ` ↓ ${moreBelow} lines below`), innerWidth) +
					border(bl);
			}
		}

		// ── Footer ───────────────────────────────────────────
		const lineInfo = `${this.logScrollOffset + 1}-${Math.min(this.logScrollOffset + maxLogVisible, Math.max(contentLines.length, 1))}/${contentLines.length}`;
		const footerHint = th.fg(
			"dim",
			` Esc=back · ↑/↓ scroll · x=expand tool · ${lineInfo} `,
		);
		lines.push(border("╰") + padLine(footerHint, innerWidth) + border("╯"));

		return lines;
	}

	private handleLogsInput(data: string): boolean {
		// Esc = back to progress view
		if (matchesKey(data, Key.escape)) {
			this.view = "progress";
			this.inspectedNode = null;
			this.logScrollOffset = 0;
			return true;
		}

		// x = expand/collapse last completed tool call
		if (data === "x") {
			if (this.inspectedNode) {
				for (let i = this.inspectedNode.toolCalls.length - 1; i >= 0; i--) {
					if (this.inspectedNode.toolCalls[i].output !== undefined) {
						this.tracker.toggleToolCallExpanded(this.inspectedNode.id, i);
						return true;
					}
				}
			}
			return false;
		}

		// ↑ = scroll up
		if (matchesKey(data, Key.up)) {
			if (this.logScrollOffset > 0) {
				this.logScrollOffset--;
			}
			return true;
		}

		// ↓ = scroll down
		if (matchesKey(data, Key.down)) {
			this.logScrollOffset++;
			return true;
		}

		// Page Up
		if (matchesKey(data, "pageUp")) {
			this.logScrollOffset = Math.max(0, this.logScrollOffset - 10);
			return true;
		}

		// Page Down
		if (matchesKey(data, "pageDown")) {
			this.logScrollOffset += 10;
			return true;
		}

		// Home = jump to top
		if (matchesKey(data, "home")) {
			this.logScrollOffset = 0;
			return true;
		}

		// End = jump to bottom
		if (matchesKey(data, "end")) {
			this.logScrollOffset = 99999; // Will be clamped in render
			return true;
		}

		return false;
	}
}

// ── Shared helpers ───────────────────────────────────────────

export function padLine(text: string, width: number): string {
	const pad = Math.max(0, width - visibleWidth(text));
	return text + " ".repeat(pad);
}

export function fmtElapsed(seconds: number): string {
	if (seconds < 0) return "0s";
	if (seconds < 60) return `${seconds}s`;
	const m = Math.floor(seconds / 60);
	const s = seconds % 60;
	return s > 0 ? `${m}m${s}s` : `${m}m`;
}
