# ADR light 0015: Session history repair is out-of-band recovery, not undo

- Status: accepted
- Date: 2026-07-30

## Context

Corrupted tool-pairing history (`tool_use` / `tool_result` mismatches) can
brick a Grok Build session so every subsequent prompt returns HTTP 400. The
qualified CLI exposes ACP extension `x.ai/session/repair` (dry-run or apply)
as out-of-band recovery. Light users need a control surface for that recovery
without inventing automatic retries of non-idempotent side effects.

## Decision

1. Light may invoke `x.ai/session/repair` only through closed protocol ops
   `DiagnoseSession` (always dry-run) and `RepairSession` (`dryRun` flag).
2. Apply (`dryRun: false`) is **user opt-in**, journals intent first, and
   requires an idempotency key. Light never auto-repairs on `LoadSession` or
   bootstrap.
3. Repair reports projected to the browser are counts and truncated tool-result
   ids only — never chat history bodies, paths, or secrets.
4. Repair **must not** be presented as:
   - retry of `interrupted_needs_review` (still acknowledge/discard only);
   - filesystem undo or revert of agent edits;
   - a slash-command alias of `/undo` / `/rewind` (agent-advertised only).
5. When the CLI answers method-not-found, diagnose returns `unsupported`;
   apply returns `unsupported` refusal. No fabricated healthy report.

## Consequences

- Product integrity and recovery improve for bricked sessions without weakening
  recovery invariants for interrupted side effects.
- Setup/doctor continue to report the CLI version floor (≥ 0.2.115) separately
  from per-session repair capability.
- A future CLI that changes the extension shape requires a new fixture and
  capability probe, not a silent assumption.

## Rejected alternatives

- Auto-repair on every load: would mutate user history without consent and
  could mask active-turn races.
- In-band cancel `tool_result` fabrication from Light: the CLI owns pairing
  integrity; Light must not invent tool results.
- Mapping `/undo` to repair: confuses agent rewind with history sanitization.
