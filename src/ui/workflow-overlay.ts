/**
 * WorkflowOverlay — non-capturing overlay popup with live DAG progress
 * and node log inspector.
 *
 * Two views:
 *   Progress view (default): compact node list with state icons,
 *     scroll via ↑/↓, Enter to inspect a node's logs
 *   Log inspector view: shows the selected node's captured output
 *     lines with scrolling, Esc to go back
 *
 * Anchored top-right as a nonCapturing overlay that floats over the
 * terminal while the user continues working.
 *
 * This component is created inside a ctx.ui.custom() callback and
 * attached to the screen via tui.showOverlay(component, { nonCapturing: true }).
 * The TUI system calls render() each frame; we call tui.requestRender()
 * after updating tracker state.
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
	/** Called when overlay wants to resize (e.g., entering log view) */
	onResize?: (handle: OverlayHandle, width: number) => void;
	/** Overlay handle for resizing */
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

	// Overlay handle for resizing
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
	/** Reset start time when reused. */
	reset(): void {
		this.startedAt = Date.now();
		this.scrollOffset = 0;
		this.selectedNodeIdx = 0;
		this.view = "progress";
		this.inspectedNode = null;
		this.logScrollOffset = 0;
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

	// ── Progress view ─────────────────────────────────────────
	private renderProgress(width: number, _height?: number): string[] {
		const w = Math.max(width, 24);
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

		// ── Header ───────────────────────────────────────────
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

		// ── Query preview (truncated) ────────────────────────
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

		// ── Separator ────────────────────────────────────────
		lines.push(border(bl) + border("├" + "─".repeat(innerWidth - 1) + "┤"));

		// ── Node list with scroll + selection ────────────────
		const nodes = tracker.nodes;
		const maxVisible = this._expanded ? 12 : 5;

		// Clamp scroll and selection
		const maxScroll = Math.max(0, nodes.length - maxVisible);
		if (this.scrollOffset > maxScroll) this.scrollOffset = maxScroll;
		if (this.scrollOffset < 0) this.scrollOffset = 0;
		if (nodes.length > 0) {
			this.selectedNodeIdx = Math.min(this.selectedNodeIdx, nodes.length - 1);
		}

		const visible = nodes.slice(
			this.scrollOffset,
			this.scrollOffset + maxVisible,
		);

		// Scroll indicator if scrolled
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

			const icon = NODE_ICONS[node.state] ?? "○";
			const color = NODE_COLORS[node.state] ?? "dim";
			const name = truncateToWidth(node.id, innerWidth - 14);

			let suffix = "";
			if (node.state === "running" && node.startedAt) {
				const nodeElapsed = Math.floor((Date.now() - node.startedAt) / 1000);
				suffix = th.fg("dim", ` ${fmtElapsed(nodeElapsed)}`);
			} else if (node.state === "done" && node.duration) {
				suffix = th.fg("dim", ` ${node.duration}`);
			} else if (node.state === "error" && node.error) {
				const err = truncateToWidth(node.error, innerWidth - 16);
				suffix = th.fg("error", ` ${err}`);
			} else if (node.state === "skipped" && node.skipReason) {
				suffix = th.fg("dim", ` ${node.skipReason}`);
			} else if (node.state === "approval" && node.approvalMessage) {
				const msg = truncateToWidth(node.approvalMessage, innerWidth - 16);
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

			// Provider badge for running AI nodes
			let providerBadge = "";
			if (node.state === "running" && node.provider && !node.activeTool) {
				providerBadge = th.fg("dim", ` via ${node.provider}`);
			}

			// Log count indicator
			let logBadge = "";
			if (node.logLines.length > 0) {
				logBadge = th.fg("dim", ` 📋${node.logLines.length}`);
			}

			const selectMarker = isSelected ? th.fg("accent", "▸") : " ";
			const line = `${selectMarker}${th.fg(color, icon)} ${name}${typeBadge}${iterBadge}${toolBadge}${providerBadge}${logBadge}${suffix}`;

			// Highlight selected row
			if (isSelected) {
				lines.push(border(bl) + padLine(` ${line}`, innerWidth) + border(bl));
			} else {
				lines.push(border(bl) + padLine(` ${line}`, innerWidth) + border(bl));
			}
		}

		if (nodes.length > this.scrollOffset + maxVisible) {
			const remaining = nodes.length - this.scrollOffset - maxVisible;
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

		// ── Footer ───────────────────────────────────────────
		const scrollHint = nodes.length > maxVisible ? " · ↑/↓ scroll" : "";
		const enterHint = nodes.length > 0 ? " · Enter=logs" : "";
		const footerHint = tracker.workflowDone
			? tracker.workflowError
				? th.fg("error", " failed ")
				: th.fg("success", " complete ")
			: th.fg("dim", ` Esc=cancel · e=expand${scrollHint}${enterHint} `);
		lines.push(border("╰") + padLine(footerHint, innerWidth) + border("╯"));

		return lines;
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

		const nodes = this.tracker.nodes;

		// Enter = inspect selected node's logs
		if (matchesKey(data, Key.enter) || matchesKey(data, Key.space)) {
			if (nodes.length > 0 && this.selectedNodeIdx < nodes.length) {
				const node = nodes[this.selectedNodeIdx];
				if (
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
				// Adjust scroll to keep selected item visible
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

	// ── Log inspector view ────────────────────────────────────
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
		lines.push(border(bl) + padLine(` ${headerText}`, innerWidth) + border(bl));

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
				border(bl) + padLine(` ${statusLine}`, innerWidth) + border(bl),
			);
		}

		// ── Separator ────────────────────────────────────────
		lines.push(border(bl) + border("├" + "─".repeat(innerWidth - 1) + "┤"));

		// ── Log lines ────────────────────────────────────────
		const logLines = node.logLines;
		const maxLogVisible = height ? Math.max(height - 6, 5) : 10;

		// Clamp log scroll
		const maxLogScroll = Math.max(0, logLines.length - maxLogVisible);
		if (this.logScrollOffset > maxLogScroll)
			this.logScrollOffset = maxLogScroll;
		if (this.logScrollOffset < 0) this.logScrollOffset = 0;

		if (logLines.length === 0) {
			// Empty log
			const emptyMsg =
				node.state === "running"
					? th.fg("dim", " (waiting for output…)")
					: th.fg("dim", " (no log output captured)");
			lines.push(border(bl) + padLine(emptyMsg, innerWidth) + border(bl));
			// Pad remaining space
			for (let i = 1; i < maxLogVisible; i++) {
				lines.push(border(bl) + " ".repeat(innerWidth) + border(bl));
			}
		} else {
			// Scroll indicator
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

			const visibleLogs = logLines.slice(
				this.logScrollOffset,
				this.logScrollOffset +
					maxLogVisible -
					(this.logScrollOffset > 0 ? 1 : 0),
			);

			for (const logLine of visibleLogs) {
				// Render log line — truncate to fit, color code-like content dim
				let rendered = logLine;
				// Heuristic: lines starting with common log prefixes are dimmed
				if (
					rendered.startsWith("[INF]") ||
					rendered.startsWith("[WRN]") ||
					rendered.startsWith("[ERR]") ||
					rendered.startsWith("{") ||
					rendered.startsWith("  at ") ||
					rendered.startsWith("    at ")
				) {
					rendered = th.fg("dim", truncateToWidth(rendered, innerWidth - 2));
				} else {
					rendered = truncateToWidth(rendered, innerWidth - 2);
				}
				lines.push(
					border(bl) + padLine(` ${rendered}`, innerWidth) + border(bl),
				);
			}

			// Pad remaining space
			const usedLines = (this.logScrollOffset > 0 ? 1 : 0) + visibleLogs.length;
			const remaining = maxLogVisible - usedLines;
			for (let i = 0; i < remaining; i++) {
				lines.push(border(bl) + " ".repeat(innerWidth) + border(bl));
			}

			// Scroll indicator bottom
			if (this.logScrollOffset + maxLogVisible < logLines.length) {
				const moreBelow =
					logLines.length - this.logScrollOffset - maxLogVisible;
				// Replace last padding line
				lines[lines.length - 1] =
					border(bl) +
					padLine(th.fg("dim", ` ↓ ${moreBelow} lines below`), innerWidth) +
					border(bl);
			}
		}

		// ── Footer ───────────────────────────────────────────
		const lineInfo = `${this.logScrollOffset + 1}-${Math.min(this.logScrollOffset + maxLogVisible, Math.max(logLines.length, 1))}/${logLines.length}`;
		const footerHint = th.fg("dim", ` Esc=back · ↑/↓ scroll · ${lineInfo} `);
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

		const logLines = this.inspectedNode?.logLines ?? [];

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
