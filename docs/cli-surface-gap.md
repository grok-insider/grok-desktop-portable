# CLI surfaces vs Portable Web UI

Development notes from inspecting **Grok Build CLI** (`examples/grok-build/`,
gitignored clone of `xai-org/grok-build`) against what `grok-bridge` + the Work
SPA project today.

## Already on the wire / in UI

| ACP / light event | Portable UI |
|-------------------|-------------|
| `agent_message_chunk` → `messageDelta` | Agent answer (markdown) |
| `agent_thought_chunk` → `thoughtDelta` | **Thinking** collapsible (`ThoughtRow`) |
| `tool_call` / `tool_call_update` → tool* | `ToolRow` (read/edit/run/search/fetch/…) |
| `plan` → `planUpdated` | `PlanRow` checklist |
| `available_commands_update` | Composer `/` menu |
| Permissions (allow-once set) | `PermissionDialog` |
| Queue / send-now | Composer queue |

## Deep research (`/deep-research`)

Source: `examples/grok-build/crates/codegen/xai-grok-shell/src/session/workflows/deep_research.rhai`.

### What the workflow does

1. **Plan** — agent with structured output: up to N independent questions  
2. **Research** — **parallel** child agents (`capability_mode: read-only`) collecting claims + sources  
3. **Verify** — independent cross-check of claims  
4. **Report** — cited prose  

Phases are first-class in the CLI workflow runtime (`phase("Plan")`, …). Each
phase runs one or more `agent(...)` calls (subagents). Tools inside those
agents include **web search / fetch** and similar, which surface as ordinary ACP
`tool_call` notifications **if** they run on the parent ACP session the bridge
watches.

### What Portable can show *today* without protocol work

When the CLI runs research tools on the **same** ACP session the bridge owns:

- **Thinking** blocks (now rendered)
- **Tool rows** for `search` / `fetch` / MCP search (titles + detail lines)
- **Plan** checklist if the agent publishes ACP `plan` entries
- Final **agent message** (the report)

### What is *not* projected (CLI-only or x.ai extensions)

| CLI surface | Why missing |
|-------------|-------------|
| Workflow **phase rail** (Plan → Research → Verify → Report) | Not standard ACP; pager has `views/workflows.rs` |
| Per-phase **parallel subagent cards** | `x.ai/subagent_*` / headless `ExtEvent::SubagentSpawned` — bridge drops unknown `sessionUpdate` kinds |
| Structured **claims / sources / confidence** board | Lives inside workflow Rhai output, not ACP plan entries |
| Citation validation UI | CLI workflow logic, not bridge protocol |

**Implication:** `/deep-research` in Portable will look like a busy Work
transcript (thinking + many search/fetch tools + a long answer), not like the
CLI’s multi-phase research dashboard. To match the CLI UX we need new
`light.local.v1` events (or a deliberate subset of `x.ai/*` session updates)
and SPA panels for phases / subagents / claim tables.

## Background tasks, goals, subagents

From CLI tool runtime + pager:

| Mechanism | CLI presentation | Bridge today |
|-----------|------------------|--------------|
| Bash moved to background | `BashExecutionBackgrounded` / task id; poll via tools | Not projected; tool row may end as completed/failed only |
| Monitor / long process | Streaming monitor events | Dropped |
| Subagents | Spawned / finished ext protocol; compaction reminders | Dropped |
| Workflows | Full phase UI, agent budget, pause/resume | Dropped |
| ACP `plan` | Checklist of steps | **Shown** (`PlanRow`) |
| Compaction “still running tasks” | Injected system reminder | N/A in browser |

Headless pager decodes e.g. `x.ai/task_backgrounded`, `task_completed`,
`SubagentSpawned`, `SubagentFinished` (`ext_protocol.rs`).  
`grok-bridge` `session_update_event` only forwards the closed set in
`projection.rs` (`agent_message_chunk`, `agent_thought_*`, `tool_call*`,
`plan`, `available_commands_update`). Everything else is **`None` → drop**.

### Recommended product path (not implemented here)

1. **v1 (done for thoughts):** render every standard ACP channel we already
   receive completely (thoughts + tools + plan + messages).
2. **v1.1 deep-research-friendly:** project tool **kind** + richer detail
   (query string, URL) for search/fetch so research scans well; optional
   “activity strip” of running tools.
3. **v2 workflows/background:** opt-in projection of selected `x.ai/*`
   updates → `workflowPhase`, `subagentStatus`, `backgroundTask` events with
   opaque ids only (no paths). SPA: phase chip + task list, no full Rhai IDE.

## Local clone

```text
examples/grok-build/   # gitignored — clone of xai-org/grok-build for research
```

Do not ship or depend on this tree in CI or release builds.
