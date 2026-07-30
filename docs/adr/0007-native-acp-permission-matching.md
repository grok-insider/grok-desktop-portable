# ADR light 0007: Native ACP permission matching for v1

- Status: proposed
- Date: 2026-07-28

## Context

A permission dialog is the one place where a wrong label causes durable,
unintended authority. Grok Build's option semantics are not derivable from
`PermissionOptionKind` alone: option id, access kind, client type, and user
configuration all change the real lifetime. `AllowAlways` may mean a persisted
grant scoped by working directory and client, and a web-fetch option labelled
for a session may persist by domain.

The CLI resolves client type from a client identifier, and only recognises
`grok-web`, `nebula`, `grok-code-extension`, `grok-desktop`, and `grok-pager`.
Every other identifier, including `grok-light`, falls to the default `Generic`
arm, documented as the simple option presentation. Light therefore does not get
a bucket of its own, and any semantics observed against the TUI, Pager, or
Desktop clients do not describe what Light will receive. The identifier is
supplied through the `GROK_CLIENT_NAME` environment variable, whose own default
is `grok-shell`, itself an alias of `Generic`.

Audit of the option construction in the qualified revision shows every option
set offers `allow-once` together with `reject-once`, even when it also offers
`always-allow`, `allow-always-domain`, or `allow-always-mcp`. Light depends on
that, because it renders a subset.

## Decision

Light renders and answers exactly three native option ids, and only when ACP
offers them:

1. `allow-once`
2. `reject-once`
3. `allow-edits-session`, only for an Edit access kind

Light never fabricates an option id and never answers an option the CLI did not
offer. It implements no command, tool, or domain matching of its own. It does
not present `always-allow`, `allow-always-mcp`, or `allow-always-domain`, does
not present or enable `enable-always-approve`, does not send
`x.ai/yolo_mode_changed`, does not write Grok permission state or configuration,
and offers no working-directory grants of its own.

Light also does not present `reject-always`. A persistent denial is a durable
policy of the same nature as the persistent allows v1 excludes, and its real
scope depends on the CLI's permission manager. Deny always maps to
`reject-once`.

Light identifies itself as `grok-light` and accepts that this resolves to
`ClientType::Generic`. It does not impersonate Desktop, Pager, or Grok Web to
obtain a different option set.

The browser returns only `requestId`, `expectedRevision`, and an exact
`optionId`. The host verifies the option was still offered and still active.
Timeout, saturation, a lost controlling tab, or a stale controller epoch fail
closed, and fail closed means `reject-once` specifically: Light never falls back
to a persistent rejection.

If a qualified version ever emits a request without a single-use option, Light
shows an incompatibility state naming the received options rather than a dialog
whose only choice is Deny.

Contract tests per qualified version assert: the client identifier resolves to
`Generic`; every access kind offers `allow-once` and `reject-once`; the three
rendered ids behave as specified; and the hidden ids are never answered. A
version that fails any of these is `unsupported_cli`.

## Consequences

- Light cannot create a durable grant, so a mistaken click costs one action.
- Light offers fewer options than the native TUI. This is deliberate and is
  disclosed rather than presented as parity.
- Users who want persistent grants use Grok Build directly, and those grants
  continue to apply inside Light sessions.
- The permission projection is pure logic and is unit-tested independently of
  any running agent.

## Rejected alternatives

- A synthesised "always for this session" control would claim a lifetime ACP
  does not implement.
- Rendering every offered option would expose persistent grants through a
  surface that cannot show or revoke their real scope.
- Trusting `PermissionOptionKind` or option labels would bind the dialog to a
  presentation detail rather than to behaviour.
- Sending a recognised client identifier to unlock richer options would be
  impersonation and would couple Light to another product's policy.
