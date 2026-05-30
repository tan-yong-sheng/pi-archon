/**
 * Archon overlay popup — replaces all inline emitArchonMessage calls
 * with a bordered popup overlay that shows content and dismisses on Esc/Enter.
 *
 * Every /archon subcommand now uses this instead of printing inline.
 */

import type {
	ExtensionAPI,
	ExtensionCommandContext,
} from "@mariozechner/pi-coding-agent";
import type { Component, Theme } from "@mariozechner/pi-tui";
import { visibleWidth } from "@mariozechner/pi-tui";

// ── Public API ───────────────────────────────────────────────

/**
 * Show content in a popup overlay instead of inline chat message.
 * Falls back to pi.sendMessage if no UI is available.
 *
 * @param pi Extension API
 * @param ctx Command context
 * @param content Markdown content to display
 * @param options Overlay configuration
 */
export async function showArchonOverlay(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	content: string,
	options?: ArchonOverlayOptions,
): Promise<void> {
	const title = options?.title ?? "Archon";
	const width = options?.width ?? 52;
	const anchor = options?.anchor ?? "center";

	if (!ctx.hasUI) {
		// Fallback: inline message (headless mode)
		pi.sendMessage?.(
			{
				customType: "archon",
				content,
				display: true,
				details: options?.details,
			},
			{ deliverAs: "nextTurn" },
		);
		return;
	}

	await ctx.ui.custom<void>(
		(
			_tui: unknown,
			theme: Theme,
			_kb: unknown,
			done: (value: void) => void,
		) => {
			return new ArchonOverlayPanel(content, title, width, theme, done);
		},
		{
			overlay: true,
			overlayOptions: {
				anchor,
				width,
				maxHeight: options?.maxHeight ?? "70%",
			},
		},
	);
}

export interface ArchonOverlayOptions {
	title?: string;
	width?: number;
	anchor?: "center" | "top-center" | "bottom-center";
	maxHeight?: string | number;
	details?: Record<string, unknown>;
}

// ── Key matching helpers ─────────────────────────────────────

const ESC = "\x1b";
const ENTER = "\r";
const UP = "\x1b[A";
const DOWN = "\x1b[B";
const PAGE_UP = "\x1b[5~";
const PAGE_DOWN = "\x1b[6~";

function isKey(data: string, seq: string): boolean {
	return data === seq;
}

// ── Overlay panel component ──────────────────────────────────

class ArchonOverlayPanel implements Component {
	private content: string;
	private title: string;
	private width: number;
	private theme: Theme;
	private done: (value: void) => void;
	private scrollOffset = 0;
	private totalLines = 0;
	private viewHeight = 20;

	constructor(
		content: string,
		title: string,
		width: number,
		theme: Theme,
		done: (value: void) => void,
	) {
		this.content = content;
		this.title = title;
		this.width = width;
		this.theme = theme;
		this.done = done;
	}

	render(width: number, height?: number): string[] {
		const w = Math.min(width, this.width);
		const th = this.theme;
		const innerW = w - 2;

		if (height) {
			this.viewHeight = Math.max(height - 5, 6);
		}

		const lines: string[] = [];

		// Header
		const titleStr = ` ${th.fg("accent", "◆")} ${th.bold(this.title)} `;
		const titleVisW = visibleWidth(titleStr);
		const titlePadL = Math.max(0, Math.floor((innerW - titleVisW) / 2));
		const titlePadR = Math.max(0, innerW - titleVisW - titlePadL);
		lines.push(
			th.fg("border", "╭") +
				th.fg("border", "─".repeat(titlePadL)) +
				titleStr +
				th.fg("border", "─".repeat(titlePadR)) +
				th.fg("border", "╮"),
		);

		// Content lines
		const contentLines = this.content.split("\n");
		this.totalLines = contentLines.length;

		// Apply scroll
		const visible = contentLines.slice(
			this.scrollOffset,
			this.scrollOffset + this.viewHeight,
		);

		for (const line of visible) {
			// Simple rendering: strip markdown headers for accent coloring
			let rendered = line;
			if (rendered.startsWith("## ")) {
				rendered = th.bold(th.fg("accent", rendered.slice(3)));
			} else if (rendered.startsWith("# ")) {
				rendered = th.bold(th.fg("accent", rendered.slice(2)));
			} else if (rendered.startsWith("- **") && rendered.includes(":**")) {
				// Bullet with bold key: "- **Key:** value"
				const boldEnd = rendered.indexOf(":**");
				if (boldEnd > 3) {
					const key = rendered.slice(4, boldEnd);
					const rest = rendered.slice(boldEnd + 3);
					rendered = `  ${th.bold(key)}:${rest}`;
				}
			} else if (rendered.startsWith("- ")) {
				rendered = `  • ${rendered.slice(2)}`;
			} else if (rendered.startsWith("```")) {
				rendered = th.fg("dim", rendered);
			} else if (rendered.trim() === "") {
				rendered = "";
			}

			const visW = visibleWidth(rendered);
			if (visW <= innerW) {
				lines.push(
					th.fg("border", "│") +
						rendered +
						" ".repeat(Math.max(0, innerW - visW)) +
						th.fg("border", "│"),
				);
			} else {
				// Truncate long lines
				const truncated = rendered.slice(0, innerW);
				lines.push(th.fg("border", "│") + truncated + th.fg("border", "│"));
			}
		}

		// Pad remaining space
		const usedHeight = visible.length;
		const remaining = Math.max(0, this.viewHeight - usedHeight);
		for (let i = 0; i < remaining; i++) {
			lines.push(
				th.fg("border", "│") + " ".repeat(innerW) + th.fg("border", "│"),
			);
		}

		// Scroll indicator line
		const canScrollUp = this.scrollOffset > 0;
		const canScrollDown = this.scrollOffset + this.viewHeight < this.totalLines;

		let scrollLine: string;
		if (canScrollUp || canScrollDown) {
			const info = `${this.scrollOffset + 1}-${Math.min(this.scrollOffset + this.viewHeight, this.totalLines)}/${this.totalLines}`;
			const arrows =
				(canScrollUp ? "↑ " : "  ") + info + (canScrollDown ? " ↓" : "  ");
			scrollLine =
				th.fg("border", "│") +
				th.fg("dim", ` ${arrows}`) +
				" ".repeat(Math.max(0, innerW - visibleWidth(arrows) - 2)) +
				" " +
				th.fg("border", "│");
		} else {
			scrollLine =
				th.fg("border", "│") + " ".repeat(innerW) + th.fg("border", "│");
		}
		lines.push(scrollLine);

		// Footer
		const footer = th.fg("dim", " Esc/Enter close · ↑/↓ scroll ");
		const footerVisW = visibleWidth(footer);
		lines.push(
			th.fg("border", "╰") +
				th.fg(
					"border",
					"─".repeat(Math.max(0, Math.floor((innerW - footerVisW) / 2))),
				) +
				footer +
				th.fg(
					"border",
					"─".repeat(
						Math.max(
							0,
							innerW - Math.floor((innerW - footerVisW) / 2) - footerVisW,
						),
					),
				) +
				th.fg("border", "╯"),
		);

		return lines;
	}

	handleInput(data: string): boolean {
		// Esc or Enter — dismiss
		if (isKey(data, ESC) || isKey(data, ENTER)) {
			this.done();
			return true;
		}

		// Scroll up
		if (isKey(data, UP)) {
			this.scrollOffset = Math.max(0, this.scrollOffset - 1);
			return true;
		}

		// Scroll down
		if (isKey(data, DOWN)) {
			if (this.scrollOffset + this.viewHeight < this.totalLines) {
				this.scrollOffset++;
			}
			return true;
		}

		// Page Up
		if (isKey(data, PAGE_UP)) {
			this.scrollOffset = Math.max(0, this.scrollOffset - this.viewHeight);
			return true;
		}

		// Page Down
		if (isKey(data, PAGE_DOWN)) {
			this.scrollOffset = Math.min(
				Math.max(0, this.totalLines - this.viewHeight),
				this.scrollOffset + this.viewHeight,
			);
			return true;
		}

		return true; // consume all input while overlay is open
	}
}
