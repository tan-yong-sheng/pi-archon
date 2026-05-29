/**
 * /archon workflow history — browse past workflow runs with details.
 *
 * Uses ctx.ui.custom() with SelectList for an interactive TUI that
 * shows recent runs and lets the user select one to see details
 * (node states, artifacts, duration, error info).
 */
import type {
	ExtensionAPI,
	ExtensionCommandContext,
} from "@mariozechner/pi-coding-agent";
import {
	Container,
	DynamicBorder,
	SelectList,
	Text,
	type SelectItem,
} from "@mariozechner/pi-tui";
import {
	queryRecentRuns,
	queryRunArtifacts,
	queryRunNodeSummaries,
	formatRunRecordLabel,
	artifactIcon,
	artifactLabel,
	type WorkflowRunRecord,
	type WorkflowArtifact,
} from "./artifact-query";
import { formatElapsed, normalizeError } from "./helpers";

// ─── Types ────────────────────────────────────────────────────────

interface RunDetailData {
	run: WorkflowRunRecord;
	nodes: Array<{
		nodeId: string;
		state: string;
		durationMs?: number;
		error?: string;
		outputPreview?: string;
	}>;
	artifacts: WorkflowArtifact[];
}

// ─── Command handler ──────────────────────────────────────────────

/**
 * Handle `/archon workflow history [name]` — show a SelectList of
 * recent workflow runs and display details for the selected one.
 */
export async function handleWorkflowHistoryCommand(
	_pi: ExtensionAPI,
	args: string,
	ctx: ExtensionCommandContext,
): Promise<void> {
	const cwd = ctx.cwd || process.cwd();
	const workflowName = args.trim() || undefined;

	// Fetch recent runs
	let runs: WorkflowRunRecord[];
	try {
		runs = await queryRecentRuns(cwd, {
			limit: 25,
			workflowName,
		});
	} catch (queryErr) {
		ctx.ui?.notify(
			`Failed to query workflow history: ${normalizeError(queryErr)}`,
			"error",
		);
		return;
	}

	if (runs.length === 0) {
		ctx.ui?.notify(
			workflowName
				? `No runs found for workflow '${workflowName}'.`
				: "No workflow runs found in this project.",
			"info",
		);
		return;
	}

	// Build SelectList items
	const items: SelectItem[] = runs.map((run) => ({
		value: run.id,
		label: formatRunRecordLabel(run),
		description: `status: ${run.status}`,
	}));

	// Show SelectList via ctx.ui.custom()
	const selectedRunId = await ctx.ui.custom<string | null>(
		(tui, theme, _kb, done) => {
			const container = new Container();

			// Top border
			container.addChild(
				new DynamicBorder((s: string) => theme.fg("accent", s)),
			);

			// Title
			const title = workflowName
				? `Workflow History: ${workflowName}`
				: "Workflow History";
			container.addChild(new Text(theme.fg("accent", theme.bold(title)), 1, 0));

			// SelectList
			const selectList = new SelectList(items, Math.min(items.length, 12), {
				selectedPrefix: (t) => theme.fg("accent", t),
				selectedText: (t) => theme.fg("accent", t),
				description: (t) => theme.fg("muted", t),
				scrollInfo: (t) => theme.fg("dim", t),
				noMatch: (t) => theme.fg("warning", t),
			});

			selectList.onSelect = (item) => done(item.value);
			selectList.onCancel = () => done(null);

			container.addChild(selectList);

			// Help text
			container.addChild(
				new Text(
					theme.fg("dim", "↑↓ navigate • enter select • esc cancel"),
					1,
					0,
				),
			);

			// Bottom border
			container.addChild(
				new DynamicBorder((s: string) => theme.fg("accent", s)),
			);

			return {
				render: (w: number) => container.render(w),
				invalidate: () => container.invalidate(),
				handleInput: (data: string) => {
					selectList.handleInput(data);
					tui.requestRender();
				},
			};
		},
	);

	if (!selectedRunId) return; // User cancelled

	// Fetch details for the selected run
	const selectedRun = runs.find((r) => r.id === selectedRunId);
	if (!selectedRun) return;

	let detailData: RunDetailData;
	try {
		const [nodes, artifacts] = await Promise.all([
			queryRunNodeSummaries(selectedRunId),
			queryRunArtifacts(selectedRunId),
		]);
		detailData = { run: selectedRun, nodes, artifacts };
	} catch (detailErr) {
		ctx.ui?.notify(
			`Failed to load run details: ${normalizeError(detailErr)}`,
			"error",
		);
		return;
	}

	// Show detail view via ctx.ui.custom()
	await ctx.ui.custom<boolean>((tui, theme, _kb, done) => {
		const container = new Container();

		// Top border
		container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

		// Run header
		const headerText = formatRunDetailHeader(detailData.run);
		container.addChild(new Text(theme.fg("accent", headerText), 1, 0));

		// Node summaries
		if (detailData.nodes.length > 0) {
			container.addChild(new Text(theme.fg("text", "── Nodes ──"), 1, 0));
			for (const node of detailData.nodes) {
				const nodeLine = formatNodeSummary(node, theme);
				container.addChild(new Text(nodeLine, 0, 0));
			}
		}

		// Artifacts
		if (detailData.artifacts.length > 0) {
			container.addChild(new Text(theme.fg("text", "── Artifacts ──"), 1, 0));
			for (const artifact of detailData.artifacts) {
				const artifactLine = formatArtifactLine(artifact, theme);
				container.addChild(new Text(artifactLine, 0, 0));
			}
		}

		// Empty state
		if (detailData.nodes.length === 0 && detailData.artifacts.length === 0) {
			container.addChild(
				new Text(
					theme.fg("muted", "No node or artifact data available."),
					1,
					0,
				),
			);
		}

		// Help text
		container.addChild(new Text(theme.fg("dim", "Press esc to close"), 1, 0));

		// Bottom border
		container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

		return {
			render: (w: number) => container.render(w),
			invalidate: () => container.invalidate(),
			handleInput: (data: string) => {
				if (data === "\x1b") {
					// Escape
					done(false);
				}
				tui.requestRender();
			},
		};
	});
}

// ─── Formatting helpers ───────────────────────────────────────────

function formatRunDetailHeader(run: WorkflowRunRecord): string {
	const statusBadge =
		run.status === "completed"
			? "✓ completed"
			: run.status === "failed"
				? "✗ failed"
				: run.status === "running"
					? "● running"
					: `○ ${run.status}`;
	const duration =
		run.durationMs != null
			? ` · ${formatElapsed(Math.round(run.durationMs / 1000))}`
			: "";
	return `${run.workflowName} — ${statusBadge}${duration}`;
}

function formatNodeSummary(
	node: {
		nodeId: string;
		state: string;
		durationMs?: number;
		error?: string;
		outputPreview?: string;
	},
	theme: { fg: (cat: string, text: string) => string },
): string {
	const stateIcon =
		node.state === "completed"
			? theme.fg("success", "✓")
			: node.state === "failed"
				? theme.fg("error", "✗")
				: node.state === "running"
					? theme.fg("accent", "●")
					: theme.fg("dim", "○");

	const duration = node.durationMs
		? theme.fg("muted", ` ${formatElapsed(Math.round(node.durationMs / 1000))}`)
		: "";

	const error = node.error
		? theme.fg("error", ` ${node.error.slice(0, 60)}`)
		: "";

	return ` ${stateIcon} ${node.nodeId}${duration}${error}`;
}

function formatArtifactLine(
	artifact: WorkflowArtifact,
	theme: { fg: (cat: string, text: string) => string },
): string {
	const icon = artifactIcon(artifact.type);
	const label = artifactLabel(artifact.type);
	const detail = artifact.url
		? artifact.url
		: artifact.path
			? artifact.path
			: artifact.label;
	return ` ${icon} ${theme.fg("muted", label)}: ${detail}`;
}
