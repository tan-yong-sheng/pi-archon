<!-- markdownlint-disable MD033 MD041 -->
<p align="center">
  <img src="assets/logo.png" alt="pi-archon" height="84" />
</p>

<h1 align="center">pi-archon</h1>

<p align="center">
  Archon workflow integration for the Pi Coding Agent.
</p>
<!-- markdownlint-enable MD033 MD041 -->

`pi-archon` adds an Archon workflow dashboard and an `archon_workflow` tool to Pi so you can launch, inspect, approve, reject, and monitor workflows without leaving your Pi session.

## Features

- **`/archons` dashboard** for launching and monitoring workflows.
- **`archon_workflow` tool** for agent-driven workflow control.
- **Local workflow discovery** from `.archon/workflows`.
- **Shared workflow discovery** from the Archon CLI.
- **Approval-gate support** for pause, approve, reject, and resume flows.
- **Artifact and run inspection** for completed and in-progress workflows.

## Requirements

- Node.js 20.6 or newer
- Pi Coding Agent installed
- Archon installed locally and available to the extension

If you do not have Pi installed yet:

```bash
npm install -g @mariozechner/pi-coding-agent
```

## Install

Install directly from this repository:

```bash
pi install -l git:github.com/tan-yong-sheng/pi-archon
```

Then reload Pi:

```text
/reload
```

## Use

### Dashboard

Open the workflow dashboard:

```text
/archons
```

From the dashboard you can:

- launch workflows
- view active and paused runs
- inspect run details and artifacts
- approve or reject paused workflows

### Workflow tool

The `archon_workflow` tool supports these actions:

- `run` — launch a workflow
- `list` — list available workflows
- `info` — show a workflow definition
- `status` — show workflow status
- `cancel` — cancel a run
- `resume` — resume a run
- `approve` — approve a paused run
- `reject` — reject a paused run
- `latest-run` — find the most recent run for a workflow

Useful parameters:

- `query` — optional launch input for `run`
- `comment` — optional approve comment
- `reason` — required reject reason

## Writing workflows

Workflow YAML files live in:

```text
.archon/workflows/
```

A workflow can accept user input through Archon's existing argument flow. If a workflow needs parameters, pass them when launching it instead of inventing a separate input system.

## Development

Run the local checks with:

```bash
pnpm test
```

## Notes

- This extension does not bundle Archon itself.
- If a workflow pauses at an approval gate, ask the user whether to approve or reject before taking action.
- The repository is intentionally focused on the current `/archons` dashboard and `archon_workflow` tool; older `/archon` command-tree and server/web sections are no longer part of the primary user flow.

## License

MIT
