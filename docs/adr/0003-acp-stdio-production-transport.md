# ADR light 0003: ACP over stdio as the only production agent transport

- Status: proposed
- Date: 2026-07-28

## Context

The Grok Build CLI exposes several agent transports. `grok agent --help` on the
qualified revision lists `stdio`, `headless`, `serve`, and `leader`.

`serve` looks like a shortcut for a browser UI because it already speaks
WebSocket. In the qualified revision it exposes only `/ws`, accepts a bearer
token or a `server-key` query parameter, generates a default secret that is
short for a browser-facing boundary, does not validate the browser `Origin`, and
implements none of pairing, control lease, workspace enrollment, closed
operation surface, or event journal. Its multi-client semantics do not express a
single controlling tab.

Exposing it to a browser would place an agent control channel on loopback with
weaker authentication than the rest of the product and no ability to enforce
Light's own invariants.

## Decision

Production spawns a supervised child process and speaks ACP JSON-RPC over its
stdin and stdout:

```text
grok agent --no-leader stdio
```

Options precede the subcommand, matching the CLI's own
`grok agent [OPTIONS] [COMMAND]` usage. `--no-leader` is documented as "start a
new agent even when config enables leader mode", which keeps Light from
contending for the leader role with an interactive `grok` the user may be
running. The flag also changes plugin directory resolution, so the choice is not
neutral and is contract-tested rather than assumed.

Light never passes `--always-approve`, which disables prompting, nor
`--plugin-dir`, which the CLI documents as an always-trusted scope whose hooks
and MCP servers activate without a prompt. Neither is reachable from the
browser, and the host does not use them either.

`grok agent serve` is never a browser-facing listener and never a production
transport. It may appear only in reference contract tests, and a test asserts
that production spawns stdio.

The browser never receives raw ACP. It speaks `light.local.v1` to the host, and
the host translates. This keeps the closed operation surface, the control lease,
the bounds, and the journal on the host side of the boundary.

The child runs in its own process group, dies with the host, and closes after
bounded inactivity. One agent session is active at a time.

## Consequences

- Light owns transport supervision, framing bounds, and lifecycle rather than
  delegating them to a listener it does not control.
- Adding a second consumer of ACP later requires extracting an adapter, not
  reopening a network listener.
- A change to leader semantics or to the `agent` subcommand flag surface in the
  CLI is contract drift and blocks that version.
- Browser and agent are decoupled: a protocol change on either side does not
  force a change on the other.

## Rejected alternatives

- Proxying `agent serve` through the host adds a hop without removing the weak
  authentication or the missing origin validation.
- Exposing `agent serve` directly to the browser would make the CLI's own
  listener the product's security boundary, which it was not designed to be.
- Running the child as leader would contend with an interactive `grok` session
  the user already has open.
