/**
 * archon_workflow tool — programmatic workflow access for the AI agent.
 *
 * Single tool with action parameter:
 *   - run:     Launch a workflow, return structured result
 *   - list:    Return available workflows in .archon/workflows/
 *   - status:  Return active/recent run status with node states
 *   - cancel:  Cancel a running workflow
 *   - resume:  Resume a failed or paused workflow run
 *   - approve: Approve a paused workflow at an approval gate
 *   - info:    Show detailed YAML definition of a specific workflow
 *
 * The AI agent uses this tool to:
 * 1. Discover available workflows (list)
 * 2. Launch workflows it authored or the user requested (run)
 * 3. Monitor progress of running workflows (status)
 * 4. Cancel workflows when needed (cancel)
 * 5. Resume failed/paused workflows (resume)
 * 6. Approve at approval gates to continue execution (approve)
 * 7. Inspect a specific workflow's full definition and nodes (info)
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
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
	resumeWorkflowBackground,
	approveWorkflowBackground,
	rejectWorkflowBackground,
	cancelRun,
	getActiveRuns,
	findPausedRun,
} from "./workflow-background";
import { readProjectWorkflowNamesFromDisk } from "./workflow-discovery";
import {
	listWorkflowsWithDetails,
	getRunDetail,
	findLatestRunIdForWorkflow,
} from "./archon-api";
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
			"Use archon_workflow with action='run' to launch a workflow. Provide the workflow name and a query string. The agent turn ends immediately after launching (terminate: true) — the workflow runs in the background and its result is automatically injected as a user message when complete.",
			"Use archon_workflow with action='list' to discover available workflows with descriptions, grouped by source (project/global/bundled).",
			"Use archon_workflow with action='info' to INSPECT a specific workflow's full YAML definition, including all nodes, triggers, providers, and configuration.",
			"After a workflow launch, the result arrives as a user message — process it, extract key information, and present it to the user. Do NOT ignore completion messages.",
			"Use archon_workflow with action='status' to check on running or recently completed workflows. Returns node states, durations, and errors.",
			"Use archon_workflow with action='cancel' to stop a running workflow by run ID.",
			"Use archon_workflow with action='resume' to resume a failed or paused workflow run. Provide the run ID.",
			"Use archon_workflow with action='approve' to approve a paused workflow at an approval gate. Provide the run ID and optionally a comment. The workflow auto-resumes after approval and its output is delivered as a user message.",
			"Use archon_workflow with action='reject' to reject a paused workflow at an approval gate. Provide the run ID and a required reason (explaining why the user rejected it). The CLI handles both rejection and optional on_reject resume within the same process.",
			"Use archon_workflow with action='latest-run' to look up the most recent run ID for a workflow. Provide 'workflow' parameter (workflow name) to find the latest run of that workflow, or 'runId' to get details for a specific run.",
			"IMPORTANT — APPROVAL GATES REQUIRE HUMAN-IN-LOOP: When a workflow pauses at an approval gate, the pause notification arrives as a user message. You MUST ask the user whether they want to approve or reject — do NOT auto-approve or auto-cancel. Only execute approve/reject after the user explicitly says so.",
			"When the user asks to create a new workflow, author the YAML in .archon/workflows/ first, then use archon_workflow run to launch it.",
			"Archon workflows support conditional execution via 'when' expressions, 'trigger_rule' join semantics, structured output via 'output_format' (JSON Schema), approval gates, and loop iteration until completion.",
		],
		parameters: Type.Object({
			action: StringEnum(
				[
					"run",
					"list",
					"status",
					"cancel",
					"resume",
					"approve",
					"reject",
					"info",
					"latest-run",
				] as const,
				{
					description:
						"Action: 'run' to launch, 'list' to discover, 'status' to check, 'cancel' to stop, " +
						"'resume' to resume a failed/paused run, 'approve'/'reject' at an approval gate " +
						"(human-in-loop — must ask user first), 'latest-run' to find the most recent run ID for a workflow",
				},
			),
			runId: Type.Optional(
				Type.String({
					description:
						"Run ID to check, cancel, resume, approve, or reject (for 'status', 'cancel', 'resume', 'approve', 'reject', and 'latest-run' actions).",
				}),
			),
			workflow: Type.Optional(
				Type.String({
					description:
						"Workflow name for 'run' and 'info' actions. Must match a .archon/workflows/*.yaml file.",
				}),
			),
			reason: Type.String({
				description:
					"Reason for rejection (required for 'reject' action). The on_reject prompt in the workflow will receive this via $REJECTION_REASON.",
			}),
		}),
		async execute(_toolCallId, params, _signal, onUpdate, ctx) {
			const { action, workflow, query, runId, comment, reason } = params;
			const cwd = ctx?.cwd || process.cwd();

			switch (action) {
				case "info":
					return await handleInfo(workflow, cwd);
				case "run":
					return await handleRun(pi, workflow, query, cwd, onUpdate, ctx);
				case "list":
					return await handleList(cwd);
				case "status":
					return await handleStatus(pi, runId, cwd);
				case "resume":
					return await handleResume(pi, runId, cwd, ctx);
				case "approve":
					return await handleApprove(pi, runId, comment, cwd, ctx);
				case "reject":
					return await handleReject(pi, runId, comment, cwd, ctx);
				case "cancel":
					return await handleCancel(pi, runId, cwd);
				case "reject":
					return await handleReject(pi, runId, reason, cwd, ctx);
				case "latest-run":
					return await handleLatestRun(runId, workflow, cwd);
				default:
					throw new Error(`Unknown action: ${action}`);
			}
		},
		renderCall(args, theme, context) {
			const action = args.action ?? "unknown";
			const target = args.workflow ?? args.runId ?? "";
			const actionLabels: Record<string, string> = {
				run: "▶ Run",
				list: "☰ List",
				info: "ℹ Info",
				status: "◎ Status",
				cancel: "✕ Cancel",
				resume: "↻ Resume",
				approve: "✓ Approve",
				reject: "✗ Reject",
				"latest-run": "◎ Latest",
			};
			const label = actionLabels[action] ?? action;
			const parts = [
				theme.fg("accent", `◆ archon ${label}`) +
					(target ? ` ${theme.bold(target)}` : ""),
				args.query
					? theme.fg("dim", `  ${String(args.query).slice(0, 80)}`)
					: undefined,
			].filter(Boolean) as string[];
			const text = context.lastComponent ?? new Text("", 0, 0);
			text.setText(parts.join("\n"));
			return text;
		},
		renderResult(result, _options, theme, context) {
			const contentText =
				result.content
					?.filter((c: { type: string }) => c.type === "text")
					.map((c: { text: string }) => c.text)
					.join("\n") ?? "";
			const details = result.details as Record<string, unknown> | undefined;
			const action = String(details?.action ?? "unknown");
			let lines: string[] = [];
			// Compact summary for the result card
			if (action === "list") {
				const workflows = details?.workflows as
					| Array<{ name: string; description?: string; source?: string }>
					| string[]
					| undefined;
				const count = workflows?.length ?? 0;
				lines = [
					theme.fg("accent", `◆ archon ▸ ${count} workflow(s) available`),
					...(workflows?.map((w: unknown) => {
						const name =
							typeof w === "string" ? w : (w as { name: string }).name;
						return theme.fg("dim", `  ▸ ${name}`);
					}) ?? []),
				];
			} else if (action === "status") {
				const active = details?.activeCount as number | undefined;
				const recent = details?.recentCount as number | undefined;
				lines = [
					theme.fg("accent", `◆ archon ▸ status`),
					theme.fg("dim", `  Active: ${active ?? 0} · Recent: ${recent ?? 0}`),
				];
			} else if (action === "cancel") {
				lines = [
					theme.fg("warning", `◆ archon ▸ cancelled`),
					theme.fg("dim", `  ${String(details?.runId ?? "")}`),
				];
			} else if (action === "resume") {
				const runIdStr = String(details?.runId ?? "");
				lines = [
					theme.fg("accent", `◆ archon ▸ resumed`),
					theme.fg(
						"dim",
						`  ${String(details?.workflow ?? "")} · ${runIdStr.slice(0, 24)}`,
					),
				];
			} else if (action === "approve") {
				const runIdStr = String(details?.runId ?? "");
				lines = [
					theme.fg("success", `◆ archon ▸ approved`),
					theme.fg(
						"dim",
						`  ${String(details?.workflow ?? "")} · ${runIdStr.slice(0, 24)}${details?.comment ? ` · ${String(details?.comment).slice(0, 60)}` : ""}`,
					),
				];
			} else if (action === "reject") {
				const runIdStr = String(details?.runId ?? "");
				lines = [
					theme.fg("warning", `◆ archon ▸ rejected`),
					theme.fg(
						"dim",
						`  ${String(details?.workflow ?? "")} · ${runIdStr.slice(0, 24)}${details?.reason ? ` · ${String(details?.reason).slice(0, 60)}` : ""}`,
					),
				];
			} else if (action === "latest-run") {
				const runIdStr = String(details?.runId ?? "");
				lines = [
					theme.fg("accent", `◆ archon ▸ latest run`),
					theme.fg(
						"dim",
						`  ${String(details?.workflow ?? "")} · ${runIdStr.slice(0, 32)} · ${String(details?.status ?? "")}${details?.startedAt ? ` · ${String(details?.startedAt).slice(0, 19)}` : ""}`,
					),
				];
			} else if (action === "run") {
				const launched = details?.launched === true;
				const exitCode = details?.exitCode as number | undefined;
				const durationMs = details?.durationMs as number | undefined;
				const duration = durationMs
					? fmtElapsed(Math.floor(durationMs / 1000))
					: "";
				if (launched) {
					// Background launch — no exit code yet, show as launched
					const runId = String(details?.runId ?? "");
					lines = [
						theme.fg("accent", `◆ archon ▸ launched`),
						theme.fg(
							"dim",
							`  ${String(details?.workflow ?? "")} · ${runId.slice(0, 24)}`,
						),
						contentText.length > 0
							? theme.fg("dim", `  ${contentText.slice(0, 200).split("\n")[0]}`)
							: undefined,
					].filter(Boolean) as string[];
				} else {
					// Synchronous completion (or file-based execution) — exitCode is known
					const success = exitCode === 0;
					lines = [
						theme.fg(
							success ? "success" : "error",
							`◆ archon ▸ ${success ? "completed" : "failed"}`,
						),
						theme.fg(
							"dim",
							`  ${String(details?.workflow ?? "")} · ${duration}${exitCode !== 0 ? ` · exit ${exitCode}` : ""}`,
						),
						contentText.length > 0
							? theme.fg("dim", `  ${contentText.slice(0, 200).split("\n")[0]}`)
							: undefined,
					].filter(Boolean) as string[];
				}
			} else if (action === "info") {
				const source = String(details?.source ?? "");
				lines = [
					theme.fg(
						"accent",
						`◆ archon ▸ info: ${String(details?.workflow ?? "")}`,
					),
					theme.fg("dim", `  source: ${source}`),
				];
			} else {
				// Fallback
				lines = [theme.fg("dim", contentText.slice(0, 200))];
			}
			const text = context.lastComponent ?? new Text("", 0, 0);
			text.setText(lines.join("\n"));
			return text;
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
			// Workflow launched in background — return immediately.
			// terminate: true stops the agent loop — the workflow runs
			// independently. The result is injected as a user message
			// via sendUserMessage when it completes.
			return {
				content: [
					{
						type: "text",
						text:
							`Workflow **${workflow}** launched in background (run ID: ${runId}). ` +
							`The result will be delivered automatically. ` +
							`Use \`archon_workflow(action="status")\` to check progress, or /archons dashboard.`,
					},
				],
				details: {
					action: "run",
					workflow,
					runId,
					launched: true,
				},
				terminate: true,
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

async function handleList(cwd?: string): Promise<{
	content: { type: string; text: string }[];
	details: Record<string, unknown>;
}> {
	const projectCwd = cwd || process.cwd();

	// List workflows with descriptions via CLI
	const apiWorkflows = await listWorkflowsWithDetails(projectCwd);

	if (apiWorkflows && apiWorkflows.length > 0) {
		const lines = [`## Available Workflows (${apiWorkflows.length})`, ""];

		const sourceOrder: string[] = ["project", "global", "bundled"];
		const sourceLabels: Record<string, string> = {
			project: "Project",
			global: "Global",
			bundled: "Bundled",
		};

		for (const source of sourceOrder) {
			const group = apiWorkflows.filter((w) => w.source === source);
			if (group.length === 0) continue;

			lines.push(`### ${sourceLabels[source] ?? source} (${group.length})`);
			lines.push("");

			for (const w of group) {
				const desc = w.description
					.split("\n")[0]
					.replace(/^Use when:\s*/i, "")
					.trim();
				const modelTag = w.model ? ` [${w.model}]` : "";
				const providerTag = w.provider ? ` via ${w.provider}` : "";
				lines.push(`- **\`${w.name}\`**${modelTag} — ${desc}${providerTag}`);
			}
			lines.push("");
		}

		return {
			content: [{ type: "text", text: lines.join("\n") }],
			details: {
				action: "list",
				workflows: apiWorkflows,
			},
		};
	}

	// Fallback: read names from disk (no descriptions)
	const names = readProjectWorkflowNamesFromDisk(projectCwd);

	const lines = [
		`## Available Workflows (${names.length})`,
		"",
		"_Descriptions unavailable — Archon CLI could not retrieve workflow details._",
		"",
	];
	if (names.length === 0) {
		lines.push("No workflows found in `.archon/workflows/`.");
		lines.push("Create a workflow YAML file to get started.");
	} else {
		for (const name of names) {
			lines.push(`- \`${name}\``);
		}
	}
	lines.push("");

	return {
		content: [{ type: "text", text: lines.join("\n") }],
		details: {
			action: "list",
			workflows: names.map((n) => ({
				name: n,
				description: "",
				source: "project" as const,
			})),
		},
	};
}

/**
 * Show full YAML definition of a specific workflow.
 */
async function handleInfo(
	workflow?: string,
	cwd?: string,
): Promise<{
	content: { type: string; text: string }[];
	details: Record<string, unknown>;
}> {
	if (!workflow) {
		throw new Error("'workflow' parameter is required for action='info'");
	}

	const projectCwd = cwd || process.cwd();

	// Try project-local YAML first
	const projectFile = `${projectCwd}/.archon/workflows/${workflow}.yaml`;
	const fs = require("node:fs");
	if (fs.existsSync(projectFile)) {
		const raw = fs.readFileSync(projectFile, "utf-8");

		const lines: string[] = [
			`## Workflow: ${workflow}`,
			"",
			`**Source:** project (\`.archon/workflows/${workflow}.yaml\`)`,
			"",
			"```yaml",
			raw.trim(),
			"```",
		];

		return {
			content: [{ type: "text", text: lines.join("\n") }],
			details: { action: "info", workflow, source: "project" },
		};
	}

	// Try fetching from CLI list output for bundled workflows
	const workflows = await listWorkflowsWithDetails(projectCwd);
	const wf = workflows?.find((w) => w.name === workflow);
	if (wf) {
		const lines = [
			`## Workflow: ${workflow}`,
			"",
			`**Source:** bundled`,
			"",
			`**Description:** ${wf.description.split("\n")[0]}`,
			"",
			`**Provider:** ${wf.provider ?? "default"}  **Model:** ${wf.model ?? "default"}`,
			"",
			"Node details are embedded in the Archon binary and cannot be extracted.",
			"Run the workflow to see its execution graph, or check the marketplace.",
		];
		return {
			content: [{ type: "text", text: lines.join("\n") }],
			details: { action: "info", workflow, source: "bundled" },
		};
	}

	throw new Error(
		`Workflow "${workflow}" not found. Use action='list' to discover available workflows.`,
	);
}

async function handleLatestRun(
	runId?: string,
	workflow?: string,
	cwd?: string,
): Promise<{
	content: { type: string; text: string }[];
	details: Record<string, unknown>;
}> {
	const projectCwd = cwd || process.cwd();

	// If runId is given, look up that specific run
	if (runId) {
		const detail = await getRunDetail(runId);
		if (!detail) {
			throw new Error(`Run not found: ${runId}`);
		}
		return {
			content: [
				{
					type: "text",
					text: [
						`## Run: ${detail.run.workflow_name}`,
						"",
						`- **ID:** \`${detail.run.id}\``,
						`- **Status:** ${detail.run.status}`,
						`- **Started:** ${detail.run.started_at.slice(0, 19)}`,
						detail.run.completed_at
							? `- **Completed:** ${detail.run.completed_at.slice(0, 19)}`
							: "",
						detail.run.metadata?.total_cost_usd
							? `- **Cost:** $${Number(detail.run.metadata.total_cost_usd).toFixed(4)}`
							: "",
						detail.events.length > 0
							? `- **Events:** ${detail.events.length}`
							: "",
					]
						.filter(Boolean)
						.join("\n"),
				},
			],
			details: {
				action: "latest-run",
				runId: detail.run.id,
				workflow: detail.run.workflow_name,
				status: detail.run.status,
				startedAt: detail.run.started_at,
				completedAt: detail.run.completed_at,
				costUsd: detail.run.metadata?.total_cost_usd,
			},
		};
	}

	// Otherwise find the latest run for a workflow name
	if (!workflow) {
		throw new Error(
			"Provide either 'runId' (specific run) or 'workflow' (find latest run for a workflow name)",
		);
	}

	const foundRunId = await findLatestRunIdForWorkflow(workflow, projectCwd);
	if (!foundRunId) {
		throw new Error(
			`No recent runs found for workflow "${workflow}". The workflow may not have been run yet, or the SQLite DB is unreadable.`,
		);
	}

	// Fetch full detail for the found run
	const detail = await getRunDetail(foundRunId);
	if (!detail) {
		// Return what we have even without full detail
		return {
			content: [
				{
					type: "text",
					text: `Latest run for **${workflow}**: \`${foundRunId}\``,
				},
			],
			details: {
				action: "latest-run",
				runId: foundRunId,
				workflow,
			},
		};
	}

	return {
		content: [
			{
				type: "text",
				text: [
					`## Latest Run: ${detail.run.workflow_name}`,
					"",
					`- **ID:** \`${detail.run.id}\``,
					`- **Status:** ${detail.run.status}`,
					`- **Started:** ${detail.run.started_at.slice(0, 19)}`,
					detail.run.completed_at
						? `- **Completed:** ${detail.run.completed_at.slice(0, 19)}`
						: "",
					detail.run.metadata?.total_cost_usd
						? `- **Cost:** $${Number(detail.run.metadata.total_cost_usd).toFixed(4)}`
						: "",
					detail.events.length > 0
						? `- **Events:** ${detail.events.length}`
						: "",
				]
					.filter(Boolean)
					.join("\n"),
			},
		],
		details: {
			action: "latest-run",
			runId: detail.run.id,
			workflow: detail.run.workflow_name,
			status: detail.run.status,
			startedAt: detail.run.started_at,
			completedAt: detail.run.completed_at,
			costUsd: detail.run.metadata?.total_cost_usd,
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

async function handleResume(
	pi: ExtensionAPI,
	runId?: string,
	cwd?: string,
	ctx?: ToolCtx,
): Promise<{
	content: { type: string; text: string }[];
	details: Record<string, unknown>;
	terminate?: boolean;
}> {
	if (!runId) {
		throw new Error("'runId' parameter is required for action='resume'");
	}

	const projectCwd = cwd || process.cwd();

	// Try to resolve the workflow name from active runs first
	let activeEntry = getActiveRuns().get(runId);
	let workflowName = activeEntry?.workflowName;

	// If not in active runs, check if this is an Archon UUID from a paused workflow
	if (!workflowName) {
		const pausedEntry = findPausedRun(runId);
		if (pausedEntry) {
			activeEntry = pausedEntry;
			workflowName = pausedEntry.workflowName;
		}
	}

	// If still not found, try querying the DB
	if (!workflowName) {
		try {
			const detail = await getRunDetail(runId);
			if (detail) {
				workflowName = detail.run.workflow_name;
			}
		} catch {
			// Best-effort
		}
	}

	// Launch in background if UI available
	if (ctx?.hasUI && ctx.ui && workflowName) {
		// Dismiss paused-run overlay if we found one (replaced by new resume overlay)
		activeEntry?.overlayHandle?.hide();

		const localRunId = resumeWorkflowBackground(
			pi,
			runId,
			workflowName,
			ctx as never,
		);
		if (localRunId) {
			return {
				content: [
					{
						type: "text",
						text:
							`Workflow **${workflowName}** (${runId}) resumed in background. ` +
							`The result will be delivered automatically. ` +
							`Use \`archon_workflow(action="status")\` to check progress, or /archons dashboard.`,
					},
				],
				details: {
					action: "resume",
					runId,
					workflow: workflowName,
				},
				terminate: false,
			};
		}
	}

	// Fallback: synchronous CLI execution (archon workflow run --resume)
	const { runArchonCommand } = await import("./archon-exec");
	const startedAt = Date.now();
	const result = await runArchonCommand(
		pi,
		["workflow", "run", workflowName ?? "", "--resume", "--no-worktree"],
		projectCwd,
	);
	const durationMs = Date.now() - startedAt;
	const success = result.exitCode === 0;

	return {
		content: [
			{
				type: "text",
				text: [
					`## Resume Result — ${runId}`,
					"",
					`- **Status:** ${success ? "✅ completed" : "❌ failed"}`,
					`- **Duration:** ${Math.round(durationMs / 1000)}s`,
					result.exitCode !== 0 && result.stderr
						? `- **Error:** ${result.stderr.slice(0, 500)}`
						: "",
					result.stdout
						? `\`\`\`text\n${result.stdout.slice(0, 1000)}\n\`\`\``
						: "",
				]
					.filter(Boolean)
					.join("\n"),
			},
		],
		details: {
			action: "resume",
			runId,
			workflow: workflowName ?? "unknown",
			exitCode: result.exitCode,
			durationMs,
		},
	};
}

async function handleReject(
	pi: ExtensionAPI,
	runId: string,
	reason: string,
	cwd?: string,
	ctx?: ToolCtx,
): Promise<{
	content: { type: string; text: string }[];
	details: Record<string, unknown>;
	terminate?: boolean;
}> {
	if (!runId) {
		throw new Error("'runId' parameter is required for action='reject'");
	}
	if (!reason) {
		throw new Error("'reason' parameter is required for action='reject'");
	}

	const projectCwd = cwd || process.cwd();

	// Try to resolve the workflow name from active runs first
	let activeEntry = getActiveRuns().get(runId);
	let workflowName = activeEntry?.workflowName;

	// If not in active runs, check if this is an Archon UUID from a paused workflow
	if (!workflowName) {
		const pausedEntry = findPausedRun(runId);
		if (pausedEntry) {
			activeEntry = pausedEntry;
			workflowName = pausedEntry.workflowName;
		}
	}

	// If still not found, try querying the DB
	if (!workflowName) {
		try {
			const detail = await getRunDetail(runId);
			if (detail) {
				workflowName = detail.run.workflow_name;
			}
		} catch {
			// Best-effort
		}
	}

	// Launch in background if UI available
	if (ctx?.hasUI && ctx.ui && workflowName) {
		// Dismiss paused-run overlay if we found one
		activeEntry?.overlayHandle?.hide();

		const localRunId = await rejectWorkflowBackground(
			pi,
			runId,
			workflowName,
			reason,
			ctx as never,
		);
		if (localRunId) {
			return {
				content: [
					{
						type: "text",
						text:
							`Workflow **${workflowName}** (${runId}) rejected${reason ? `: ${reason}` : ""}. ` +
							`Result will be delivered automatically.`,
					},
				],
				details: {
					action: "reject",
					runId,
					workflow: workflowName,
					reason: reason ?? undefined,
				},
				terminate: false,
			};
		}
	}

	// Fallback: synchronous CLI execution (no UI)
	const { runArchonCommand } = await import("./archon-exec");
	const startedAt = Date.now();

	const cliArgs: string[] = [
		"workflow",
		"reject",
		runId,
		"--no-worktree",
		reason,
	];
	const result = await runArchonCommand(pi, cliArgs, projectCwd);
	const durationMs = Date.now() - startedAt;
	const success = result.exitCode === 0;

	return {
		content: [
			{
				type: "text",
				text: [
					`## Reject Result — ${runId}`,
					"",
					`- **Status:** ${success ? "✅ rejected" : "❌ failed"}`,
					`- **Duration:** ${Math.round(durationMs / 1000)}s`,
					reason ? `- **Reason:** ${reason}` : "",
					result.exitCode !== 0 && result.stderr
						? `- **Error:** ${result.stderr.slice(0, 500)}`
						: "",
					result.stdout
						? `\`\`\`text\n${result.stdout.slice(0, 1000)}\n\`\`\``
						: "",
				]
					.filter(Boolean)
					.join("\n"),
			},
		],
		details: {
			action: "reject",
			runId,
			workflow: workflowName ?? "unknown",
			reason,
			exitCode: result.exitCode,
			durationMs,
		},
	};
}

async function handleApprove(
	pi: ExtensionAPI,
	runId?: string,
	comment?: string,
	cwd?: string,
	ctx?: ToolCtx,
): Promise<{
	content: { type: string; text: string }[];
	details: Record<string, unknown>;
	terminate?: boolean;
}> {
	if (!runId) {
		throw new Error("'runId' parameter is required for action='approve'");
	}

	const projectCwd = cwd || process.cwd();

	// Try to resolve the workflow name from active runs first
	let activeEntry = getActiveRuns().get(runId);
	let workflowName = activeEntry?.workflowName;

	// If not in active runs, check if this is an Archon UUID from a paused workflow
	if (!workflowName) {
		const pausedEntry = findPausedRun(runId);
		if (pausedEntry) {
			activeEntry = pausedEntry;
			workflowName = pausedEntry.workflowName;
		}
	}

	// If still not found, try querying the DB
	if (!workflowName) {
		try {
			const detail = await getRunDetail(runId);
			if (detail) {
				workflowName = detail.run.workflow_name;
			}
		} catch {
			// Best-effort
		}
	}

	// Launch in background if UI available
	if (ctx?.hasUI && ctx.ui && workflowName) {
		// Dismiss paused-run overlay if we found one (replaced by new approve overlay)
		activeEntry?.overlayHandle?.hide();

		const localRunId = await approveWorkflowBackground(
			pi,
			runId,
			workflowName,
			comment,
			ctx as never,
		);
		if (localRunId) {
			return {
				content: [
					{
						type: "text",
						text:
							`Workflow **${workflowName}** (${runId}) approved${comment ? `: ${comment}` : ""}. ` +
							`Auto-resuming in background. The result will be delivered automatically.`,
					},
				],
				details: {
					action: "approve",
					runId,
					workflow: workflowName,
					comment: comment ?? undefined,
				},
				terminate: false,
			};
		}
	}

	// Fallback: synchronous CLI execution (no UI)
	const { runArchonCommand } = await import("./archon-exec");
	const startedAt = Date.now();

	// Use archon workflow approve <runId> [comment] directly.
	// The CLI handles both approval and execution in the same process.
	const cliArgs: string[] = ["workflow", "approve", runId, "--no-worktree"];
	if (comment) {
		cliArgs.push(comment);
	}
	const result = await runArchonCommand(pi, cliArgs, projectCwd);
	const durationMs = Date.now() - startedAt;
	const success = result.exitCode === 0;

	return {
		content: [
			{
				type: "text",
				text: [
					`## Approve Result — ${runId}`,
					"",
					`- **Status:** ${success ? "✅ approved" : "❌ failed"}`,
					`- **Duration:** ${Math.round(durationMs / 1000)}s`,
					comment ? `- **Comment:** ${comment}` : "",
					result.exitCode !== 0 && result.stderr
						? `- **Error:** ${result.stderr.slice(0, 500)}`
						: "",
					result.stdout
						? `\`\`\`text\n${result.stdout.slice(0, 1000)}\n\`\`\``
						: "",
				]
					.filter(Boolean)
					.join("\n"),
			},
		],
		details: {
			action: "approve",
			runId,
			workflow: workflowName ?? "unknown",
			comment: comment ?? undefined,
			exitCode: result.exitCode,
			durationMs,
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
