# ADR light 0018: Session runtime projection (tasks, workflows, agents)

## Status

Accepted (tasks live + snapshot foundation; kill/output ops follow)

## Context

Grok Build’s TUI keeps first-class **session runtime** state:

- background bash/monitor tasks (`BgTaskState`, TasksPane)
- workflow runs
- subagents

These ride **extension** notifications (`x.ai/task_backgrounded`,
`x.ai/task_completed`, `_x.ai/session/update` for workflows/subagents), not
standard ACP `session/update` alone.

Portable’s early bridge only accepted `session/update` and projected a closed
ACP set. Background `grok-bridge serve` (and any long bash) was invisible in
the Work SPA while fully visible in the CLI Tasks pane.

## Decision

1. **NotificationHub.** The ACP reader accepts `session/update`, permissions,
   and **all** `x.ai/*` / `_x.ai/*` methods as `AgentEvent::ExtNotification`.
   Known methods are decoded in pure modules (`xai_runtime`); unknown methods
   are dropped.
2. **SessionRuntime** on the host, keyed by open agent `sessionId`, holds
   `TaskRecord`s (and will absorb members/workflows over time). Paths such as
   `output_file` stay host-only.
3. **light.local.v1** projects:
   - `backgroundTaskUpdated` (live upsert)
   - `sessionSnapshot.backgroundTasks` (rehydrate + live merge)
4. **SPA Runtime strip** shows Tasks alongside Workflows and nested Agents
   (CLI group model without full TUI clone).
5. **Control ops (follow-on):** `getBackgroundTaskOutput` (bounded host read)
   and `killBackgroundTask` via agent `x.ai/task/kill`, under the control lease.

## Consequences

- Portable can show long-running work in the same conversation the agent owns.
- Adding a new x.ai surface means registering a decoder in the hub, not forking
  the stdio reader.
- Kill/output require agent capability and careful bounds (threat model).

## Alternatives considered

- **Tool-row only.** A completed tool_call loses “still running” semantics.
- **Stream full stdout on WS.** Too large; prefer pull with caps.
- **Browser process control.** Forbidden; kill must go through the agent.
