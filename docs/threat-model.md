# Grok Light threat model (baseline)

Status: baseline for Phase 0. Revised at the Phase 6 hardening gate and before
any platform gate.

Scope: `grok-light-host`, the locally served SPA, the `light.local.v1` protocol,
and the supervised Grok Build child process. Grok Desktop, its daemon, its
vault, and the Isolated Guest are out of scope and unaffected.

## 1. What Light is

Light is a **control surface** for an agent that already runs with the user's
own authority. It is not a sandbox, not a containment boundary, and not a policy
layer over the CLI.

The honest one-line description: Light gives a local browser tab the ability to
drive the Grok Build CLI that the user installed and authenticated, with the
same authority that CLI already has.

Pairing and approvals improve user control. They do not create containment.

## 2. Assets

| Asset | Owner | Notes |
|-------|-------|-------|
| Grok authentication (OAuth tokens, refresh tokens, API keys, `auth.json`) | Grok Build under user `GROK_HOME` | Never enters the browser or the Light protocol |
| Agent control (ability to prompt, approve, cancel) | Host, gated by pairing and control lease | Compromise means arbitrary action with user authority |
| Workspace contents | User filesystem | Agent reads and writes with user authority |
| Tool output and diffs | Transits host to browser | May contain secrets the agent read |
| Pairing secrets (nonce, browser session token) | Host, stored hashed | Single use nonce, revocable session |
| Host state (install id, port, workspace refs, journal) | Host, owner-only files | `0700` directories, `0600` files |
| `install-id` | Host, appears in the origin hostname | Stable per installation; see 6.3 |

## 3. Trust boundaries

1. **Browser to host.** The browser is untrusted. Every command crosses a closed
   operation surface with schema, bounds, cookie, exact `Host`, `Origin` policy,
   CSRF token, and controller epoch checks.
2. **Host to CLI child.** The child is a separate process with the user's
   authority. The host supervises lifecycle and bounds, and does not attempt to
   constrain what the CLI may do.
3. **CLI to the world.** Out of Light's control by design (ADR light 0004). The
   CLI reaches whatever the user's configuration allows.
4. **Local machine.** Loopback is a machine boundary, not an account boundary.

## 4. Adversaries and defences

### 4.1 A malicious or compromised web page

Cannot read or mutate the host. The application is served from the loopback
origin (ADR light 0002), so there is no remote origin to compromise. A page from
any other origin fails the exact `Host` check, fails the `Origin` check on any
mutation, has no paired cookie, has no CSRF token, and is additionally subject
to the browser's own Local Network Access permission for loopback connections.
No CORS is configured.

Safe methods tolerate an absent `Origin`, because browsers do not send one on
same-origin `GET`. A present but mismatched `Origin` is always rejected, so a
cross-origin `GET` gains nothing.

DNS rebinding is covered by exact `Host` matching against the canonical hostname
and port, plus rejection of non-loopback peers.

### 4.2 Another local user on a shared machine

Can observe that the port is open and can connect to the listener. Cannot pair:
the pairing nonce is only obtainable through an owner-only Unix socket, and host
state is owner-only. Without a paired cookie every operation is rejected.

Not defended: a user with root, or with read access to the target user's home,
is outside the model. Such a user already possesses `GROK_HOME` and the CLI, so
Light adds no exposure.

### 4.3 A local process squatting the port

The canonical port is allocated outside the platform ephemeral range and an
owner-only lock is taken before bind, so a routine outbound socket cannot take
it. A process that holds the port and answers the protocol produces an explicit
`origin_conflict` fail-closed state, never a degraded or shared session. Port
unavailability alone retries and preserves identity; only explicit repair
rotates the origin.

### 4.4 A second browser tab

One control lease, bound to a WebSocket and a monotonic epoch. A second tab is
blocked and may show status only. No forcible takeover in v1. This removes
racing approvals, which is the case where ambiguity is least acceptable.

### 4.5 Prompt injection and hostile model output

Not defended, and not claimed. Model output, files, tool output, MCP metadata,
hooks, and plugins are untrusted input. A permission dialog shows what ACP
reports; it cannot certify that an action is benign. Light renders unknown tool
payloads in a bounded view and never evaluates them.

### 4.6 A substituted `grok` binary

Detected as a support and contract problem, not as a breach (ADR light 0005).
Because the user's full configuration is in scope, arbitrary plugin and hook
code already executes with the same authority, so binary pinning would defend a
strictly smaller opening.

## 5. Invariants

- The browser never receives authentication credentials or raw ACP.
- The browser never supplies a filesystem path; workspaces are opaque ids
  enrolled through a host-owned picker and revalidated at use.
- Intent is persisted before a side effect is dispatched.
- No prompt and no permission decision is replayed automatically after an
  ambiguous outcome.
- An ambiguous non-idempotent effect terminates in `interrupted_needs_review`
  and is never retried by Light.
- Session history repair (`DiagnoseSession` / `RepairSession`) is user opt-in
  only, never auto on load, and never a substitute for reviewing interrupted
  side effects (light ADR 0015).
- Pending permissions are denied when the controlling tab or the child is lost,
  using the single-use rejection and never a persistent one.
- Every boundary bounds size, queue depth, concurrency, output, and retention.
- The host originates no outbound network traffic.

## 6. Accepted risks

### 6.1 The agent runs with the user's authority

By design. Light drives a CLI the user installed and authorised. A malicious or
mistaken action can modify anything the user can modify. Isolation is a Desktop
feature and is out of Light's product scope.

### 6.2 The user's configuration may auto-approve

Yolo mode, auto mode, safe command lists, policy allows, persisted grants, and
`pre_tool_use` hooks can resolve an action without any Light prompt. Light
cannot interpose on a request ACP never emits. Disclosed in the interface; not
mitigated.

### 6.3 The `install-id` on a non-conforming resolver

The origin hostname contains a stable per-installation identifier. Two
independent mechanisms normally keep it local:

- a conforming browser short-circuits `*.localhost` to loopback (ADR light 0008);
- a conforming system resolver maps `*.localhost` to loopback per RFC 6761.

Both were measured on this platform: `getent ahosts` returns `127.0.0.1`, and
Chrome 150 connects from `127.0.0.1` with `isSecureContext` true. A direct DNS
query for the name returns `NXDOMAIN`, so nothing is published.

Residual exposure applies only to a client that implements neither rule, where
the name would reach the configured resolver. The identifier is random and
derived from nothing about the machine, user, or network, but it would be
correlatable. This is not mitigable from the host, because resolution happens in
the browser before any request. Mitigation is the engine matrix plus disclosure.
If resolution ever landed off-loopback the host would never receive the request,
so the user would see a broken page rather than a silently redirected session.

### 6.4 Tool output may carry secrets into the browser

The agent may read files or environment values containing secrets and include
them in tool output or diffs, which the browser then renders. The guarantee is
about authentication credentials, not about session content. Logs and
diagnostics redact; the session view necessarily does not.

## 7. Explicit non-claims

Light does not claim:

- that the effective CLI configuration is Grok-only;
- that every tool, hook, plugin, or MCP call requests permission;
- that the workspace is a sandbox;
- that Allow or Deny contains malicious code or prompt injection;
- that a qualified executable makes a session safe;
- that the browser sees no sensitive data;
- that the origin hostname can never reach a resolver on an unsupported client;
- that visiting an ordinary HTTP URL can start a stopped native process;
- that any sync, backup, or remote execution exists.

## 8. Reporting

Security reports follow the repository [SECURITY.md](../../SECURITY.md). Reports
concerning Light should say so, because the trust model differs from Grok
Desktop and a Desktop invariant may not apply.
