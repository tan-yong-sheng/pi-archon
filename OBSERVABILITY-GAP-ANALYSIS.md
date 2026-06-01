# Observability Gap Analysis: pi-archon WorkflowOverlay vs Archon Web UI

**Goal**: Maximize live execution observability in the terminal WorkflowOverlay
(Option C from grilling session — real-time feedback, not browsing)

## What Archon Web UI Shows During Live Execution

### WorkflowExecution.tsx (main execution page)
- **Header**: workflow name, StatusBadge (colored pill), codebase name, elapsed duration, "Run Details" link
- **Currently Executing bar**: animated dot + "Currently executing: {nodeName}" + live elapsed timer
- **3 tabs**: Graph (DAG + logs), Logs (node sidebar + logs), Chat (parent conversation)

### WorkflowLogs.tsx (the key component — right panel in Graph/Logs tabs)
- **Streaming AI text**: appears character-by-character with 50ms batching via SSE
- **Tool call cards**: expandable cards showing:
  - Tool name + input JSON (expandable)
  - Live spinner while in-flight
  - Output + duration on completion
- **"Thinking" placeholder**: animated pulsing dots when no active stream
- **Message segmentation**: user messages, assistant responses, tool calls grouped correctly
- **Auto-scroll to bottom** with jump-back button

### DagNodeProgress.tsx (left sidebar in Logs tab)
- **Compact node list**: state icon, node name, iteration counter, duration
- **Expandable iterations**: toggle shows per-iteration status + duration
- **Active node highlight**: accent border-left + background
- **Error preview**: truncated red text
- **Skip reason**: with underscores replaced by spaces

### WorkflowExecution.tsx tool events
- **Tool events extracted from workflow_events table**: tool_called matched with tool_completed
  by name + timestamp (greedy earliest match within 60s window)
- **Rendered as ToolCallDisplay cards**: name, input (expandable), output, duration

## What pi-archon WorkflowOverlay Currently Shows

### Header section
- ✅ Status icon (◆ running, ✓ done, ✗ failed)
- ✅ Workflow name
- ✅ Elapsed time
- ✅ Query preview
- ❌ Missing: live elapsed timer per running node (shows static "startedAt" offset)

### Node list section
- ✅ State icons (○ queued, ● running, ✓ done, ✗ error, ⊘ skipped, ⏸ approval)
- ✅ Node name
- ✅ Node type badge ([bash]/[prompt])
- ✅ Iteration badge (current/max)
- ✅ Active tool badge (🔧toolName)
- ✅ Provider badge (via claude)
- ✅ Log indicator (📋✓ for API output, 📋N for live lines)
- ✅ Duration suffix
- ✅ Error/skip-reason/approval message
- ❌ Missing: iteration expansion (sub-list per iteration with status+duration)
- ❌ Missing: active node highlight (accent border/background)
- ❌ Missing: "Currently executing" indicator with live timer

### Output panel section
- ✅ Shows output for selected/running node
- ✅ Prefers nodeOutput (API) over logLines (live capture)
- ✅ Auto-follow mode (scrolls to bottom)
- ✅ Tab to toggle auto-follow
- ✅ Smart line rendering (⟳ accent, ✓ success, ⚠ error, dim internal)
- ❌ **CRITICAL**: No streaming AI text display during execution
- ❌ **CRITICAL**: No tool call cards with input/output/duration
- ❌ Missing: "Thinking…" placeholder when no active output
- ❌ Missing: Tool call expansion (show input JSON, show output)
- ❌ Missing: Message segmentation (user/assistant/tool calls grouped)

### SSE data flow (what's wired but not fully rendered)
- ✅ Dashboard SSE connected → DagProgressTracker (node status, tool activity, loop iterations, artifacts)
- ✅ Conversation SSE connected → appendLogLine (raw text to node log buffer)
- ✅ onToolCall → appendLogLine("⟳ toolName input") + setCurrentNodeTool
- ✅ onToolResult → appendLogLine("✓ toolName (duration): preview")
- ✅ onText → appendLogLine(content) — BUT this just appends to logLines ring buffer
- ❌ **CRITICAL**: AI text is NOT rendered as streaming text in the output panel
  — it goes into logLines which shows as plain lines, not as a live-updating stream
- ❌ Missing: Tool call tracking with structured input/output (only string preview in logLines)
- ❌ Missing: Tool call duration live timer while in-flight

## Critical Gaps (Must Fix)

### 1. Streaming AI Text Not Visible in Real Time
**Current**: AI response text from conversation SSE gets appended to `node.logLines[]`
as individual lines. The output panel shows them as flat text after the fact.

**Archon Web UI**: Shows AI text character-by-character with 50ms batching,
auto-scrolling, "thinking" placeholder when idle.

**Fix**: Track streaming text state in DagProgressTracker (separate from logLines).
The output panel should render streaming text as a live-updating block with
auto-follow, and show "Thinking…" when a node is running but no text has arrived yet.

### 2. Tool Calls Not Shown as Structured Cards
**Current**: Tool calls are rendered as flat log lines: "⟳ Read" and "✓ Read (234ms): preview"
These are mixed in with other log lines and lose their structure.

**Archon Web UI**: Tool calls appear as expandable cards with:
- Tool name + input JSON (collapsible)
- Live spinner while in-flight
- Output + duration on completion

**Fix**: Track tool calls as structured data in DagProgressTracker.
Render them as indented blocks in the output panel with:
- `▸ ToolName input...` while running (with live elapsed timer)
- `▾ ToolName (234ms)` on completion, expandable to show output

### 3. No "Thinking" / "Running" Indicator for Active Nodes
**Current**: When a node is running but no output has appeared yet,
the output panel shows "(waiting for output…)" which is static.

**Archon Web UI**: Shows animated "thinking" with pulsing dots.

**Fix**: Show a live "● Running…" indicator with elapsed timer in the
output panel when the selected/running node has no output yet.

## Nice-to-Have Gaps (Secondary Priority)

### 4. Iteration Expansion
**Current**: Loop nodes show `iter 2/5` badge only.
**Web UI**: Expandable sub-list showing each iteration's status + duration.
**Fix**: Add toggle key (e.g. 'i') to expand iteration list under a loop node.

### 5. Active Node Highlight
**Current**: Running nodes show ● icon but no visual emphasis beyond that.
**Web UI**: Running node has accent border-left + background highlight.
**Fix**: Add accent indicator (▸ marker + accent color on the node line).

### 6. "Currently Executing" Indicator Bar
**Current**: Header shows workflow-level status only.
**Web UI**: Shows "Currently executing: nodeName" with live timer.
**Fix**: Add a line below the header showing the running node name + live timer.

### 7. Artifact Events in Real Time
**Current**: Artifact events from SSE are mapped to a no-op DagEvent.
**Web UI**: Shows artifact cards (PR, commit, file_created/modified) as they appear.
**Fix**: Track artifacts in DagProgressTracker, show artifact count/badge in node list.

### 8. Cost and Turn Count During Execution
**Current**: costUsd and numTurns only set on node_completed from API.
**Web UI**: Shows cost accumulating during execution.
**Fix**: Show running cost in header or footer during execution.

## Implementation Plan

### Task 0: Add StreamingText and ToolCall tracking to DagProgressTracker
- Add `streamingText: string` field to DagNodeInfo (current streaming output)
- Add `toolCalls: ToolCallRecord[]` field to DagNodeInfo
- ToolCallRecord: { name, input, output?, startedAt, durationMs?, toolCallId }
- Add `appendStreamingText(nodeId, text)` method
- Add `startToolCall(nodeId, name, input, toolCallId?)` method
- Add `completeToolCall(nodeId, name, output, duration, toolCallId?)` method
- Wire conversation SSE onText → appendStreamingText
- Wire conversation SSE onToolCall → startToolCall
- Wire conversation SSE onToolResult → completeToolCall

### Task 1: Rewrite WorkflowOverlay output panel
- Show streaming text as a live-updating block with word wrap
- Show "● Running… 12s" when node is running but no text yet
- Render tool calls as structured blocks:
  - While running: `▸ ToolName · 3s` (live timer via requestRender)
  - On completion: `▾ ToolName (234ms)` with indented output preview
  - Enter on a tool call line expands/collapses the output
- Auto-scroll follows streaming text
- Show "Thinking…" with animated dot when node is running but no text

### Task 2: Add active node emphasis
- Running node gets ▸ marker + accent color on the entire line
- Add "Currently executing: nodeName · 12s" line below header

### Task 3: Add iteration expansion
- Press 'i' on a loop node to toggle iteration sub-list
- Each iteration shows status icon + iteration number + duration

### Task 4: Wire SSE tool activity events into structured tool tracking
- Dashboard SSE workflow_tool_activity → startToolCall/completeToolCall
  (fallback when conversation SSE is not available)

### Task 5: Typecheck, test, commit
