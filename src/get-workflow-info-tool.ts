/**
 * get_workflow_info tool — returns detailed workflow definitions for the AI agent.
 *
 * The AI agent uses this tool to:
 * 1. Discover available workflows with names + descriptions (list mode)
 * 2. Get full workflow definition including node DAG, conditions, and config (info mode)
 *
 * This is complementary to archon_workflow (which runs/cancels workflows) —
 * this tool is read-only and focuses on workflow discovery and inspection.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "typebox";
import {
	listWorkflowsWithDetails,
	getWorkflowInfo,
	type WorkflowInfo,
	type WorkflowDetail,
} from "./archon-api";
import { readProjectWorkflowNamesFromDisk } from "./workflow-discovery";
import { fmtElapsed } from "./ui/workflow-overlay";

// StringEnum — local TypeBox helper (StringEnum not available from pi-ai)
function StringEnum<T extends readonly string[]>(
	values: T,
	options?: Record<string, unknown>,
) {
	return Type.Union(
		values.map((v) => Type.Literal(v)),
		options as unknown as undefined,
	);
}

// ── Tool registration ────────────────────────────────────────

export function registerGetWorkflowInfoTool(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "get_workflow_info",
		label: "Get Workflow Info",
		description:
			"Discover and inspect Archon YAML workflows. Use 'list' to see all available " +
			"workflows with names and descriptions, or 'info' to get the full definition " +
			"of a specific workflow including its DAG nodes, conditions, and configuration. " +
			"This is a read-only tool — use archon_workflow to actually run workflows.",
		promptSnippet: "Get info about Archon workflows",
		promptGuidelines: [
			"Use get_workflow_info with action='list' to discover available workflows and their descriptions before choosing which one to run.",
			"Use get_workflow_info with action='info' to inspect a specific workflow's DAG structure, node types, conditions, and configuration.",
			"Workflow descriptions contain trigger phrases (e.g. 'Use when: User wants to build a complete application') — use these to match user requests to the right workflow.",
			"After finding the right workflow, use archon_workflow with action='run' to launch it.",
		],
		parameters: Type.Object({
			action: StringEnum(["list", "info"] as const, {
				description:
					"Action: 'list' to discover all workflows with descriptions, 'info' to get full definition of a specific workflow",
			}),
			workflow: Type.Optional(
				Type.String({
					description:
						"Workflow name (required for 'info' action). Use 'list' first to discover available names.",
				}),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const { action, workflow } = params;
			const cwd = ctx?.cwd || process.cwd();

			switch (action) {
				case "list":
					return await handleList(cwd);
				case "info":
					return await handleInfo(workflow, cwd);
				default:
					throw new Error(`Unknown action: ${action}`);
			}
		},
		renderCall(args, theme, context) {
			const action = args.action ?? "unknown";
			const target = args.workflow ?? "";

			const parts =
				action === "list"
					? [theme.fg("accent", "◆ workflow list")]
					: [
							theme.fg("accent", `◆ workflow info`) +
								(target ? ` ${theme.bold(target)}` : ""),
						];
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

			if (action === "list") {
				const workflows = details?.workflows as WorkflowInfo[] | undefined;
				const count = workflows?.length ?? 0;
				lines = [
					theme.fg("accent", `◆ ${count} workflow(s) available`),
					...(workflows
						?.slice(0, 10)
						.map(
							(w: WorkflowInfo) =>
								`  ${theme.bold(w.name)} ${theme.fg("dim", `[${w.source}]`)}${w.model ? theme.fg("dim", ` ${w.model}`) : ""}`,
						) ?? []),
					...(count > 10
						? [theme.fg("dim", `  … and ${count - 10} more`)]
						: []),
				];
			} else if (action === "info") {
				const name = String(details?.name ?? "");
				const nodeCount = Number(details?.nodeCount ?? 0);
				lines = [
					theme.fg("accent", `◆ ${name}`) +
						theme.fg("dim", ` · ${nodeCount} nodes`),
					theme.fg(
						"dim",
						`  ${String(details?.description ?? "").slice(0, 100)}`,
					),
				];
			} else {
				lines = [theme.fg("dim", contentText.slice(0, 200))];
			}

			const text = context.lastComponent ?? new Text("", 0, 0);
			text.setText(lines.join("\n"));
			return text;
		},
	});
}

// ── Action handlers ──────────────────────────────────────────

async function handleList(cwd: string): Promise<{
	content: { type: string; text: string }[];
	details: Record<string, unknown>;
}> {
	// Try REST API first (rich data with descriptions)
	const apiWorkflows = await listWorkflowsWithDetails(cwd);

	if (apiWorkflows && apiWorkflows.length > 0) {
		const lines = [`## Available Workflows (${apiWorkflows.length})`, ""];

		// Group by source
		const bySource = new Map<string, WorkflowInfo[]>();
		for (const w of apiWorkflows) {
			const group = bySource.get(w.source) ?? [];
			group.push(w);
			bySource.set(w.source, group);
		}

		const sourceOrder: string[] = ["project", "global", "bundled"];
		const sourceLabels: Record<string, string> = {
			project: "Project",
			global: "Global",
			bundled: "Bundled",
		};

		for (const source of sourceOrder) {
			const group = bySource.get(source);
			if (!group || group.length === 0) continue;

			lines.push(`### ${sourceLabels[source] ?? source} (${group.length})`);
			lines.push("");

			for (const w of group) {
				const desc = w.description
					.split("\n")[0] // First line only
					.replace(/^Use when:\s*/i, "") // Strip "Use when:" prefix for brevity
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

	// Fallback: read names from disk (no descriptions available)
	const names = readProjectWorkflowNamesFromDisk(cwd);
	const lines = [
		`## Available Workflows (${names.length})`,
		"",
		"_Descriptions unavailable — Archon server not running. Start with `archon serve` for rich workflow info._",
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

	// Try REST API
	const detail = await getWorkflowInfo(workflow, cwd);

	if (!detail) {
		return {
			content: [
				{
					type: "text",
					text: [
						`## Workflow: \`${workflow}\``,
						"",
						"Workflow not found or Archon server not running.",
						"Start the server with `archon serve` for detailed workflow info.",
						"",
						`Check available workflows with \`get_workflow_info(action="list")\`.`,
					].join("\n"),
				},
			],
			details: {
				action: "info",
				name: workflow,
				found: false,
			},
		};
	}

	const lines = [
		`## Workflow: \`${detail.name}\``,
		"",
		`- **Source:** ${detail.source}`,
		`- **Description:** ${detail.description}`,
	];

	if (detail.provider) lines.push(`- **Provider:** ${detail.provider}`);
	if (detail.model) lines.push(`- **Model:** ${detail.model}`);
	if (detail.interactive != null)
		lines.push(`- **Interactive:** ${detail.interactive}`);
	if (detail.worktree?.enabled != null)
		lines.push(`- **Worktree:** ${detail.worktree.enabled}`);
	if (detail.nodeCount != null) lines.push(`- **Nodes:** ${detail.nodeCount}`);

	lines.push("");

	// Render DAG nodes
	if (detail.nodes.length > 0) {
		lines.push("### Nodes");
		lines.push("");

		for (const node of detail.nodes) {
			const deps = node.dependsOn?.length
				? ` ← ${node.dependsOn.join(", ")}`
				: "";
			const when = node.when ? ` (when: ${node.when})` : "";
			const trigger = node.triggerRule ? ` [${node.triggerRule}]` : "";
			const desc = node.description
				? ` — ${node.description.split("\n")[0]}`
				: "";

			lines.push(
				`- **\`${node.id}\`** [\`${node.type}\`]${deps}${when}${trigger}${desc}`,
			);
		}

		lines.push("");
	}

	return {
		content: [{ type: "text", text: lines.join("\n") }],
		details: {
			action: "info",
			name: detail.name,
			description: detail.description,
			source: detail.source,
			provider: detail.provider,
			model: detail.model,
			nodeCount: detail.nodeCount,
			interactive: detail.interactive,
			nodes: detail.nodes,
		},
	};
}
