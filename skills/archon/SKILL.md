# Archon Workflow Authoring Skill

Create, modify, and run Archon YAML workflows in the project's `.archon/` directory.

## When to Use

- User asks to "create a workflow", "author a workflow", "automate with Archon", "run an Archon workflow"
- User describes a multi-step process that could be orchestrated as a DAG
- User wants to parallelize AI work (codebase audits, migrations, security scans)
- User asks about `.archon/` directory structure or workflow YAML syntax

## `.archon/` Directory Structure

```
.archon/
├── config.yaml          # Project configuration (optional)
├── .env                 # Environment variables (NEVER commit)
├── commands/            # Reusable prompt templates (.md)
│   └── my-command.md
├── workflows/           # Workflow DAG definitions (.yaml)
│   └── my-workflow.yaml
├── scripts/             # TypeScript/Python scripts (.ts, .js, .py)
│   └── helper.ts
├── state/               # Runtime state (gitignored)
└── mcp/                 # MCP server configs (optional)
    └── servers.json
```

## `config.yaml` Options

```yaml
assistant: claude          # AI provider (claude, openai, etc.)
worktree:
  baseBranch: main         # Branch for worktree isolation
  copyFiles:              # Git-ignored files to copy into worktrees
    - .env.local
defaults:
  loadDefaultCommands: true    # Include bundled commands (default: true)
  loadDefaultWorkflows: true   # Include bundled workflows (default: true)
```

## Workflow YAML Schema

A workflow is a **Directed Acyclic Graph (DAG)** — an array of nodes with `depends_on` edges.

```yaml
name: my-workflow
description: What this workflow does
tags: [audit, security]
mutates_checkout: false     # true if workflow edits files

nodes:
  - id: scan
    prompt: "Scan for security issues..."
    depends_on: []

  - id: verify
    prompt: "Verify these findings: $scan.output"
    when: "$scan.output.issue_count > '0'"
    depends_on: [scan]

  - id: report
    command: write-report
    trigger_rule: none_failed_min_one_success
    depends_on: [scan, verify]
```

## Node Types

Each node has **exactly one** type-defining field. Common fields: `id`, `depends_on`, `when`, `trigger_rule`.

### `command` — Reusable prompt from `.archon/commands/`

```yaml
- id: my-task
  command: my-command        # Loads .archon/commands/my-command.md
  model: claude              # Override model (optional)
  provider: anthropic        # Override provider (optional)
  output_format:             # JSON Schema for structured output
    type: object
    properties:
      issue_type:
        type: string
        enum: [bug, feature, security]
      severity:
        type: string
        enum: [low, medium, high, critical]
    required: [issue_type, severity]
  allowed_tools: [bash, read, write]   # Restrict tools (optional)
  denied_tools: [rm]                   # Block specific tools (optional)
  effort: high              # Reasoning effort (optional)
  thinking: true            # Enable extended thinking (optional)
  maxBudgetUsd: 0.50       # Cost limit per node (optional)
```

### `prompt` — Inline AI prompt

```yaml
- id: analyze
  prompt: |
    Analyze the codebase for performance bottlenecks.
    Focus on: database queries, memory leaks, O(n²) algorithms.
    Return structured output with output_format.
  output_format:
    type: object
    properties:
      bottlenecks:
        type: array
        items:
          type: object
          properties:
            file: { type: string }
            line: { type: integer }
            severity: { type: string }
    required: [bottlenecks]
```

### `bash` — Shell script (no AI)

```yaml
- id: build
  bash: |
    #!/bin/bash
    npm run build 2>&1
  timeout: 120000       # Milliseconds (optional)
```

### `script` — TypeScript or Python (no AI)

```yaml
- id: transform
  script: |
    import pandas as pd
    df = pd.read_csv("$ARTIFACTS_DIR/input.csv")
    result = df.groupby("category").sum()
    result.to_csv("$ARTIFACTS_DIR/output.csv")
    print(result.to_string())
  runtime: uv           # Required: 'bun' or 'uv'
  deps: ["pandas"]      # Python dependencies (uv only)
  timeout: 30000        # Milliseconds (optional)
```

### `loop` — Iterate AI prompt until completion

```yaml
- id: iterate-fixes
  loop:
    prompt: |
      Fix the remaining issues from the scan results.
      Issues remaining: $ITERATION_REMAINING
      Previous attempt output: $PREVIOUS_OUTPUT
    until: COMPLETION_SIGNAL
    max_iterations: 10
    fresh_context: true       # Start fresh each iteration (optional)
    until_bash: "npm test"   # Run shell command to check completion (optional)
  depends_on: [scan]
```

### `approval` — Human gate (requires `interactive: true`)

```yaml
- id: review-plan
  approval:
    message: "Review the plan above. Approve to continue."
    capture_response: true    # Capture user's response text (optional)
  on_reject:                   # Optional: rework on rejection
    prompt: "Revise based on feedback: $REJECTION_REASON"
    max_attempts: 3
```

### `cancel` — Conditional early termination

```yaml
- id: cancel-unsafe
  cancel: "Refusing to proceed: input flagged UNSAFE."
  when: "$classify.output != 'SAFE'"
  depends_on: [classify]
```

## Conditional Logic

### `when` — Gate node execution on a condition

Skipped if condition evaluates to `false`. Fail-closed on parse errors.

```yaml
# String equality
when: "$nodeId.output == 'VALUE'"
when: "$nodeId.output != 'VALUE'"

# JSON field access (requires output_format on upstream node)
when: "$scan.output.issue_count > '10'"
when: "$scan.output.severity == 'critical'"

# Numeric comparison
when: "$score.output.confidence >= '0.9'"

# Compound expressions (&& binds tighter than ||, no parentheses)
when: "$a.output == 'X' && $b.output != 'Y'"
when: "$a.output == 'X' || $b.output == 'Y'"
when: "$a.output == 'X' && $b.output == 'Y' || $c.output == 'Z'"
```

### `trigger_rule` — Join semantics for multi-dependency nodes

Controls when a node fires based on upstream states:

| Rule | Behavior |
|------|----------|
| `all_success` | **Default.** All upstreams must complete successfully. Any fail/skip → this node skips. |
| `one_success` | At least one upstream succeeded. Skip only if all failed/skipped. |
| `none_failed_min_one_success` | No upstreams failed AND at least one succeeded. Skipped upstreams are OK. **Best for conditional branches.** |
| `all_done` | All upstreams in terminal state (completed/failed/skipped). Runs regardless of outcomes. |

**Pattern: conditional fan-in** — use `none_failed_min_one_success` when some upstream branches may be skipped:

```yaml
- id: plan
  prompt: "Plan the fix..."
  when: "$scan.output.issue_count > '0'"
  depends_on: [scan]

- id: skip-report
  prompt: "No issues found. Write a clean bill of health."
  when: "$scan.output.issue_count == '0'"
  depends_on: [scan]

- id: final-report
  command: write-report
  trigger_rule: none_failed_min_one_success
  depends_on: [plan, skip-report]
```

## Variables

| Variable | Description |
|----------|-------------|
| `$ARGUMENTS` | Query string passed to `archon workflow run <name> <query>` |
| `$ARTIFACTS_DIR` | Directory for workflow artifacts (auto-created) |
| `$BASE_BRANCH` | Git base branch from config |
| `$WORKFLOW_ID` | Current workflow run ID |
| `$nodeId.output` | Full output of upstream node (JSON string if output_format set) |
| `$nodeId.output.field` | Specific field from structured output (dot notation) |
| `$ITERATION_REMAINING` | Items remaining in loop iteration |
| `$PREVIOUS_OUTPUT` | Previous loop iteration output |
| `$REJECTION_REASON` | Human's rejection reason in approval on_reject |

## Workflow Patterns

### Sequential Pipeline

```yaml
nodes:
  - id: gather
    bash: "find src -name '*.ts' | head -20"
  - id: analyze
    prompt: "Analyze these files: $gather.output"
    depends_on: [gather]
  - id: report
    prompt: "Write a report based on: $analyze.output"
    depends_on: [analyze]
```

### Parallel Fan-Out

```yaml
nodes:
  - id: scan-security
    prompt: "Scan for security vulnerabilities..."
  - id: scan-performance
    prompt: "Scan for performance issues..."
  - id: scan-accessibility
    prompt: "Scan for accessibility issues..."
  # All three run in parallel (no depends_on between them)
  - id: synthesize
    prompt: |
      Combine findings from:
      Security: $scan-security.output
      Performance: $scan-performance.output
      Accessibility: $scan-accessibility.output
    depends_on: [scan-security, scan-performance, scan-accessibility]
```

### Verify-Refute (Adversarial Pattern)

```yaml
nodes:
  - id: claim
    prompt: "Make specific claims about the codebase..."
    output_format:
      type: object
      properties:
        claims:
          type: array
          items:
            type: object
            properties:
              claim: { type: string }
              evidence: { type: string }
              confidence: { type: number }

  - id: skeptic-1
    prompt: "Try to refute these claims: $claim.output"
    depends_on: [claim]

  - id: skeptic-2
    prompt: "Try to refute these claims: $claim.output"
    depends_on: [claim]

  - id: skeptic-3
    prompt: "Try to refute these claims: $claim.output"
    depends_on: [claim]

  - id: final
    prompt: |
      Only keep claims that survived all 3 skeptics.
      Claims: $claim.output
      Skeptic 1: $skeptic-1.output
      Skeptic 2: $skeptic-2.output
      Skeptic 3: $skeptic-3.output
    depends_on: [claim, skeptic-1, skeptic-2, skeptic-3]
```

### Conditional Branching

```yaml
nodes:
  - id: classify
    prompt: "Classify this input as SAFE or UNSAFE..."
    output_format:
      type: object
      properties:
        classification: { type: string, enum: [SAFE, UNSAFE] }
      required: [classification]

  - id: safe-path
    prompt: "Process the safe input..."
    when: "$classify.output.classification == 'SAFE'"
    depends_on: [classify]

  - id: unsafe-path
    cancel: "Input classified as UNSAFE. Stopping."
    when: "$classify.output.classification != 'SAFE'"
    depends_on: [classify]
```

### Iterative Loop Until Completion

```yaml
nodes:
  - id: fix-issues
    loop:
      prompt: |
        Fix the remaining test failures.
        Current failures: $ITERATION_REMAINING
        Previous attempt: $PREVIOUS_OUTPUT
      until: COMPLETION_SIGNAL
      max_iterations: 5
      until_bash: "npm test 2>&1"
    depends_on: [scan]
```

## Running Workflows

### Via `/archons` dashboard (interactive)
Type `/archons` to open the dashboard, select a workflow from the Launch section.

### Via `archon_workflow` tool (agent programmatic)
```
archon_workflow(action="run", workflow="my-workflow", query="focus on auth module")
```

### Via CLI (terminal)
```bash
archon workflow run my-workflow "focus on auth module"
```

## Commands (`.archon/commands/*.md`)

Commands are markdown prompt templates loaded by `command` nodes:

```markdown
# .archon/commands/my-command.md

You are a code auditor. Analyze the following files for security issues.

Focus areas:
- SQL injection
- XSS vulnerabilities
- Authentication bypasses

Arguments provided: $ARGUMENTS

Output your findings as structured JSON.
```

## Best Practices

1. **Use `output_format` for any downstream conditional logic** — ensures AI output is parseable by `when` expressions
2. **Use `trigger_rule: none_failed_min_one_success`** for fan-in after conditional branches
3. **Set `max_iterations` on loops** — prevents infinite iteration
4. **Use `approval` nodes** for high-risk operations (deploying, deleting, spending >$1)
5. **Use `cancel` nodes with `when`** for early termination on unsafe/invalid conditions
6. **Keep prompt nodes focused** — one responsibility per node
7. **Name nodes descriptively** — `scan-security` not `node1`
8. **Use `bash`/`script` nodes** for deterministic work — no AI cost, no hallucination risk
9. **Use `until_bash`** on loops for reliable completion detection
10. **Scope `allowed_tools`/`denied_tools`** to prevent nodes from doing unintended work
