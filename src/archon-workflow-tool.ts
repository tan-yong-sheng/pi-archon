/**
 * archon_workflow tool — programmatic workflow access for the AI agent.
 *
 * Single tool with action parameter:
 *   - run:     Launch a workflow, return structured result
 *   - list:    Return available workflows in .archon/workflows/
 *   - status:  Return active/recent run status with node states
 *   - cancel:  Cancel a running workflow
 *
 * The AI agent uses this tool to:
 * 1. Discover available workflows (list)
 * 2. Launch workflows it authored or the user requested (run)
 * 3. Monitor progress of running workflows (status)
 * 4. Cancel workflows when needed (cancel)
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";

// StringEnum is not available from pi-ai in this environment,
// so we define it locally using Type.Union of Type.Literal.
function StringEnum<T extends readonly string[]>(
	values: T,
	options?: Record<string, unknown>,
) {
	return Type.Union(
		values.map((v) => Type.Literal(v)),
		options as unknown as undefined,
	);
}
import {
	runWorkflowBackground,
	cancelRun,
	getActiveRuns,
} from "./workflow-background";
import { readProjectWorkflowNamesFromDisk } from "./workflow-discovery";
import { queryRecentRuns, type WorkflowRunRecord } from "./artifact-query";
import { cancelArchonWorkflowRun } from "./workflow-ops";
import { fmtElapsed } from "./ui/workflow-overlay";

// ── Tool registration ────────────────────────────────────────

export function registerArchonWorkflowTool(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "archon_workflow",
		label: "Archon Workflow",
		description:
			"Run and manage Archon YAML workflows. Use 'list' to discover available workflows, " +
			"'run' to launch a workflow, 'status' to check on running/recent workflows, " +
			"and 'cancel' to stop a running workflow. Workflows are defined in .archon/workflows/*.yaml " +
			"and support DAG orchestration with conditional execution (when/trigger_rule), " +
			"structured output (output_format), loop iteration, approval gates, and parallel fan-out.",
		promptSnippet: "Run or manage Archon workflows",
		promptGuidelines: [
			"Use archon_workflow with action='list' to discover available workflows before running one.",
			"Use archon_workflow with action='run' to launch a workflow. Provide the workflow name and a query string.",
			"Use archon_workflow with action='status' to check on running or recently completed workflows.",
			"Use archon_workflow with action='cancel' to stop a running workflow by run ID.",
			"When the user asks to create a new workflow, author the YAML in .archon/workflows/ first, then use archon_workflow run to launch it.",
			"Archon workflows support conditional execution via 'when' expressions, 'trigger_rule' join semantics, structured output via 'output_format' (JSON Schema), approval gates, and loop iteration until completion.",
		],
		parameters: Type.Object({
			action: StringEnum(["run", "list", "status", "cancel"] as const, {
				description:
					"Action: 'run' to launch, 'list' to discover, 'status' to check, 'cancel' to stop",
			}),
			workflow: Type.Optional(
				Type.String({
					description:
						"Workflow name (for 'run' action). Must match a .archon/workflows/*.yaml file.",
				}),
			),
			query: Type.Optional(
				Type.String({
					description:
						"Query/prompt for the workflow run (for 'run' action). Passed as $ARGUMENTS to the workflow.",
				}),
			),
			runId: Type.Optional(
				Type.String({
					description:
						"Run ID to check or cancel (for 'status' and 'cancel' actions).",
				}),
			),
		}),
		async execute(_toolCallId, params, _signal, onUpdate, ctx) {
			const { action, workflow, query, runId } = params;
			const cwd = ctx?.cwd || process.cwd();

			switch (action) {
				case "run":
					return await handleRun(pi, workflow, query, cwd, onUpdate, ctx);
				case "list":
					return await handleList(cwd);
				case "status":
					return await handleStatus(pi, runId, cwd);
				case "cancel":
					return await handleCancel(pi, runId, cwd);
				default:
					throw new Error(`Unknown action: ${action}`);
			}
		},
		renderCall(args, theme, _context) {
			const action = args.action ?? "unknown";
			const target = args.workflow ?? args.runId ?? "";
			const actionLabels: Record<string, string> = {
				run: "▶ Run",
				list: "☰ List",
				status: "◎ Status",
				cancel: "✕ Cancel",
			};
			const label = actionLabels[action] ?? action;
			return [
				theme.fg("accent", `◆ archon ${label}`) +
					(target ? ` ${theme.bold(target)}` : ""),
				args.query
					? theme.fg("dim", `  ${String(args.query).slice(0, 80)}`)
					: undefined,
			].filter(Boolean);
		},
		renderResult(result, _options, theme, _context) {
			const text =
				result.content
					?.filter((c: { type: string }) => c.type === "text")
					.map((c: { text: string }) => c.text)
					.join("\n") ?? "";
			const details = result.details as Record<string, unknown> | undefined;
			const action = String(details?.action ?? "unknown");
			// Compact summary for the result card
			if (action === "list") {
				const workflows = details?.workflows as string[] | undefined;
				const count = workflows?.length ?? 0;
				return [
					theme.fg("accent", `◆ archon ▸ ${count} workflow(s) available`),
					...(workflows?.map((w: string) => theme.fg("dim", `  ▸ ${w}`)) ?? []),
				];
			}
			if (action === "status") {
				const active = details?.activeCount as number | undefined;
				const recent = details?.recentCount as number | undefined;
				return [
					theme.fg("accent", `◆ archon ▸ status`),
					theme.fg("dim", `  Active: ${active ?? 0} · Recent: ${recent ?? 0}`),
				];
			}
			if (action === "cancel") {
				return [
					theme.fg("warning", `◆ archon ▸ cancelled`),
					theme.fg("dim", `  ${String(details?.runId ?? "")}`),
				];
			}
			// run result — show completion summary
			if (action === "run") {
				const exitCode = details?.exitCode as number | undefined;
				const durationMs = details?.durationMs as number | undefined;
				const duration = durationMs
					? fmtElapsed(Math.floor(durationMs / 1000))
					: "";
				const success = exitCode === 0;
				return [
					theme.fg(
						success ? "success" : "error",
						`◆ archon ▸ ${success ? "completed" : "failed"}`,
					),
					theme.fg(
						"dim",
						`  ${String(details?.workflow ?? "")} · ${duration}${exitCode !== 0 ? ` · exit ${exitCode}` : ""}`,
					),
					text.length > 0
						? theme.fg("dim", `  ${text.slice(0, 200).split("\n")[0]}`)
						: undefined,
				].filter(Boolean);
			}
			// Fallback
			return [theme.fg("dim", text.slice(0, 200))];
		},
	});
}

// ── Action handlers ──────────────────────────────────────────

interface ToolCtx {
	cwd?: string;
	hasUI?: boolean;
	ui?: {
		custom?: <T>(_renderer: unknown) => Promise<T | undefined>;
		notify?: (message: string, level?: string) => void;
		setStatus?: (key: string, text: string | undefined) => void;
	};
}

async function handleRun(
	pi: ExtensionAPI,
	workflow?: string,
	query?: string,
	cwd?: string,
	onUpdate?: (update: { content: { type: string; text: string }[] }) => void,
	ctx?: ToolCtx,
): Promise<{
	content: { type: string; text: string }[];
	details: Record<string, unknown>;
	terminate?: boolean;
}> {
	if (!workflow) {
		throw new Error("'workflow' parameter is required for action='run'");
	}

	const queryText = query || "run";

	// Report progress
	onUpdate?.({
		content: [{ type: "text", text: `Launching workflow ${workflow}...` }],
	});

	// Try non-blocking background run if UI available
	if (ctx?.hasUI && ctx.ui) {
		const runId = runWorkflowBackground(pi, workflow, queryText, ctx as never);
		if (runId) {
			// Workflow launched in background — return immediately
			return {
				content: [
					{
						type: "text",
						text:
							`Workflow **${workflow}** launched in background (run ID: ${runId}). ` +
							`Use \`archon_workflow(action="status")\` to check progress, or /archons dashboard to monitor visually.`,
					},
				],
				details: {
					action: "run",
					workflow,
					runId,
					launched: true,
				},
			};
		}
	}

	// Fallback: synchronous execution (no UI)
	// This blocks until the workflow completes, which is fine for tool mode
	const { runArchonCommand, formatArchonOutput } = await import(
		"./archon-exec"
	);
	const startedAt = Date.now();
	const result = await runArchonCommand(
		pi,
		["workflow", "run", workflow, queryText, "--no-worktree"],
		cwd || process.cwd(),
	);
	const durationMs = Date.now() - startedAt;

	// Query artifacts from DB
	let artifacts: unknown[] = [];
	try {
		const { findLatestRunId, queryRunArtifacts: queryArts } = await import(
			"./artifact-query"
		);
		const latestRunId = await findLatestRunId(workflow, cwd || process.cwd());
		if (latestRunId) {
			artifacts = await queryArts(latestRunId);
		}
	} catch {
		/* best-effort */
	}

	const cleaned = formatArchonOutput(
		`${workflow.toUpperCase()} — ${queryText}`,
		result,
		durationMs,
	)
		.split("\n")
		.filter((l: string) => !/^\[(?:INF|WRN)\] /m.test(l))
		.join("\n");

	return {
		content: [{ type: "text", text: cleaned }],
		details: {
			action: "run",
			workflow,
			query: queryText,
			exitCode: result.exitCode,
			durationMs,
			artifacts,
			launched: false,
		},
		terminate: result.exitCode === 0,
	};
}

async function handleList(
	cwd?: string,
): Promise<{
	content: { type: string; text: string }[];
	details: Record<string, unknown>;
}> {
	const workflows = readProjectWorkflowNamesFromDisk(cwd || process.cwd());

	const lines = [`## Available Workflows (${workflows.length})`, ""];
	if (workflows.length === 0) {
		lines.push("No workflows found in `.archon/workflows/`.");
		lines.push("Create a workflow YAML file to get started.");
	} else {
		for (const name of workflows) {
			lines.push(`- \`${name}\``);
		}
	}
	lines.push("");

	return {
		content: [{ type: "text", text: lines.join("\n") }],
		details: {
			action: "list",
			workflows,
		},
	};
}

async function handleStatus(
	_pi: ExtensionAPI,
	runId?: string,
	cwd?: string,
): Promise<{
	content: { type: string; text: string }[];
	details: Record<string, unknown>;
}> {
	const activeRuns = getActiveRuns();
	const projectCwd = cwd || process.cwd();

	// Query recent runs from DB
	let recentRuns: WorkflowRunRecord[] = [];
	try {
		recentRuns = await queryRecentRuns(projectCwd, { limit: 10 });
	} catch {
		/* best-effort */
	}

	// If specific runId requested
	if (runId) {
		const activeEntry = activeRuns.get(runId);
		if (activeEntry) {
			const tracker = activeEntry.tracker;
			const elapsed = fmtElapsed(
				Math.floor((Date.now() - activeEntry.startedAt) / 1000),
			);
			const nodes = tracker.nodes.map((n) => ({
				id: n.id,
				state: n.state,
				duration: n.duration,
				error: n.error,
			}));

			return {
				content: [
					{
						type: "text",
						text: [
							`## Workflow: ${activeEntry.workflowName}`,
							"",
							`- **Status:** ${tracker.workflowDone ? (tracker.workflowError ? "failed" : "completed") : "running"}`,
							`- **Elapsed:** ${elapsed}`,
							`- **Nodes:** ${tracker.completedCount}/${tracker.totalCount} completed`,
							tracker.workflowError
								? `- **Error:** ${tracker.workflowError}`
								: "",
							"",
							"### Nodes",
							"",
							...nodes.map(
								(n) =>
									`- ${n.state === "done" ? "✓" : n.state === "error" ? "✗" : n.state === "running" ? "●" : "○"} ${n.id}${n.duration ? ` (${n.duration})` : ""}${n.error ? ` — ${n.error}` : ""}`,
							),
						]
							.filter(Boolean)
							.join("\n"),
					},
				],
				details: {
					action: "status",
					runId,
					workflow: activeEntry.workflowName,
					running: !tracker.workflowDone,
					nodes,
					activeCount: activeRuns.size,
					recentCount: recentRuns.length,
				},
			};
		}

		// Not in active runs — check DB
		const dbRun = recentRuns.find((r) => r.id === runId);
		if (dbRun) {
			let nodeSummaries: unknown[] = [];
			let artifacts: unknown[] = [];
			try {
				const { queryRunArtifacts, queryRunNodeSummaries: queryNodes } =
					await import("./artifact-query");
				nodeSummaries = await queryNodes(runId);
				artifacts = await queryRunArtifacts(runId);
			} catch {
				/* best-effort */
			}

			return {
				content: [
					{
						type: "text",
						text: [
							`## Workflow: ${dbRun.workflowName}`,
							"",
							`- **Status:** ${dbRun.status}`,
							`- **Duration:** ${dbRun.durationMs ? `${Math.round(dbRun.durationMs / 1000)}s` : "unknown"}`,
							dbRun.error ? `- **Error:** ${dbRun.error}` : "",
							`- **Started:** ${dbRun.startedAt}`,
							"",
							...(artifacts.length > 0
								? [
										"### Artifacts",
										"",
										...(
											artifacts as {
												label: string;
												type: string;
												url?: string;
											}[]
										).map(
											(a) =>
												`- ${a.type}: ${a.label}${a.url ? ` — ${a.url}` : ""}`,
										),
										"",
									]
								: []),
						]
							.filter(Boolean)
							.join("\n"),
					},
				],
				details: {
					action: "status",
					runId,
					workflow: dbRun.workflowName,
					running: false,
					activeCount: activeRuns.size,
					recentCount: recentRuns.length,
					nodeSummaries,
					artifacts,
				},
			};
		}

		// Run not found
		return {
			content: [
				{
					type: "text",
					text: `Run \`${runId}\` not found in active or recent runs.`,
				},
			],
			details: {
				action: "status",
				runId,
				found: false,
				activeCount: activeRuns.size,
				recentCount: recentRuns.length,
			},
		};
	}

	// No specific runId — return overview of all active + recent
	const lines = ["## Archon Workflow Status", ""];

	if (activeRuns.size > 0) {
		lines.push(`**Active (${activeRuns.size}):**`);
		for (const [id, entry] of activeRuns) {
			const elapsed = fmtElapsed(
				Math.floor((Date.now() - entry.startedAt) / 1000),
			);
			const progress = entry.tracker.progressSummary(
				Math.floor((Date.now() - entry.startedAt) / 1000),
			);
			lines.push(
				`- \`${id}\` **${entry.workflowName}** — ${progress} · ${elapsed}`,
			);
		}
		lines.push("");
	}

	if (recentRuns.length > 0) {
		lines.push(`**Recent (${recentRuns.length}):**`);
		for (const run of recentRuns.slice(0, 5)) {
			const icon =
				run.status === "completed" ? "✓" : run.status === "failed" ? "✗" : "○";
			const dur = run.durationMs
				? ` ${Math.round(run.durationMs / 1000)}s`
				: "";
			lines.push(
				`- ${icon} \`${run.id.slice(0, 8)}\` **${run.workflowName}**${dur} — ${run.status}`,
			);
		}
	}

	if (activeRuns.size === 0 && recentRuns.length === 0) {
		lines.push("No active or recent workflows.");
	}

	return {
		content: [{ type: "text", text: lines.join("\n") }],
		details: {
			action: "status",
			activeCount: activeRuns.size,
			recentCount: recentRuns.length,
		},
	};
}

async function handleCancel(
	pi: ExtensionAPI,
	runId?: string,
	cwd?: string,
): Promise<{
	content: { type: string; text: string }[];
	details: Record<string, unknown>;
}> {
	if (!runId) {
		throw new Error("'runId' parameter is required for action='cancel'");
	}

	// Try cancel from active runs first
	const activeEntry = getActiveRuns().get(runId);
	if (activeEntry) {
		await cancelRun(runId);
		return {
			content: [
				{
					type: "text",
					text: `Workflow **${activeEntry.workflowName}** (${runId}) cancelled.`,
				},
			],
			details: {
				action: "cancel",
				runId,
				workflow: activeEntry.workflowName,
				source: "active",
			},
		};
	}

	// Try Archon CLI abandon
	try {
		await cancelArchonWorkflowRun(pi, runId, cwd || process.cwd());
		return {
			content: [
				{
					type: "text",
					text: `Workflow run \`${runId}\` cancelled via Archon CLI.`,
				},
			],
			details: {
				action: "cancel",
				runId,
				source: "cli",
			},
		};
	} catch (err) {
		throw new Error(
			`Failed to cancel run ${runId}: ${err instanceof Error ? err.message : String(err)}`,
		);
	}
}
