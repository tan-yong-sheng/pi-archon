# pi-archon: Unified `/archons` Dashboard + Tool + Skill

## Architecture

Three surfaces, each optimized for its consumer:

| Surface | Consumer | Purpose |
|---------|----------|---------|
| `/archons` dashboard | **Human** | Interactive TUI — launch, monitor, inspect, cancel workflows |
| `archon_workflow` tool | **AI agent** | Programmatic access — run, list, status, cancel |
| Archon skill | **AI agent** | Knowledge — author workflows, commands, config in `.archon/` |

## What's Being Removed

- `/archon` command (all subcommands: workflow run/history, manage, server, web, update, help)
- `/archon` autocomplete and command-tree routing
- `POST /archon` route with schema-based tool dispatch
- Related handler/command infrastructure for server, web, manage, update

These CLI-equivalent operations are better run directly in the terminal.

## What's Being Built

### 1. Unified `/archons` Dashboard

A Claude Code `/workflows`-equivalent with three-level drill-down:

**Level 1 — Run List (home view)**
- Sections: **Active** (live runs) → **Recent** (history from DB)
- Each row: status icon + workflow name + summary + elapsed time
- Dispatch input at bottom to launch new workflows
- Keyboard: ↑/↓ select, Enter drill into run, Esc close, 'r' run new workflow

**Level 2 — Run Detail**
- Header: workflow name + status + total duration + query preview
- Node list grouped by state: **Running** → **Pending** → **Completed** → **Failed/Skipped**
- Each node: state icon + name + duration + iteration badge + active tool
- Artifacts section (from DB query)
- Keyboard: ↑/↓ select, Enter drill into node, Esc back, 'x' cancel run

**Level 3 — Node Detail**
- Node type, command/prompt text, duration, output/error
- Loop iterations (if loop node): iteration count, current/max
- Approval status (if approval node): message, approve/reject
- Keyboard: Esc back, 'a' approve (if approval), 'r' reject (if approval)

**Dispatch input (from Level 1)**
- Type a workflow name + query → launches workflow in background
- Autocomplete from `.archon/workflows/` names
- Example: `archon-hello test the pipeline` → runs archon-hello with "test the pipeline"

### 2. `archon_workflow` Tool

Single tool registered via `pi.registerTool`:

```
archon_workflow(action: "run" | "list" | "status" | "cancel", workflow?: string, query?: string, runId?: string)
```

| Action | Parameters | Returns |
|--------|-----------|---------|
| `run` | workflow, query | Launches workflow, returns run ID + final result |
| `list` | (none) | Available workflows in `.archon/workflows/` |
| `status` | (runId optional) | Active/recent run status with node states |
| `cancel` | runId | Cancels running workflow |

**Tool behavior:**
- `run`: calls `runWorkflowBackground()`, polls until completion, returns structured result
- `list`: reads `.archon/workflows/` names (disk fallback, no CLI call)
- `status`: queries active runs + DB for recent, returns JSON
- `cancel`: calls `cancelRun()` + Archon CLI abandon

**renderCall**: compact one-liner showing action + workflow name
**renderResult**: structured card with node states, artifacts, duration

### 3. Archon Skill

A `.pi/skills/archon/SKILL.md` (or project-local `.pi/skills/`) that teaches the agent:

- **Workflow YAML schema**: node types (command, prompt, bash, script, loop, approval, cancel)
- **Conditional logic**: `when` expressions (==, !=, <, >, &&, ||), `trigger_rule` (all_success, one_success, none_failed_min_one_success, all_done)
- **Structured output**: `output_format` with JSON Schema, `$nodeId.output.field` references
- **Approval gates**: approval nodes with `on_reject`, `capture_response`, `max_attempts`
- **Command authoring**: `.archon/commands/*.md` format
- **Config options**: `.archon/config.yaml` fields
- **Workflow patterns**: sequential, fan-out, verify-refute, iterative loop, conditional branching
- **Variables**: $ARGUMENTS, $ARTIFACTS_DIR, $BASE_BRANCH, $WORKFLOW_ID, $nodeId.output

This enables the agent to **dynamically author workflows** for the current task.

## Implementation Tasks

### Task 0: Remove `/archon` command and route infrastructure
- Remove `/archon` command registration from index.ts
- Remove `POST /archon` route from archon-routes.ts
- Remove archon-dispatch.ts (tool dispatch, handleCliFallback, archonToolBlocked)
- Remove commands/ directory (base.ts, manage.ts, runtime.ts, server.ts, web.ts, workflow.ts, defs.ts, index.ts)
- Remove handlers/ directory (base.ts, registry.ts, manage-*.ts, server-*.ts, web-*.ts, update-*.ts, runtime-command.ts, workflow-command.ts)
- Remove command-tree.ts (resolveTokens, registerCliRoutes, buildCompletions, buildContextCompletions)
- Remove archon-routes.ts (registerCliRoutes, registerArchonTools)
- Clean up barrel exports in archon.ts and index.ts
- Keep: workflow-background.ts, workflow-discovery.ts, archon-exec.ts, artifact-query.ts, dag-tracker.ts, output-filter.ts, config.ts, constants.ts, helpers.ts, git-util.ts, types.d.ts, pi-host-shims.d.ts
- Typecheck

### Task 1: Build unified `/archons` dashboard with 3-level drill-down
- Rewrite `archons-command.ts` with the new dashboard architecture
- Level 1: Active + Recent sections with dispatch input
- Level 2: Run detail with grouped nodes + artifacts
- Level 3: Node detail with type, output, error, loop info
- Dispatch input: type workflow name → autocomplete → Enter to launch
- Keyboard: ↑/↓ navigate, Enter drill-in, Esc back/close, 'x' cancel, 'r' run new
- Integrate `queryRecentRuns`, `queryRunArtifacts`, `queryRunNodeSummaries` from artifact-query.ts
- Typecheck

### Task 2: Register `archon_workflow` tool
- New file: `src/archon-workflow-tool.ts`
- Register via `pi.registerTool()` with TypeBox schema
- Actions: run, list, status, cancel
- `run` action: calls `runWorkflowBackground()`, returns structured result
- `list` action: reads `.archon/workflows/` from disk
- `status` action: combines activeRuns + DB query
- `cancel` action: calls `cancelRun()` + Archon CLI abandon
- Custom renderCall: compact one-liner with action + workflow
- Custom renderResult: structured card with node states, artifacts, duration
- Register in index.ts
- Typecheck

### Task 3: Create Archon skill
- New file: `skills/archon/SKILL.md` (or `.pi/skills/archon/SKILL.md`)
- Covers: workflow YAML schema, node types, when conditions, trigger_rule, output_format, approval gates, command authoring, config options, workflow patterns, variables
- Triggers: "create workflow", "author workflow", "archon workflow", "run archon"
- Register in index.ts or as a standalone skill file
- Typecheck

### Task 4: Cleanup, verification, and commit
- Remove dead code (emitArchonMessage if unused, old command/handler imports)
- Verify tsc --noEmit passes cleanly
- Verify npm test passes
- Git commit with descriptive message
- Tag

## Files Changed (estimated)

### Remove
- `src/archon-dispatch.ts`
- `src/archon-routes.ts`
- `src/archon-ui.ts`
- `src/command-tree.ts`
- `src/commands/` (entire directory)
- `src/handlers/` (entire directory)
- `src/ui/progress-runner.ts` (phase pipeline TUI — only used by old /archon commands)
- `src/ui/run-box.ts` (streaming run box — only used by old /archon commands)

### New
- `src/archon-workflow-tool.ts`
- `skills/archon/SKILL.md`

### Major rewrite
- `src/archons-command.ts` → unified dashboard
- `src/index.ts` → remove /archon registration, add tool registration

### Minor updates
- `src/archon.ts` → update barrel exports
- `src/types.d.ts` → add tool-related types
- `src/workflow-background.ts` → export for tool use
- `src/workflow-discovery.ts` → export for tool use
