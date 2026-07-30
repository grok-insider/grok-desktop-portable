# ADR light 0004: The user's complete Grok Build configuration is in scope

- Status: proposed
- Date: 2026-07-28

## Context

Grok Desktop runs the official Grok Build component inside a private managed
home with closed policy, so Desktop can state what the component may do. Grok
Light exists to drive the CLI the user already installed and authenticated,
which means the user's real `GROK_HOME`, real authentication, and real
configuration.

That configuration is not inert. Custom models and endpoints, MCP servers,
plugins, hooks, memory, skills, project configuration, folder trust, safe
command lists, permission rules, and persisted grants all change what the agent
does and whether a given action ever produces a permission request at all.

Two facts from the qualified revision make this concrete. The CLI documents
`--plugin-dir` as the "highest-priority plugin scope; always trusted — hooks and
MCP servers activate without a prompt". And the ACP `initialize` response
advertises `x.ai/hooks` with `blockingEvents` including `pre_tool_use`, so user
hooks run before a tool call and can decide its outcome.

Light can either fight that configuration, which would mean rebuilding Desktop's
managed home and abandoning the product premise, or accept it and be exact about
what it therefore cannot claim.

## Decision

Light uses the user's `GROK_HOME`, authentication, and effective configuration
as-is. It does not copy authentication, does not construct a parallel home, and
does not modify Grok configuration from the web surface.

The complete user configuration is explicitly in scope. Consequently, Light
does not claim that the effective configuration is Grok-only, and does not claim
that every tool, hook, plugin, or MCP call produces a permission prompt. An
action auto-approved by the user's own configuration may never reach Light, and
Light cannot interpose on a request that ACP does not emit.

Light projects the effective mode that ACP exposes and discloses this boundary
in the interface. Disabling a row in Light never revokes a grant that already
exists in `GROK_HOME`; the user manages those with Grok Build itself.

Authentication remains owned by the CLI. OAuth tokens, refresh tokens, API keys,
and `auth.json` never enter the browser or the Light protocol. Authentication
failures project as non-secret states.

This is a documented exception to the Desktop invariant that execution runs
under managed policy. It applies to Light only, and does not weaken any Desktop
invariant.

## Consequences

- Light is a control surface for an agent whose authority the user already
  granted, not a containment boundary. Product copy must say so.
- Users get their own models, tools, and workflows, which is the reason to use
  Light at all.
- Support burden increases: a Light bug report may originate in user
  configuration, so diagnostics must surface effective state without leaking
  secrets.
- Security review must not treat a Light permission prompt as proof that all
  actions are mediated.

## Rejected alternatives

- Constructing a managed private home would duplicate Desktop, discard the user's
  authentication and tools, and remove the product's reason to exist.
- Filtering or overriding the user's configuration from the web surface would
  make Light an unaccountable policy layer over a CLI the user configured.
- Claiming full mediation while accepting arbitrary hooks and plugins would be
  a false security claim.
