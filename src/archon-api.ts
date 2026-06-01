/**
 * Archon REST API client — queries the Archon Web server for
 * workflow run details, node output, and conversation messages.
 *
 * The Archon Web server (localhost:3090) exposes a REST API that
 * provides much richer observability data than the CLI's stderr:
 *   - Full node_output for each completed node
 *   - Tool call metadata (name, input, output, duration)
 *   - Conversation messages with structured metadata
 *   - Workflow run status with node counts and cost
 *
 * This module is used by the WorkflowOverlay and /archons dashboard
 * to show node logs/output that the CLI doesn't render to stderr.
 *
 * Fallback: if the server isn't running, gracefully returns empty data.
 */

import { ARCHON_DB_PATH } from "./constants";

// ── Types ────────────────────────────────────────────────────

export interface ArchonApiRunEvent {
	id: string;
	workflow_run_id: string;
	event_type: string;
	step_index: number | null;
	step_name: string | null;
	data: Record<string, unknown>;
	created_at: string;
}

export interface ArchonApiRunDetail {
	run: {
		id: string;
		conversation_id: string;
		workflow_name: string;
		status: string;
		working_path: string | null;
		started_at: string;
		completed_at: string | null;
		metadata: {
			node_counts?: {
				completed: number;
				failed: number;
				skipped: number;
				total: number;
			};
			total_cost_usd?: number;
		};
		/** Platform conversation ID (e.g. 'cli-1780306933204-bvijtl')
		 *  Used for SSE streaming of AI text + tool calls. */
		conversation_platform_id: string | null;
		/** Worker platform conversation ID (for Web runs with separate worker).
		 *  CLI runs have this as null — the parent conversation IS the worker. */
		worker_platform_id?: string | null;
		/** Parent platform conversation ID (the conversation that dispatched this workflow). */
		parent_platform_id?: string | null;
	};
	events: ArchonApiRunEvent[];
}

export interface ArchonApiMessage {
	id: string;
	conversation_id: string;
	role: string;
	content: string;
	metadata: string;
	created_at: string;
}

export interface NodeOutputInfo {
	nodeId: string;
	nodeType?: string;
	provider?: string;
	output?: string;
	durationMs?: number;
	costUsd?: number;
	stopReason?: string;
	numTurns?: number;
	error?: string;
}

// ── Config ───────────────────────────────────────────────────

const ARCHON_API_BASE = `http://127.0.0.1:3090`;
const API_TIMEOUT_MS = 5000;

// ── Internal fetch helper ────────────────────────────────────

async function apiFetch<T>(path: string): Promise<T | undefined> {
	try {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), API_TIMEOUT_MS);
		const res = await fetch(`${ARCHON_API_BASE}${path}`, {
			signal: controller.signal,
		});
		clearTimeout(timer);
		if (!res.ok) return undefined;
		return (await res.json()) as T;
	} catch {
		return undefined;
	}
}

// ── Public API ───────────────────────────────────────────────

/**
 * Get full run detail from the Archon REST API.
 * Returns undefined if the server is not running or the run doesn't exist.
 */
export async function getRunDetail(
	runId: string,
): Promise<ArchonApiRunDetail | undefined> {
	return apiFetch<ArchonApiRunDetail>(
		`/api/workflows/runs/${encodeURIComponent(runId)}`,
	);
}

/**
 * Extract node output data from a run detail's events.
 * Each node_completed event carries node_output in its data.
 */
export function extractNodeOutputs(
	runDetail: ArchonApiRunDetail,
): NodeOutputInfo[] {
	const outputs: NodeOutputInfo[] = [];
	const events = runDetail.events ?? [];

	// Build a map: nodeId → node_started data (type, provider)
	const startedData = new Map<string, Record<string, unknown>>();
	for (const ev of events) {
		if (ev.event_type === "node_started" && ev.step_name) {
			startedData.set(ev.step_name, ev.data);
		}
	}

	for (const ev of events) {
		if (ev.event_type === "node_completed" && ev.step_name) {
			const startedInfo = startedData.get(ev.step_name) ?? {};
			outputs.push({
				nodeId: ev.step_name,
				nodeType: (ev.data.type as string) ?? (startedInfo.type as string),
				provider: (startedInfo.provider as string) ?? undefined,
				output: (ev.data.node_output as string) ?? undefined,
				durationMs: (ev.data.duration_ms as number) ?? undefined,
				costUsd: (ev.data.cost_usd as number) ?? undefined,
				stopReason: (ev.data.stop_reason as string) ?? undefined,
				numTurns: (ev.data.num_turns as number) ?? undefined,
			});
		}
		if (ev.event_type === "node_failed" && ev.step_name) {
			outputs.push({
				nodeId: ev.step_name,
				nodeType: (startedData.get(ev.step_name)?.type as string) ?? undefined,
				error: (ev.data.error as string) ?? "Node failed",
			});
		}
	}

	return outputs;
}

/**
 * Get conversation messages from the Archon REST API.
 * Uses the platform conversation ID (e.g., "cli-1780292888619-7083ms").
 */
export async function getConversationMessages(
	platformConversationId: string,
	limit = 50,
): Promise<ArchonApiMessage[] | undefined> {
	return apiFetch<ArchonApiMessage[]>(
		`/api/conversations/${encodeURIComponent(platformConversationId)}/messages?limit=${limit}`,
	);
}

/**
 * Get node outputs for a specific run ID by querying the API.
 * This is the primary method for getting node_output data that
 * the CLI doesn't render to stderr.
 */
export async function queryNodeOutputs(
	runId: string,
): Promise<NodeOutputInfo[]> {
	const detail = await getRunDetail(runId);
	if (!detail) return [];
	return extractNodeOutputs(detail);
}

/**
 * Find the most recent run ID for a workflow name.
 * Checks DB first (fast), falls back to API if DB unavailable.
 */
export async function findLatestRunIdForWorkflow(
	workflowName: string,
	workingPath?: string,
): Promise<string | undefined> {
	// Try DB first
	try {
		const { execSync } = await import("child_process");
		const dbPath = ARCHON_DB_PATH;
		const whereClause = workingPath
			? `workflow_name = '${workflowName.replace(/'/g, "''")}' AND working_path = '${workingPath.replace(/'/g, "''")}'`
			: `workflow_name = '${workflowName.replace(/'/g, "''")}'`;
		const cmd = `sqlite3 "${dbPath}" "SELECT id FROM remote_agent_workflow_runs WHERE ${whereClause} ORDER BY started_at DESC LIMIT 1;" -json`;
		const result = execSync(cmd, { timeout: 3000, encoding: "utf-8" });
		const rows = JSON.parse(result.trim()) as Array<{ id: string }>;
		if (rows.length > 0) return rows[0].id;
	} catch {
		// DB unavailable — fall through to API
	}

	// Try API
	try {
		const runs = await apiFetch<
			Array<{ id: string; workflow_name: string; working_path?: string }>
		>(`/api/dashboard/runs?limit=20`);
		if (!runs) return undefined;
		const match = runs.find(
			(r) =>
				r.workflow_name === workflowName &&
				(!workingPath || r.working_path === workingPath),
		);
		return match?.id;
	} catch {
		return undefined;
	}
}

// ── Workflow discovery types ──────────────────────────────────

export interface WorkflowInfo {
	name: string;
	description: string;
	source: "project" | "bundled" | "global";
	provider?: string;
	model?: string;
	nodeCount?: number;
}

export interface WorkflowDetail extends WorkflowInfo {
	nodes: WorkflowNodeInfo[];
	interactive?: boolean;
	worktree?: { enabled?: boolean };
}

export interface WorkflowNodeInfo {
	id: string;
	type: string;
	description?: string;
	dependsOn?: string[];
	when?: string;
	triggerRule?: string;
}

// ── Workflow discovery API ────────────────────────────────────

interface ApiWorkflowEntry {
	workflow: {
		name: string;
		description: string;
		provider?: string;
		model?: string;
		nodes?: Array<{
			id?: string;
			type?: string;
			description?: string;
			dependsOn?: string[];
			when?: string;
			trigger_rule?: string;
		}>;
		interactive?: boolean;
		worktree?: { enabled?: boolean };
	};
	source: "project" | "bundled" | "global";
}

interface ApiWorkflowListResponse {
	workflows: ApiWorkflowEntry[];
	errors?: Array<{ filename: string; error: string }>;
}

interface ApiWorkflowGetResponse {
	workflow: ApiWorkflowEntry["workflow"];
	filename: string;
	source: ApiWorkflowEntry["source"];
}

/**
 * List all available workflows with name + description from the Archon REST API.
 * Returns undefined if the server is not running.
 */
export async function listWorkflowsWithDetails(
	projectCwd?: string,
): Promise<WorkflowInfo[] | undefined> {
	const query = projectCwd ? `?cwd=${encodeURIComponent(projectCwd)}` : "";
	const result = await apiFetch<ApiWorkflowListResponse>(
		`/api/workflows${query}`,
	);
	if (!result) return undefined;
	if (!Array.isArray(result.workflows)) return undefined;

	return result.workflows.map((entry) => ({
		name: entry.workflow.name,
		description: entry.workflow.description,
		source: entry.source,
		provider: entry.workflow.provider,
		model: entry.workflow.model,
		nodeCount: entry.workflow.nodes?.length,
	}));
}

/**
 * Get full details for a specific workflow by name from the Archon REST API.
 * Returns undefined if the server is not running or the workflow doesn't exist.
 */
export async function getWorkflowInfo(
	name: string,
	projectCwd?: string,
): Promise<WorkflowDetail | undefined> {
	const query = projectCwd ? `?cwd=${encodeURIComponent(projectCwd)}` : "";
	const result = await apiFetch<ApiWorkflowGetResponse>(
		`/api/workflows/${encodeURIComponent(name)}${query}`,
	);
	if (!result || !result.workflow) return undefined;

	return {
		name: result.workflow.name,
		description: result.workflow.description,
		source: result.source,
		provider: result.workflow.provider,
		model: result.workflow.model,
		nodeCount: result.workflow.nodes?.length,
		nodes: (result.workflow.nodes ?? []).map((n) => ({
			id: n.id ?? "unknown",
			type: n.type ?? "unknown",
			description: n.description,
			dependsOn: n.dependsOn,
			when: n.when,
			triggerRule: n.trigger_rule,
		})),
		interactive: result.workflow.interactive,
		worktree: result.workflow.worktree,
	};
}

/**
 * Check if the Archon Web server is reachable.
 */
export async function isArchonServerRunning(): Promise<boolean> {
	try {
		const result = await apiFetch<{ status: string }>("/api/health");
		return result?.status === "ok";
	} catch {
		return false;
	}
}
