# ADR light 0013: Workspace-relative context listing for `@` mentions

## Status

Accepted

## Context

The composer offers `@` to reference a file in the prompt, as the Grok Build
CLI does. Autocompleting it needs the browser to know what is *in* the enrolled
directory, and nothing in `light.local.v1` could tell it: no operation lists
files, and `protocol.rs` states the union is closed against any variant that
"supplies a filesystem path".

The blocker is direction. ADR 0009 says a workspace reference is an opaque id
and never a path, and that this "applies to every direction of the protocol,
including projections and review records". Read literally that forbids sending
*any* path-shaped value outward, which would rule out `@` entirely.

Two facts narrow the question:

1. **Path-shaped data already crosses outward.** `Event::ToolStart.detail` and
   `ToolProgress.detail` carry agent-supplied text that routinely *is* a path,
   bounded to 512 bytes, and the transcript renders it. ADR 0012 already carved
   out `displayName` as a path basename. So the browser learning file names is
   not a new disclosure class.
2. **The browser still cannot direct the host anywhere.** What ADR 0009 is
   actually protecting is the *inbound* direction: a browser-supplied path
   choosing where the agent runs. That protection is what makes the reachable
   set exactly the enrolment set, and it is not weakened here.

The prompt path matters too. `session/prompt` sends a single text
`ContentBlock`. An ACP `resource_link` mention would carry a `uri` — an
absolute path the host would have to construct — which is strictly more
machinery and more disclosure than the CLI's own convention needs.

## Decision

1. **Add `listContext { workspaceId, query? }`**, returning
   `{ outcome: "context", workspaceId, entries: [{ path, kind }] }`.
   `path` is **workspace-relative**, `kind` is `file` or `directory`.
   The browser sends an opaque `workspaceId` as always; it never sends a path.
2. **The host resolves the root at the moment of use**, exactly as every other
   operation does (ADR 0009). A workspace whose directory no longer resolves is
   refused, never coerced to a nearby path or a default.
3. **Nothing absolute crosses.** The host strips the root prefix and asserts
   the result is relative and contains no `..` segment. A symlink that resolves
   outside the root is skipped, not followed.
4. **Bounds** (`bounds.rs`): `MAX_CONTEXT_ENTRIES` returned,
   `MAX_CONTEXT_SCANNED` examined, `MAX_CONTEXT_DEPTH` deep,
   `MAX_CONTEXT_PATH_BYTES` per entry, `MAX_CONTEXT_QUERY_BYTES` per query.
   A filter that rejects almost everything must still terminate promptly, which
   is why scanned and returned are bounded separately.
5. **Noise directories are skipped** — `.git`, `node_modules`, `target`,
   `dist`, `build`, `.venv`, and dotted directories generally. This is
   relevance, not security; the bounds are the security control.
6. **A selected mention is inserted as literal `@path` text** into the prompt
   and sent through the existing `prompt` operation unchanged. The host does
   **not** parse it, resolve it, or act on it. The agent — which already runs
   with the user's authority in that directory — resolves it, exactly as it
   does for a mention typed in the CLI.
7. **`listContext` has no side effect and takes no control lease.** It reads
   and projects; it cannot enrol, open, or mutate anything.

## Consequences

- ADR 0009's outward clause is narrowed: a workspace **reference** remains an
  opaque id in both directions, and paths *within* an already-enrolled
  workspace may be projected as relative paths under bound. The inbound rule is
  untouched — the browser still cannot name a directory.
- The browser learns project structure for enrolled workspaces. This is
  accepted: the pairing is owner-only over loopback, the agent already reports
  paths in tool details, and a paired browser can already ask the agent to list
  files in prose.
- `@` is a text convention, not a protocol feature. If the agent's mention
  syntax changes, only the inserted string changes; no host or wire change is
  needed.
- A very large workspace returns a capped, query-filtered list rather than a
  tree. Completion is best-effort by design.

## Alternatives considered

- **ACP `resource_link` content blocks.** Requires the host to build an
  absolute URI per mention and expands `session/prompt` beyond plain text for
  one feature. More disclosure and more machinery than the CLI convention
  needs. Rejected.
- **Opaque file ids instead of relative paths.** Keeps ADR 0009 literally
  intact, but the user must still *see* the path to choose it, so the
  disclosure is identical while the host gains a mapping table and the inserted
  text still has to be a path for the agent to understand it. Pure ceremony.
  Rejected.
- **Client-side only, no listing.** `@` inserts a bare sigil and the user types
  the path blind. That is what exists today, and it is why `@` appears broken.
  Rejected.
- **Reuse `toolStart.detail` history to guess candidates.** Only knows files
  already touched, so it cannot complete anything on a fresh conversation.
  Rejected.
