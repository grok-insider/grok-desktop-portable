# `light.local.v1` — Grok Desktop Portable local protocol

Status: draft aligned with ADR light 0016 (hosted UI + local bridge).
Implementation: `crates/grok-bridge`.

Scope: protocol between the browser client and `grok-bridge`. It is **not** ACP.
The browser never sends or receives ACP; the bridge translates.

## 1. Transport

### 1.1 Roles of origins (ADR 0016, ADR 0006)

| Role | Typical value |
|------|----------------|
| Document (production) | `https://desktop.grok.me` |
| API | `http://127.0.0.1:<port>` (loopback bind only) |
| Document (fallback) | `http://<install-id>.grok-light.localhost:<port>` served by the bridge |

| Channel | Use |
|---------|-----|
| HTTP | Commands. Mutations use `POST`, `PUT`, or `DELETE` with bounded JSON. No mutation on `GET` |
| WebSocket | Server-to-client events, and the binding for the control lease |

### 1.2 Hosted document → loopback API

Production SPA is cross-origin to the API:

1. SPA uses `credentials: 'include'` so the **loopback** session cookie is sent.
2. Mutations send CSRF header (e.g. `x-grok-light-csrf`) from page memory.
3. `Host` must match the API host (`127.0.0.1:<port>` or `localhost:<port>`).
4. `Origin` on mutations and WebSocket upgrades must be an **allowlisted** web
   origin (default `https://desktop.grok.me`). Unknown origins are rejected.
5. CORS: for allowlisted `Origin` only, responses include exact
   `Access-Control-Allow-Origin` (never `*`), `Access-Control-Allow-Credentials:
   true`, and the needed `Allow-Headers`. Preflight `OPTIONS` is answered
   without side effects.
6. Probe `GET /healthz` (name may match implementation) returns non-secret
   status for discovery; it must not mint pairing or run agent effects.

Allowlisted origins are a closed set in the bridge (constant such as
`ALLOWED_WEB_ORIGINS`). Release builds do not include arbitrary dev origins
unless explicitly configured.

### 1.3 Fallback same-origin (loopback SPA)

When the document is the bridge-served SPA, same-origin rules apply: safe
methods may omit `Origin`; mutations require exact loopback document origin;
CORS is unused.

### 1.4 Pairing

`grok-bridge open` mints a single-use nonce (owner-only control socket) and
prints a URL for the **document** origin, e.g.
`https://desktop.grok.me/#pair=<nonce>`. The SPA redeems the nonce on the
loopback pair endpoint; the bridge sets `HttpOnly` cookie on that loopback
response; the SPA clears the fragment.

### 1.5 Rejection

Rejection is silent and uniform. The host does not act as an oracle for which
check failed. Mutations require CSRF. WebSocket upgrades require the versioned
subprotocol and allowlisted (or fallback) `Origin`.

## 2. Versioning

`protocolVersion` is an integer carried in every envelope. A mismatch fails
closed with a local diagnostic; there is no negotiation and no compatibility
shim. Production SPA is deployed on `desktop.grok.me` and may advance
independently of a bridge release only within compatible protocol versions; a
mismatch shows a reload/upgrade diagnostic.

**The version is read before the body is understood.** An operation whose shape
changed does not deserialise under the older version, so a version checked
afterwards never runs: the host would answer a stale tab with a malformed
request error and leave the user nothing to act on but a reload they were never
told to do. The host reads `protocolVersion` from the raw body first and
answers `409 unsupported_protocol_version`, which the interface renders as a
reload.

The subprotocol name is the protocol family, `light.local.v1`, and does not
track this integer.

## 3. Command envelope

```json
{
  "protocolVersion": 2,
  "requestId": "opaque-id",
  "idempotencyKey": "opaque-key",
  "controllerEpoch": 7,
  "expectedRevision": 4,
  "deadlineMs": 0,
  "operation": { "kind": "prompt", "sessionId": "…", "text": "…" }
}
```

| Field | Rule |
|-------|------|
| `requestId` | Opaque, client-generated, bounded length. Correlates the response |
| `idempotencyKey` | Required for any operation with a side effect. Replaying a key never re-executes |
| `controllerEpoch` | Required for any mutating operation and must equal the current lease epoch |
| `expectedRevision` | Optimistic concurrency against the addressed resource. A mismatch is rejected, never merged |
| `deadlineMs` | Client-declared deadline, bounded by the host maximum |

Identifiers are restricted to alphanumerics, `-`, `_`, and `.`, which also means
a workspace identifier can never carry a filesystem path.

## 4. Operations

The operation union is closed. There is no generic escape hatch: no method
sends raw ACP, executes JSON-RPC, spawns a process, edits configuration,
supplies a filesystem path, changes the origin, or changes policy.

**Every session-scoped operation names its session** (light ADR 0011).
`Prompt`, `SendNow`, `RemoveQueued`, `CancelTurn`, `CloseSession`,
`DecidePermission`, `LoadSession`, `GetSessionInspector`, and
`GetSessionChanges` carry a `sessionId`. Ambient addressing
was removed rather than kept as a default, because a default is how a prompt
reaches the wrong workspace once more than one conversation is open. A
`DecidePermission` whose `sessionId` does not match the session that raised the
request is refused, so a decision made in one conversation cannot answer a
prompt shown in another.

| Operation | Side effect | Needs lease |
|-----------|-------------|-------------|
| `Bootstrap` | no | no |
| `GetHostStatus` | no | no |
| `ListWorkspaces` | no | no |
| `OpenWorkspacePicker` | no | yes |
| `RemoveWorkspace` | no | yes |
| `ListSessions` | no | no |
| `LoadSession` | no | yes |
| `GetSessionInspector` | no | no |
| `GetSessionChanges` | no | no |

| `CreateSession` | yes | yes |
| `Prompt` | yes | yes |
| `SendNow` | yes | yes |
| `RemoveQueued` | no | yes |
| `CancelTurn` | yes | yes |
| `CloseSession` | yes | yes |
| `DecidePermission` | yes | yes |
| `AcknowledgeEvents` | no | no |
| `AcknowledgeInterrupted` | no | yes |
| `DiagnoseSession` | no (dry-run only) | yes |
| `RepairSession` | yes when `dryRun: false` | yes |
| `RevokeBrowserPairing` | no | yes |

`DiagnoseSession` / `RepairSession` map to ACP `x.ai/session/repair` (light
ADR 0015). Apply is user opt-in and journaled; never auto on load.

`DecidePermission` accepts only option ids the host recorded as offered and
still active for that request, restricted to the set in ADR light 0007.

**`ListSessions` is host-backed, not ACP-backed.** Measured against the
qualified CLI: `session/new` and `session/load` exist, but `session/list`
answers `-32601 Method not found`. The host therefore reads the session store
under the user's Grok home (light ADR 0010), which lists **every** session for
an enrolled directory — those made in Light and those made in the CLI's own
interface alike — rather than only the ones Light created. A future CLI that
adds ACP listing may replace this, which is a contract change and needs its
fixtures updated.

**`Bootstrap` / `listWorkspaces` also carry projects and optional MCP
integrations.** Projects are the directories **enrolled in Light** (light ADR
0014): opaque `projectId`, always-present `workspaceId`, display name, and the
session counts joined from the user's Grok session store — never paths. A
directory the user only ever opened in the CLI is not projected. `openProject`
still resolves and enrols a project by id, but the browser no longer holds an
unenrolled id to send; enrolment is the host picker or the CLI. MCP integrations
remain projected (name, enabled, remote|local) for tooling UI, but the SPA does
not put them on the project picker. That configuration holds bearer tokens, API
keys inside URLs, and local commands with their environment; none of it crosses
the boundary.

**Models:** `listModels` projects Grok-only catalog entries from the user's
`models_cache.json` (id, name, effort options). `setSessionModel` applies ACP
`session/set_model` with optional `_meta.reasoningEffort`; non-Grok ids are
refused.

**Tools:** `listTools` (optional `workspaceId`) projects global + project MCP
and skill **names** only (`scope`, `kind`, `enabled`).

**Mention context:** `listContext { workspaceId, query? }` projects what the
user may reference with `@` — **workspace-relative** paths and nothing else
(light ADR 0013). The browser sends the opaque workspace id and, at most, the
substring typed so far; it never sends a path. The host resolves the root at
the moment of use, strips it, refuses anything it cannot express relative to
that root, and skips a symlink whose target resolves outside it. Bounded by
`MAX_CONTEXT_ENTRIES` returned, `MAX_CONTEXT_SCANNED` examined,
`MAX_CONTEXT_DEPTH` deep, and `MAX_CONTEXT_PATH_BYTES` per entry — scanned and
returned separately, because a filter that rejects almost everything must still
terminate. The operation has no side effect and takes no control lease.

A chosen mention is inserted into the draft as literal `@path` text and sent
through `prompt` unchanged. The host does not parse it, resolve it, or act on
it; the agent — already running with the user's authority in that directory —
resolves it, exactly as it does for a mention typed in the CLI.

**Session review:** `getSessionInspector { sessionId }` projects bounded
session/model/context/usage information and the currently valid change modes.
`getSessionChanges { sessionId, mode }` accepts only `git`, `branch`, or
`lastTurn`. The browser cannot supply a path, Git root, ref, branch, ACP method,
or limit. The host resolves all of those from the open session and enrolled
workspace, validates the repository identity, and fails closed when the
repository cannot support the request. Git and branch patches are read by the
host with `git2`; Grok Build 0.2.115's generic stdio ACP exposes no Git review
methods, and Light does not impersonate a pager or another recognised client to
reach internal methods.

`git` means `HEAD` through the index and working tree, including untracked
files. `branch` means the host-validated merge-base of the default branch and
`HEAD` through the working tree. The host computes the exact merge-base with
`git2`. `lastTurn` consists only of
ACP diff blocks captured for the latest turn and is marked partial when a
potentially mutating shell/MCP call supplied no diff. It is held in memory and
purged with the session.

Every response carries all bounded file patches in one body: at most 200 files,
256 KiB / 5,000 lines per patch, and 2 MiB of aggregate patch text. Collection
has a 30-second response deadline. Binary, oversized, unavailable, omitted, or unattributed changes are
explicit; the host never truncates a patch and presents it as complete.

Session/model metadata comes from standard ACP session-open responses. Usage is
aggregated from standard `turn_completed` updates (or the prompt result fallback
on older builds); context-window state appears only when the CLI emits a
`usage_update`. Cost is projected only when present and both the provider's
partial-cost and incomplete-usage flags are false. Absence means unknown, never
free.

**Bash:** `prompt` / `sendNow` accept optional `bash: true` (or a leading `!`).
Grok Build treats bang shell as a **client-local** drain, not ACP chat. Light
runs `/bin/sh -c` in the enrolled workspace cwd, captures bounded output, and
emits **`messageDelta` only** for the capture (the SPA already owns the user
`!` line; drain_queue emits `promptSent` for queued bash). Idle comes from the
normal turn-clear path. It does **not** call `session/prompt` or invent
`_meta.bash_command`. Queued bash drains without requiring an agent process.

### Prompt queue

A prompt sent while a turn is in flight is **queued**, not refused. Measured
against the qualified CLI: a second `session/prompt` on a busy session is
neither rejected nor run alongside — the agent queues it and runs it after.
Light therefore keeps its own queue and only sends when the session is idle,
because sending anyway would put one message in two queues, and because a queue
the browser cannot see is one the user cannot take a message out of.

| Operation | Meaning |
|-----------|---------|
| `Prompt` on a busy session | Held, answered with `promptQueued` and an entry id |
| `RemoveQueued` | Takes an entry back out before it runs |
| `SendNow` | Cancels the running turn so this message goes next |

`SendNow` matches what the qualified CLI binds to `Ctrl+Enter`: it does not
jump the queue, it clears the way. The queue is per conversation, ordered, and
bounded; it lives in host memory and is never written to disk, so it survives a
reload but not a host restart — a queued message was never dispatched, so
nothing is left ambiguous by losing it.

## 5. Events

```json
{
  "protocolVersion": 2,
  "eventSequence": 42,
  "sessionRevision": 5,
  "event": { "kind": "messageDelta", "sessionId": "…", "text": "…" }
}
```

`hostStatus`, `sessionSnapshot`, `sessionStatus`, `messageDelta`,
`thoughtDelta`, `toolStart`, `toolProgress`, `toolEnd`, `planUpdated`,
`commandsUpdated`, `sessionReviewUpdated`, `workspacesChanged`, `queueChanged`, `promptSent`,
`permissionRequest`, `turnInterrupted`, `error`.

**Every session-scoped event names its session.** An update the agent cannot
attribute is dropped rather than shown against the wrong conversation.

`thoughtDelta` and `planUpdated` appear only when the qualified CLI advertises
them. `permissionRequest` carries only the option ids Light may render.

`sessionSnapshot` may carry restored `messages` **and** `tools` (bounded tool
rows from `updates.jsonl`, no bodies). After refresh or resume the SPA must
show tool activity that was already in the durable history, not only text turns.

**Qualified CLI minimum:** product integrity (light ADR 0005) assumes Grok Build
**≥ 0.2.115**. `grok-light doctor` and the `cli_matrix` module share that floor.
Older installs may still handshake; contract fixtures and history-integrity
claims do not.

`planUpdated` carries `entries`: each step is agent `content` (bounded text) plus
a closed `status` (`pending` | `in_progress` | `completed`). Priority is not
projected. Empty `entries` means the agent published a plan with no usable steps.

`commandsUpdated` carries the slash commands the agent accepts, as **name plus
description only**, bounded by `MAX_COMMANDS` with each field truncated. The
set belongs to the agent and is republished whenever it changes, so the browser
records what it was told rather than merging. It is conversation state rather
than transcript content, so a `sessionSnapshot` does not clear it. Both fields
are agent-supplied and therefore untrusted: rendered as text, never as markup.

`sessionReviewUpdated` carries only a session id and `changes` / `context`
invalidation flags. Patch and usage bodies stay on the bounded command surface;
an open panel re-reads them, while a closed panel does no background review
work.

`toolStart` carries what the call does rather than only what it is called: the
action (`read`, `edit`, `execute`, `search`, `think`, `fetch`, `delete`,
`move`, `switch_mode`, `other`), whether the agent declares it read-only, the
MCP server that provided it when it is not the agent's own toolset, and one
bounded line naming the command, path, or query. The action is a closed set —
an unrecognised value becomes `other` rather than reaching the interface, since
agent-supplied text must not choose its own presentation. `toolEnd` reports
whether the call failed and whether the host truncated the forwarded output.

`promptSent` announces a queued message as the host dispatches it. The browser
adds its own turns as it sends them; a queued one leaves later and from the
host, and without this the reply arrives with no question above it.

## 6. Recovery invariants

These are load-bearing and are implemented and unit-tested before the final UI.

- The host persists intent before dispatching a prompt or a permission decision.
- `eventSequence` is monotonic per connection lineage and requires cumulative ACK.
- Reconnect sends the last acknowledged sequence.
- The host replays within a bounded window, or delivers `sessionSnapshot` when
  the cursor has expired.
- No ambiguous prompt is resent automatically.
- No permission decision is repeated after a timeout or an uncertain result.
- A non-idempotent effect with no durable known outcome terminates in
  `interrupted_needs_review`.
- Closing the child denies pending permissions and drops any in-memory grant.
- A newly attached tab is given back what it cannot hold itself: a
  `sessionSnapshot` per open conversation, and a `permissionRequest` for every
  decision still owed. Without the second, a reload while one was pending left
  it alive in the host and blocking in the agent with nothing on screen.
- The agent process is shared by every session, so its exit raises one review
  record per conversation that had work in flight, not one for the conversation
  on screen.

The cursor, ACK, replay, and snapshot design follows
[ADR 0008](../decisions/0008-resumable-run-event-long-poll.md), which solves the
same problem for Grok Desktop. Light does not reuse that code, which carries
Desktop policy, but takes the design and its test cases as normative input and
documents any divergence with its reason.

## 7. `interrupted_needs_review`

A record carries the operation identity, the conversation it belonged to when
it belonged to one, and a cause. It carries no prompt body, file body, or tool
output.

Naming the conversation is what makes the record actionable once several run at
once: "something was interrupted" does not say where to go and look. A record
that names a conversation still open offers to open it; one whose conversation
is gone does not, because a dead link is worse than saying nothing.

The only client actions are acknowledge and, after acknowledgement, discard.
There is no retry and no undo: Light does not know whether the effect
materialised and must not imply it can resolve it. A pending record does not
block new sessions; it is shown persistently until acknowledged. Retention
expiry never implies resolution.

## 8. Bounds

Bounded from the first implementation, not deferred to hardening. All values are
defined once in `grok_bridge::bounds`:

- maximum command body and WebSocket frame size;
- maximum event queue depth, with a defined overflow behaviour;
- maximum tool output forwarded to the browser, truncated at the host with an
  explicit marker;
- maximum concurrent in-flight commands;
- maximum live sessions, so concurrency cannot exhaust the shared agent;
- maximum queued prompts per conversation, since a queue is a convenience and
  not a workload;
- maximum listed sessions, restored transcript size, and configured
  integrations, since all three are read from the user's own files;
- maximum replay window and journal retention;
- maximum review files, patch bytes/lines, aggregate patch text, captured
  last-turn blocks, and review deadline;
- bounded, non-secret diagnostics.

Truncation happens on the host. The browser is never the first place a bound is
enforced.

## 9. Open items for Phase 3

- Final numeric bounds and their rationale.
- Whether schemas are generated or hand-written with validators on both sides.
- Exact overflow semantics when an event queue saturates.
- Golden fixture format for contract tests.
