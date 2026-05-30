/**
 * Workflow operations — extracted from the old manage-runtime handler.
 *
 Provides the core workflow control functions used by both the /archons
 * dashboard and the archon_workflow tool.
 */
import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import * as fs from "node:fs";
import { ARCHON_ROOT } from "./constants";
import { safeCode } from "./output-filter";
import { runArchonCommand } from "./archon-exec";

// ── Types ────────────────────────────────────────────────────

export type ArchonWorkflowStatusRow = {
  id: string;
  workflow_name: string;
  working_path?: string | null;
  status: string;
  started_at: string;
};

export type ArchonWorkflowStatusJson = {
  runs: ArchonWorkflowStatusRow[];
};

// ── Internal helpers ─────────────────────────────────────────

function archonRootStatus(): string {
  return `\`${safeCode(ARCHON_ROOT)}\` ${fs.existsSync(`${ARCHON_ROOT}/package.json`) ? "(found)" : "(missing)"}`;
}

function listProjectFiles(dir: string, suffix: string): string[] {
  return fs.existsSync(dir)
    ? fs.readdirSync(dir).filter((name) => name.endsWith(suffix)).sort()
    : [];
}

function formatBulletList(
  values: string[],
  map: (value: string) => string = (value) => value,
): string {
  if (values.length === 0) return "*(none)*";
  return values.map(map).join(", ");
}

function parseWorkflowStatusJson(
  stdout: string,
  rawErr: string,
): ArchonWorkflowStatusJson {
  const combined = `${stdout}\n${rawErr}`.trim();
  if (!combined) return { runs: [] };
  for (const line of combined.split(/\r?\n/)) {
    const candidate = line.trim();
    if (!candidate.startsWith("{")) continue;
    try {
      const payload = JSON.parse(candidate) as ArchonWorkflowStatusJson;
      if (Array.isArray(payload.runs)) return payload;
    } catch { /* next line */ }
  }
  return { runs: [] };
}

function renderWorkflowStatus(
  projectRoot: string,
  runs: ArchonWorkflowStatusRow[],
): string {
  const lines: string[] = ["## Archon Workflow Status", ""];
  lines.push(`- **Project:** \`${safeCode(projectRoot)}\``);
  lines.push(`- **Archon root:** ${archonRootStatus()}`);

  const workflowDir = `${projectRoot}/.archon/workflows`;
  const agentDir = `${projectRoot}/.pi/agents`;
  const workflows = listProjectFiles(workflowDir, ".yaml");
  const agents = listProjectFiles(agentDir, ".md");

  lines.push(`- **Workflows:** ${formatBulletList(workflows)}`);
  lines.push(
    `  - **Agents:** ${formatBulletList(agents, (agent) => agent.replace(/\.md$/, ""))}`,
  );

  if (runs.length === 0) {
    lines.push("- **Active runs:** *(none)*");
  } else {
    lines.push(`- **Active runs:** ${runs.length}`);
    for (const run of runs) {
      const age = formatTimeAgo(run.started_at);
      lines.push(
        `  - \`${safeCode(run.id.slice(0, 8))}\` **${run.workflow_name}** — ${run.status} · ${age}`,
      );
    }
  }
  lines.push("");
  return lines.join("\n");
}

function formatTimeAgo(isoDate: string): string {
  try {
    const ms = Date.now() - Date.parse(isoDate);
    if (ms < 60_000) return "just now";
    if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`;
    if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`;
    return `${Math.floor(ms / 86_400_000)}d ago`;
  } catch {
    return isoDate;
  }
}

// ── Public API ───────────────────────────────────────────────

/** Query `archon workflow status --json` and render the result. */
export async function handleArchonStatusCommand(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
): Promise<void> {
  const projectRoot = ctx.cwd || process.cwd();
  try {
    const run = await runArchonCommand(
      pi,
      ["workflow", "status", "--json"],
      projectRoot,
    );
    if (run.exitCode !== 0)
      throw new Error(run.stderr || run.stdout || `exit ${run.exitCode}`);
    const parsed = parseWorkflowStatusJson(run.stdout || "", run.stderr || "");
    // Import showArchonOverlay lazily to avoid circular deps at module level
    const { showArchonOverlay } = await import("./ui/archon-overlay");
    await showArchonOverlay(pi, ctx, renderWorkflowStatus(projectRoot, parsed.runs ?? []), {
      title: "Workflow Status",
      details: { action: "workflow_status", runs: parsed.runs?.length ?? 0 },
    });
  } catch (error) {
    const workflowDir = `${projectRoot}/.archon/workflows`;
    const agentDir = `${projectRoot}/.pi/agents`;
    const workflows = listProjectFiles(workflowDir, ".yaml");
    const agents = listProjectFiles(agentDir, ".md");
    const { showArchonOverlay } = await import("./ui/archon-overlay");
    await showArchonOverlay(
      pi,
      ctx,
      [
        "## Archon Workflow Status",
        "",
        `- **Project:** \`${safeCode(projectRoot)}\``,
        `- **Archon root:** ${archonRootStatus()}`,
        `- **Workflows:** ${formatBulletList(workflows)}`,
        `  - **Agents:** ${formatBulletList(agents, (agent) => agent.replace(/\.md$/, ""))}`,
        `- **Workflow DB status:** failed to query (${safeCode(String(error instanceof Error ? error.message : error))})`,
        "",
      ].join("\n"),
      { title: "Workflow Status", details: {} },
    );
  }
}

/** Cancel a workflow run via `archon workflow abandon <runId>`. */
export async function cancelArchonWorkflowRun(
  pi: ExtensionAPI,
  runId: string,
  projectRoot: string,
): Promise<void> {
  const run = await runArchonCommand(
    pi,
    ["workflow", "abandon", runId],
    projectRoot,
  );
  if (run.exitCode !== 0)
    throw new Error(run.stderr || run.stdout || `exit ${run.exitCode}`);
}

/** Find the most recent running workflow run ID for a given workflow name. */
export async function findActiveWorkflowRunId(
  pi: ExtensionAPI,
  projectRoot: string,
  workflowName: string,
): Promise<string | undefined> {
  const run = await runArchonCommand(
    pi,
    ["workflow", "status", "--json"],
    projectRoot,
  );
  if (run.exitCode !== 0)
    throw new Error(run.stderr || run.stdout || `exit ${run.exitCode}`);
  const parsed = parseWorkflowStatusJson(run.stdout || "", run.stderr || "");
  const candidates = (parsed.runs ?? []).filter(
    (entry) =>
      (entry.working_path ?? "") === projectRoot &&
      entry.workflow_name === workflowName &&
      entry.status.toLowerCase() === "running",
  );
  const newest = candidates.sort(
    (a, b) => Date.parse(b.started_at) - Date.parse(a.started_at),
  )[0];
  return newest?.id;
}
