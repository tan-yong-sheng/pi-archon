/**
 * WorkflowOverlay — non-capturing overlay popup with live DAG progress
 * and streaming node output.
 *
 * Three-section layout (matching Archon Web UI's execution page):
 * ┌──────────────────────────────────────────┐
 * │ Header: status icon + name + elapsed     │
 * ├──────────────────────────────────────────┤
 * │ Node list: state icons + names + details │
 * │   (scrollable, selected node highlighted)│
 * ├──────────────────────────────────────────┤
 * │ Output panel: live streaming output from │
 * │   the selected/running node — AI text,   │
 * │   tool calls, tool results, errors       │
 * │   (scrollable, auto-follows latest)      │
 * ├──────────────────────────────────────────┤
 * │ Footer: keybindings + status             │
 * └──────────────────────────────────────────┘
 *
 * Views:
 *   Progress view (default): node list + output panel for running node
 *   Log inspector view (Enter on a node): full-screen log for that node
 *
 * Data sources:
 *   - DagProgressTracker: node state, duration, active tool, logLines
 *   - SSE conversation stream → tracker.appendLogLine (live AI text + tools)
 *   - Archon API → tracker.setNodeOutput (full completed output)
 */

import type { Component, Theme, OverlayHandle } from "@mariozechner/pi-tui";
import {
	truncateToWidth,
	visibleWidth,
	matchesKey,
	Key,
} from "@mariozechner/pi-tui";
import type { DagProgressTracker } from "../dag-tracker";
import type { DagNodeInfo, DagNodeState } from "../types";

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
	private readonly onResize?: (handle: OverlayHandle, width: number) => void;
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

	// Overlay handle
	private overlayHandle?: OverlayHandle;

	constructor(opts: WorkflowOverlayOptions, theme: Theme) {
		this.workflowName = opts.workflowName;
		this.queryPreview = opts.queryPreview;
		this.tracker = opts.dagTracker;
		this.onCancel = opts.onCancel;
		this.onResize = opts.onResize;
		this.overlayHandle = opts.overlayHandle;
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

	setOverlayHandle(handle: OverlayHandle): void {
		this.overlayHandle = handle;
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
		const w = Math.max(width, 40);
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
		lines.push(
			border(bl) +
				border("├" + "─".repeat(innerWidth - 1) + "┤"),
		);

		const nodes = tracker.nodes;
		const maxNodeVisible = this._expanded ? 10 : 4;
		const maxScroll = Math.max(0, nodes.length - maxNodeVisible);
		if (this.scrollOffset > maxScroll) this.scrollOffset = maxScroll;
		if (this.scrollOffset < 0) this.scrollOffset = 0;
		if (nodes.length > 0) {
			this.selectedNodeIdx = Math.min(
				this.selectedNodeIdx,
				nodes.length - 1,
			);
		}

		const visible = nodes.slice(
			this.scrollOffset,
			this.scrollOffset + maxNodeVisible,
		);

		if (this.scrollOffset > 0) {
			lines.push(
				border(bl) +
					padLine(
						th.fg("dim", ` ↑ ${this.scrollOffset} more above`),
						innerWidth,
					) +
					border(bl),
			);
		}

		for (let vi = 0; vi < visible.length; vi++) {
			const node = visible[vi];
			const globalIdx = this.scrollOffset + vi;
			const isSelected = globalIdx === this.selectedNodeIdx;
			lines.push(
				border(bl) +
					padLine(
						` ${this.renderNodeLine(node, isSelected, innerWidth)}`,
						innerWidth,
					) +
					border(bl),
			);
		}

		if (nodes.length > this.scrollOffset + maxNodeVisible) {
			const remaining =
				nodes.length - this.scrollOffset - maxNodeVisible;
			lines.push(
				border(bl) +
					padLine(th.fg("dim", ` ↓ ${remaining} more below`), innerWidth) +
					border(bl),
			);
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
		const outputNode =
			nodes.length > 0 ? nodes[this.selectedNodeIdx] : null;
		const runningNode = this.findRunningNode(nodes);

		// Prefer the selected node, but if it's the running node, show live output
		const displayNode =
			outputNode?.state === "running" ? outputNode : runningNode ?? outputNode;

		lines.push(
			border(bl) +
				border("├" + "─".repeat(innerWidth - 1) + "┤"),
		);

		if (displayNode) {
			// Output section header
			const outIcon = displayNode.state === "running" ? "⟳" : "📋";
			const outLabel =
				displayNode.state === "running" ? "Live Output" : "Output";
			const outName = truncateToWidth(displayNode.id, innerWidth - 20);
			const outHeader = `${outIcon} ${outLabel}: ${outName}`;
			lines.push(
				border(bl) +
					padLine(th.fg("muted", ` ${outHeader}`), innerWidth) +
					border(bl),
			);

			// Get output lines — prefer nodeOutput (API) then logLines (live)
			let outLines: string[];
			if (displayNode.nodeOutput) {
				outLines = displayNode.nodeOutput.split("\n");
			} else {
				outLines = displayNode.logLines;
			}

			const maxOutVisible = this._expanded ? 10 : 4;

			// Auto-follow: scroll to bottom when new lines arrive
			if (this.outputAutoFollow) {
				const maxOutScroll = Math.max(0, outLines.length - maxOutVisible);
				this.outputScrollOffset = maxOutScroll;
			}

			const maxOutScroll = Math.max(0, outLines.length - maxOutVisible);
			if (this.outputScrollOffset > maxOutScroll)
				this.outputScrollOffset = maxOutScroll;
			if (this.outputScrollOffset < 0) this.outputScrollOffset = 0;

			if (outLines.length === 0) {
				const emptyMsg =
					displayNode.state === "running"
						? th.fg("dim", " (waiting for output…)")
						: th.fg("dim", " (no output captured)");
				for (let i = 0; i < maxOutVisible; i++) {
					lines.push(
						border(bl) +
							padLine(i === 0 ? emptyMsg : "", innerWidth) +
							border(bl),
					);
				}
			} else {
				// Scroll indicator top
				if (this.outputScrollOffset > 0) {
					lines.push(
						border(bl) +
							padLine(
								th.fg("dim", ` ↑ ${this.outputScrollOffset} lines above`),
								innerWidth,
							) +
							border(bl),
					);
				}

				const visibleOut = outLines.slice(
					this.outputScrollOffset,
					this.outputScrollOffset + maxOutVisible - (this.outputScrollOffset > 0 ? 1 : 0),
				);

				for (const logLine of visibleOut) {
					const rendered = this.renderLogLine(logLine, innerWidth - 2);
					lines.push(
						border(bl) +
							padLine(` ${rendered}`, innerWidth) +
							border(bl),
					);
				}

				// Pad remaining
				const usedLines =
					(this.outputScrollOffset > 0 ? 1 : 0) + visibleOut.length;
				const remaining = maxOutVisible - usedLines;
				for (let i = 0; i < remaining; i++) {
					lines.push(
						border(bl) + " ".repeat(innerWidth) + border(bl),
					);
				}

				// Scroll indicator bottom
				if (
					this.outputScrollOffset + maxOutVisible <
					outLines.length
				) {
					const moreBelow =
						outLines.length - this.outputScrollOffset - maxOutVisible;
					lines[lines.length - 1] =
						border(bl) +
						padLine(
							th.fg("dim", ` ↓ ${moreBelow} lines below`),
							innerWidth,
						) +
						border(bl);
				}
			}
		} else {
			lines.push(
				border(bl) +
					padLine(th.fg("dim", " (no output yet)"), innerWidth) +
					border(bl),
			);
			for (let i = 0; i < 3; i++) {
				lines.push(
					border(bl) + " ".repeat(innerWidth) + border(bl),
				);
			}
		}

		// ── Footer ───────────────────────────────────────────
		const scrollHint =
			nodes.length > maxNodeVisible ? " · ↑/↓ nodes" : "";
		const enterHint = nodes.length > 0 ? " · Enter=logs" : "";
		const tabHint = " · Tab=output";
		const footerHint = tracker.workflowDone
			? tracker.workflowError
				? th.fg("error", " failed ")
				: th.fg("success", " complete ")
			: th.fg(
					"dim",
					` Esc=cancel · e=expand${scrollHint}${enterHint}${tabHint} `,
				);
		lines.push(
			border("╰") + padLine(footerHint, innerWidth) + border("╯"),
		);

		return lines;
	}

	/** Render a single node line (icon + name + badges + suffix) */
	private renderNodeLine(
		node: DagNodeInfo,
		isSelected: boolean,
		innerWidth: number,
	): string {
		const th = this.theme;
		const icon = NODE_ICONS[node.state] ?? "○";
		const color = NODE_COLORS[node.state] ?? "dim";
		const name = truncateToWidth(node.id, innerWidth - 14);

		let suffix = "";
		if (node.state === "running" && node.startedAt) {
			const nodeElapsed = Math.floor(
				(Date.now() - node.startedAt) / 1000,
			);
			suffix = th.fg("dim", ` ${fmtElapsed(nodeElapsed)}`);
		} else if (node.state === "done" && node.duration) {
			suffix = th.fg("dim", ` ${node.duration}`);
		} else if (node.state === "error" && node.error) {
			const err = truncateToWidth(node.error, innerWidth - 16);
			suffix = th.fg("error", ` ${err}`);
		} else if (node.state === "skipped" && node.skipReason) {
			suffix = th.fg("dim", ` ${node.skipReason}`);
		} else if (node.state === "approval" && node.approvalMessage) {
			const msg = truncateToWidth(
				node.approvalMessage,
				innerWidth - 16,
			);
			suffix = th.fg("warning", ` ${msg}`);
		}

		// Node type badge
		let typeBadge = "";
		if (node.nodeType) {
			typeBadge = th.fg("muted", ` [${node.nodeType}]`);
		}

		// Iteration badge
		let iterBadge = "";
		if (node.currentIteration != null && node.maxIterations != null) {
			iterBadge = th.fg(
				"accent",
				` ${node.currentIteration}/${node.maxIterations}`,
			);
		} else if (node.currentIteration != null) {
			iterBadge = th.fg("accent", ` iter ${node.currentIteration}`);
		}

		// Active tool
		let toolBadge = "";
		if (node.state === "running" && node.activeTool) {
			toolBadge = th.fg("dim", ` 🔧${node.activeTool}`);
		}

		// Provider badge
		let providerBadge = "";
		if (node.state === "running" && node.provider && !node.activeTool) {
			providerBadge = th.fg("dim", ` via ${node.provider}`);
		}

		// Log/output indicator
		let logBadge = "";
		if (node.nodeOutput) {
			logBadge = th.fg("success", " 📋✓");
		} else if (node.logLines.length > 0) {
			logBadge = th.fg("dim", ` 📋${node.logLines.length}`);
		}

		const selectMarker = isSelected ? th.fg("accent", "▸") : " ";

		return `${selectMarker}${th.fg(color, icon)} ${name}${typeBadge}${iterBadge}${toolBadge}${providerBadge}${logBadge}${suffix}`;
	}

	/** Render a log line with smart formatting */
	private renderLogLine(line: string, maxWidth: number): string {
		const th = this.theme;
		const rendered = line;

		// Color tool call indicators
		if (rendered.startsWith("⟳")) {
			// Active tool call — accent
			return th.fg("accent", truncateToWidth(rendered, maxWidth));
		}
		if (rendered.startsWith("✓")) {
			// Tool result — success
			return th.fg("success", truncateToWidth(rendered, maxWidth));
		}
		if (rendered.startsWith("⚠")) {
			// Error — error color
			return th.fg("error", truncateToWidth(rendered, maxWidth));
		}

		// Dim internal log lines
		if (
			rendered.startsWith("[INF]") ||
			rendered.startsWith("[WRN]") ||
			rendered.startsWith("[ERR]") ||
			rendered.startsWith("{") ||
			rendered.startsWith(" at ")
		) {
			return th.fg("dim", truncateToWidth(rendered, maxWidth));
		}

		return truncateToWidth(rendered, maxWidth);
	}

	/** Find the first running node */
	private findRunningNode(nodes: readonly DagNodeInfo[]): DagNodeInfo | null {
		return nodes.find((n) => n.state === "running") ?? null;
	}

	private handleProgressInput(data: string): boolean {
		// ESC = cancel
		if (
			matchesKey(data, Key.escape) ||
			matchesKey(data, Key.ctrl("c"))
		) {
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

		const nodes = this.tracker.nodes;

		// Enter = inspect selected node's logs
		if (matchesKey(data, Key.enter) || matchesKey(data, Key.space)) {
			if (nodes.length > 0 && this.selectedNodeIdx < nodes.length) {
				const node = nodes[this.selectedNodeIdx];
				if (
					node.nodeOutput ||
					node.logLines.length > 0 ||
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
				const maxVisible = this._expanded ? 10 : 4;
				if (this.selectedNodeIdx >= this.scrollOffset + maxVisible) {
					this.scrollOffset =
						this.selectedNodeIdx - maxVisible + 1;
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
			const maxVisible = this._expanded ? 10 : 4;
			if (this.selectedNodeIdx >= this.scrollOffset + maxVisible) {
				this.scrollOffset =
					this.selectedNodeIdx - maxVisible + 1;
			}
			return true;
		}

		return false;
	}

	// ── Log inspector view (full-screen for one node) ──────────

	private renderLogs(width: number, height?: number): string[] {
		const w = Math.max(width, 44);
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
		lines.push(
			border(bl) +
				padLine(` ${headerText}`, innerWidth) +
				border(bl),
		);

		// ── Status line ──────────────────────────────────────
		let statusLine = "";
		if (node.state === "running" && node.startedAt) {
			const elapsed = fmtElapsed(
				Math.floor((Date.now() - node.startedAt) / 1000),
			);
			statusLine = `${th.fg("accent", "running")} ${elapsed}`;
			if (node.activeTool) {
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
		} else if (node.state === "error") {
			statusLine = `${th.fg("error", "failed")}${node.error ? `: ${truncateToWidth(node.error, innerWidth - 16)}` : ""}`;
		} else if (node.state === "skipped") {
			statusLine = `${th.fg("warning", "skipped")}${node.skipReason ? `: ${node.skipReason}` : ""}`;
		} else if (node.state === "approval") {
			statusLine = `${th.fg("warning", "awaiting approval")}${node.approvalMessage ? `: ${truncateToWidth(node.approvalMessage, innerWidth - 30)}` : ""}`;
		}

		if (statusLine) {
			lines.push(
				border(bl) +
					padLine(` ${statusLine}`, innerWidth) +
					border(bl),
			);
		}

		// ── Separator ────────────────────────────────────────
		lines.push(
			border(bl) +
				border("├" + "─".repeat(innerWidth - 1) + "┤"),
		);

		// ── Log lines — prefer nodeOutput (API) over logLines (stderr) ──
		let logLines: string[];
		if (node.nodeOutput) {
			logLines = node.nodeOutput.split("\n");
		} else {
			logLines = node.logLines;
		}

		const maxLogVisible = height ? Math.max(height - 6, 5) : 10;
		const maxLogScroll = Math.max(0, logLines.length - maxLogVisible);
		if (this.logScrollOffset > maxLogScroll)
			this.logScrollOffset = maxLogScroll;
		if (this.logScrollOffset < 0) this.logScrollOffset = 0;

		if (logLines.length === 0) {
			const emptyMsg =
				node.state === "running"
					? th.fg("dim", " (waiting for output…)")
					: th.fg("dim", " (no log output captured)");
			lines.push(
				border(bl) + padLine(emptyMsg, innerWidth) + border(bl),
			);
			for (let i = 1; i < maxLogVisible; i++) {
				lines.push(
					border(bl) + " ".repeat(innerWidth) + border(bl),
				);
			}
		} else {
			if (this.logScrollOffset > 0) {
				lines.push(
					border(bl) +
						padLine(
							th.fg(
								"dim",
								` ↑ ${this.logScrollOffset} lines above`,
							),
							innerWidth,
						) +
						border(bl),
				);
			}

			const visibleLogs = logLines.slice(
				this.logScrollOffset,
				this.logScrollOffset +
					maxLogVisible -
					(this.logScrollOffset > 0 ? 1 : 0),
			);

			for (const logLine of visibleLogs) {
				const rendered = this.renderLogLine(logLine, innerWidth - 2);
				lines.push(
					border(bl) +
						padLine(` ${rendered}`, innerWidth) +
						border(bl),
				);
			}

			// Pad remaining space
			const usedLines =
				(this.logScrollOffset > 0 ? 1 : 0) + visibleLogs.length;
			const remaining = maxLogVisible - usedLines;
			for (let i = 0; i < remaining; i++) {
				lines.push(
					border(bl) + " ".repeat(innerWidth) + border(bl),
				);
			}

			if (this.logScrollOffset + maxLogVisible < logLines.length) {
				const moreBelow =
					logLines.length - this.logScrollOffset - maxLogVisible;
				lines[lines.length - 1] =
					border(bl) +
					padLine(
						th.fg("dim", ` ↓ ${moreBelow} lines below`),
						innerWidth,
					) +
					border(bl);
			}
		}

		// ── Footer ───────────────────────────────────────────
		const lineInfo = `${this.logScrollOffset + 1}-${Math.min(this.logScrollOffset + maxLogVisible, Math.max(logLines.length, 1))}/${logLines.length}`;
		const footerHint = th.fg(
			"dim",
			` Esc=back · ↑/↓ scroll · ${lineInfo} `,
		);
		lines.push(
			border("╰") + padLine(footerHint, innerWidth) + border("╯"),
		);

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
			const logLines = this.inspectedNode?.logLines ?? [];
			this.logScrollOffset = Math.max(0, logLines.length - 10);
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
	if (seconds < 60) return `${seconds}s`;
	const m = Math.floor(seconds / 60);
	const s = seconds % 60;
	return s > 0 ? `${m}m${s}s` : `${m}m`;
}
