# Grok Desktop Portable UI

Portable shares the **Grok Desktop design system** where available and does
**not** invent a second visual language. This note records what differs because
production UI is a Work-only shell at **`https://desktop.grok.me`** talking to
**`grok-bridge` on loopback** (ADR light 0016).

## Scope

| In scope | Out of scope |
|----------|----------------|
| Landing when bridge missing / LNA blocked | Desktop Chat, Research, Guest |
| Setup / pairing to local bridge | Multi-window chrome |
| Workspaces + session list/resume | Editing CLI configuration |
| Live Work transcript, tool calls, permissions | Cloud execution of the CLI |
| Conversation sidebar, review panel, prompt queue (ADR 0011) | Editing a queued message in place |
| Configured MCP integrations, read-only projection | |
| Recovery banners, review records | |

## Probe states (hosted UI)

Before Work is shown, the SPA probes the bridge:

| State | UI |
|-------|-----|
| `bridge_missing` | Landing: install + `grok-bridge serve` |
| `blocked_lna` | Landing: allow local network for this site |
| `needs_pairing` | Pair instructions; consume `#pair=` from `grok-bridge open` |
| `ready` | Work shell (home / session / setup routes below) |
| `error` | Bounded diagnostic; no silent agent actions |

## Source of truth

1. **Tokens, type, spacing, motion, a11y:** shared design tokens / desktop
   DESIGN.md where referenced by the monorepo.
2. **Implementation:** `apps/web/src/` (`styles.css`, `components/ui.tsx`, views).
3. **Markdown:** `MarkdownMessage` — GFM, allowlist, `skipHtml`, https-only
   links, no images.
4. **Protocol shapes:** [protocol.md](protocol.md). Anything the browser
   renders arrives through it, already bounded by the bridge.

## URL model

**Document origin (production):** `https://desktop.grok.me`.  
**API origin:** `http://127.0.0.1:<port>` (or `localhost`).

Client paths name **which surface** is open (refresh/share):

| Path | Surface |
|------|---------|
| `/` | Landing **or** Home (projects + sessions) when `ready` |
| `/s/:sessionId` | Open conversation (opaque agent id only) |
| `/setup` | Setup (optional deep link) |

Never a filesystem path. The **site** (or fallback bridge) serves `index.html`
for these client routes
so a hard refresh does not 404. History API keeps the bar in sync with the
active `sessionId`.

## Shell

- Content sits on a raised surface inset from the canvas (`rounded-xl`, hairline
  border, Level-1 shadow), so the app reads as one sheet of paper on a
  workspace rather than a page running to the window edge.
- Chrome is a thin 44px topbar on that surface: product label **Work**, optional
  workspace **display name** (never a path), status chips, theme control.
- Content measure: `min(760px, 100%)` centered (DESIGN §6 chat measure).
- Status is **never colour alone**: whenever a chip is drawn it carries a text
  label (DESIGN §2).

### Resting state draws nothing

A chip appears only when the state is *not* the resting one:

| State | Chip |
|-------|------|
| Connected | none — `Disconnected` only |
| Idle | none — `Running` / `Needs review` only |
| Project available | none — `Unavailable` only |
| Tool call succeeded | none — `Failed` / `Truncated` / `Read…` only |
| Conversation idle | none — `Working` / `Needs you` only |

A permanent green `Connected` beside a permanent `Idle` trains the eye to skip
the one corner where a disconnect has to be noticed, and thirty identical
`Ready` chips on a project list say nothing at all. Nothing is lost for
assistive tech: the shell's polite live region still announces connection and
phase on every change, and the session view announces the latest tool outcome.

This is a presentation rule, not a weakening of DESIGN §2 — no state is ever
conveyed by colour alone.

### Theme (light / dark / system)

Light ships both themes. Preference is browser-local only
(`localStorage` key `grok-light.theme`: `system` | `light` | `dark`). It is
not host state and never crosses the protocol.

| Preference | Behaviour |
|------------|-----------|
| `system` (default) | Follow `prefers-color-scheme` |
| `light` | Force light tokens |
| `dark` | Force `.dark` token remaps on `<html>` |

- Boot script in `apps/light/index.html` applies the class before first paint
  (no FOUC).
- Toggle lives in WorkShell trailing chrome and on Setup; it cycles
  system → light → dark.
- Dark palette keeps the DESIGN.md green-gray family (~165°) and charcoal
  ink identity; only surfaces invert. Semantic tokens only in JSX — no raw
  hex in components. Token table: `apps/light/src/styles.css` (`.dark` block).
- Desktop remains light-first until it adopts the same remaps.

### Conversation sidebar

Sessions run concurrently (light ADR 0011), so Work has a left panel listing
the open ones. It is a work inbox, not a chat history, and two rules carry that:

1. **Order never changes with activity.** Rows are ordered by when the session
   opened and hold their place until closed. A conversation that starts working
   says so *in* its row; it does not move. A list that reshuffles on every
   token is a feed the user cannot point at.
2. **State is colour and a label**, never colour alone (DESIGN §2).

Rows are titled by the conversation's opening message, because several
conversations commonly run in one workspace and would otherwise be identical.

The model is adapted from T3 Code's Sidebar V2 (MIT). Branch, pull request, and
diff columns are **not** put in every conversation row: the selected session's
bounded review data belongs in the right panel described below. Settle/snooze
is not adopted either — Light closes conversations rather than parking them.

## Screens

| Screen | Role |
|--------|------|
| Setup | Unpaired, expired pair, host down, protocol mismatch, WebKit block (ADR 0008) |
| Home | Projects rail (ADR 0014) beside the selected project's sessions (ADR 0010). **No** integrations strip on this surface |
| Session | Sidebar of open conversations, transcript with inline tool calls, composer with queue, Changes / Context panel, review banner |
| Permission dialog | `allow-once`, `reject-once`, `allow-edits-session` only (ADR 0007) |

### Home

Choosing *where* to work and choosing *what to resume* are one decision, so
they are one screen (`views/HomeView.tsx`): a 240px projects rail beside a
session column that takes the remaining width, left-aligned and capped at
1440px. They were two screens, and a project switch cost a round trip through a
back link while the two halves could never be seen at once. Below `lg` the
columns stack.

The page is **not** centred. A centred 1024px column parked the rail in the
middle of a wide display; the rail is navigation, and navigation belongs
against the edge the eye starts at. The cap only stops the session list running
to a 4K edge.

**Projects rail.** Search field, then rows with avatar letter + **display
name** (never a path, never a session count — the column beside it *is* the
count). Rows are the projects **enrolled in Light** (ADR 0014); a folder used
only in the Grok Build CLI is not listed and its name never reaches the
browser. Add is the host directory picker, or `grok-light workspace add`. An
enrolled directory that has gone away stays listed, marked unavailable. The
rail keeps its own scroll and sticks, so thirty projects cannot push the
session column below the fold.

**Session column.** Search, then rows grouped **Today / Yesterday / Older**
with sticky headings (`groupSessionsByDay`); a session the host could not date
falls to Older rather than being hidden or promoted. Empty buckets draw no
heading. **Older rows carry a date** (`Jul 12`, with the year across a
boundary) because that heading spans two days to two years and a bare clock
time answers nothing; Today and Yesterday keep the clock alone, since their
heading is already the date.

**The row is the action.** No per-row Resume button: sixteen sessions used to
mean sixteen filled buttons, which weighed more than the titles they sat beside.
Refresh and Add are icon buttons in the section headers.

### Composer and queue

The composer is a docked raised card (OpenCode-inspired layout, Grok tokens)
at the bottom of the transcript column. Implementation:
`apps/light/src/views/composer/`.

The workspace display name remains in shell chrome and conversation titles stay
in the sidebar. The composer does not repeat either label above the input.

A message written while the agent is working is **queued**, not refused.
Pressing Enter mid-turn used to do nothing and say nothing about why.

| Control | Rendered as | Meaning |
|---------|-------------|---------|
| Queue (Enter) | filled button | Waits for the turn in flight, then sends |
| Send now (`Ctrl+Enter`) | icon button | Cancels the running turn so this goes next |
| Stop | icon button | Cancels the turn and sends nothing |

`Send now` and `Stop` are icon-only because they are *modifiers* on the one
action the user came to take; as three equal filled buttons they outweighed the
message being written. Their meaning is carried by `title` as well as the
accessible name — an icon alone does not explain itself, and DESIGN §5 keeps
disabled buttons hoverable precisely so the tooltip can.

Waiting messages are listed above the composer card and can be taken back out
before they run. The queue lives in the host — it is the side that knows when a
turn ends, and a queued message is not a draft: the user pressed Send and
believes it is committed, so it survives a reload. `Send now` carries the
meaning the qualified CLI gives `Ctrl+Enter`: it does not jump the queue, it
clears the way.

A draft, by contrast, belongs to its conversation and is deliberately **not**
persisted. Switching conversations shows that conversation's own draft; a draft
held in one place followed the user across a switch and could be sent to a
conversation they were not looking at when they wrote it.

Authority remains disclosed in setup and the empty session state. It is not
repeated as a persistent composer footnote. Light is still a control surface,
not a sandbox — do not word the UI as confinement or full path mediation.

**Model + reasoning:** a 44px control bar along the bottom of the card selects
host-projected **Grok-only** models and, when supported, reasoning effort
levels. Changes call `setSessionModel`. Both are native `<select>` styled as
ghost pills: a hand-rolled menu would need a popover primitive Light does not
have, and would have to re-earn the keyboard and screen-reader behaviour the
platform control already has.

### Completion menu (`@` and `/`)

A menu floats above the composer while a mention is being typed. Parsing rules
live in `services/mentions.ts` and are tested directly, because getting the
replaced slice wrong is what makes a completion feel broken — it eats a
character, or leaves the sigil behind.

| Sigil | Offers | Source |
|-------|--------|--------|
| `@` | Workspace-relative paths | `listContext` (light ADR 0013) |
| `/` | The agent's slash commands | `commandsUpdated` event |

- A trigger only counts at a **word boundary**, so `me@example.com` and a URL
  do not open the menu.
- `/` is a command **only at the very start** of the message, matching what the
  CLI accepts. Elsewhere it is a path separator, and the scan continues past it
  so `@src/views/…` still completes.
- **Keyboard first.** The composer keeps focus throughout and forwards
  ↑/↓/Enter/Tab/Escape. Enter belongs to the menu while it is open, or
  accepting a completion would also send the prompt. Escape closes the menu for
  *that* mention only; the next edit reopens it.
- Ranking is prefix-first, then shorter-first, with a fallback match on the
  last path segment so `home` finds `src/views/home.tsx`.
- **Nothing opens in bash mode**: there `@` and `/` are ordinary shell
  characters.
- The textarea keeps its native `textbox` role rather than becoming a
  `combobox` — this is a multiline prompt first and a completion field second —
  so the menu is tied to it with `aria-controls` and `aria-activedescendant`.
- A chosen mention is only ever **text**. The host neither parses nor acts on
  it; the agent resolves it, exactly as in the CLI.

**Bash mode:** a leading `!` (CLI bang mode) switches the composer to shell
chrome; submit sends `bash: true`. The host runs the command in the workspace
cwd (not as agent chat) and streams the capture back. Exit matches the Grok
Build pager: **empty body + Backspace** (also Esc / Ctrl+W / U / C) returns to
normal prompt mode.

**MCP control** sits **outside** the raised composer card (to its left). It is
ambient context for the conversation, not a prompt control. The menu lists
deduplicated host-projected MCP **names** and config state only (enabled → green
`on`, disabled → red `off`; never color alone). Skills are not repeated in the
session UI. The menu closes on outside click and Escape. Light does not probe
runtime health of MCP servers.

**Composer toolbar** (inside the card): a **+** control inserts `@` so the
workspace-file mention menu opens (never a browser file path — light ADR 0013),
then model / effort / send.

### Transcript navigation

Hybrid scroll keeps the reader in control of long Work conversations:

- First open of a conversation pins to the latest message.
- Each conversation’s stickiness is tracked with a synchronous ref so switching
  chats cannot apply chat A’s “stuck to end” to chat B.
- Switching away saves that conversation’s offset for the tab; switching back
  restores it (or the end, if the reader was following the stream).
- New content auto-scrolls only while the viewport is stuck near the bottom, or
  after the user sends. A **Latest** chip appears when they have scrolled up.
- A **compact checkpoint stack** (hidden below 680px) marks each user turn in
  the content gutter, inset from the native scrollbar; activating a mark jumps
  to that message. Browser-local only — not host state.

### Changes and Context panel

The topbar toggles a read-only right panel for the conversation on screen. At
wide sizes it is a 400px third column; below 1180px it overlays the session
surface so the transcript is not squeezed below its reading measure. The panel
has two top-level tabs:

- **Changes** offers only comparisons the host can currently validate: `Git`
  (`HEAD` to index + working tree), `Branch` (default-branch merge-base to the
  working tree), and `Last turn` (ACP diff blocks captured from the latest
  turn). Unsupported or malformed modes are omitted rather than rendered with
  guessed data. A compact file rail selects one file; the complete bounded
  unified patch is rendered as text below it. Binary, oversized, unavailable,
  omitted, or unattributed changes are labelled explicitly and make the result
  partial. Git patches come from read-only host `git2` inspection of the
  enrolled workspace; generic stdio ACP does not expose the pager's internal
  Git methods.
- **Context** shows only fields supplied by standard ACP session-open responses
  and updates: model, available context-window state, cumulative live usage,
  API duration, and trustworthy cost. Missing data or cost is `—`, never
  invented as zero; partial or incomplete usage never produces a cost claim.

The browser sends only an open `sessionId` and a closed mode. It cannot supply a
path, Git root, ref, branch, ACP method, or limit. Patch text is held in memory
only and is purged when the session closes; after a host restart, `Last turn`
stays unavailable until another turn completes.

### Transcript

- **The agent's answer has no bubble.** No card, no border, no shadow, full
  column width. The reading measure already bounds it; a card as well made
  every answer read as an object on the page rather than the page itself.
- **The user's message is a right-aligned soft fill**, `max-w-[min(82%,64ch)]`,
  no border — the fill *is* the boundary.
- **No `YOU` / `AGENT` rubric above each turn.** Alignment and treatment already
  say who spoke. The distinction is kept for assistive tech as an `aria-label`
  on the turn.

### Agent plan

When the agent publishes an ACP plan, the host projects bounded steps
(`content` + closed status) as `planUpdated.entries`. The session column shows
them as a living checklist (`PlanRow`) below the transcript timeline — replace
semantics, not append — so dropped steps disappear. Content is agent text only.

### History repair

`Check history` runs `DiagnoseSession` (dry-run). Corrupt pairing shows
`SessionRepairBanner` with an explicit **Repair history** action
(`RepairSession` apply). Copy states this rewrites agent history only — not
filesystem undo and not retry of `interrupted_needs_review`. Unsupported CLI
versions get an honest banner without a repair button (light ADR 0015).

### Tool calls

A row says what the call did, not which function was invoked. `run_terminal_command
· Done` named the mechanism and hid the act. Presentation is a one-line
collapsible row (`ToolRow`): action label · name · detail, with provider and
may-change markers, and the full detail expandable under a rail.

**Rows sit *in* the transcript**, at the point in the conversation where they
happened. They used to be collected into a "Tool calls" card pinned below every
message, so a reader could see that a command ran but never which turn ran it.

Ordering is carried by `seq` on both `TranscriptEntry` and `ToolEntry`, stamped
from the host's `eventSequence` in `sessionProjection.ts`. A tool keeps the
sequence of the event that *started* it, so a restart cannot slide the row away
from its turn; rehydrated snapshot history is numbered backwards from zero so
it always sorts before whatever sequence the host resumes at. No protocol
change was needed — the sequence is already on every envelope.

- The action (read, edit, execute, search, …) chooses the icon, from a closed
  set: the value is agent-supplied and must not pick its own presentation.
- A call that can change something says so; one the agent declares read-only
  stays quiet.
- A tool from an MCP server names it, so the user's own integrations are
  distinguishable from the agent's built-ins.
- One bounded line shows the command, path, or query — rendered as text, never
  as markup.
- **A call that simply worked draws no chip.** `Failed`, `Truncated`, and the
  running `Read…` do. A chip on every successful read is a column of green that
  trains the eye to skip the one that failed — which is the same mistake, in
  reverse, as collapsing failed into Done.
- Default open: still running, failed, truncated, or may-change. Quiet
  successful reads start collapsed so the transcript stays scannable; the user
  can expand any row. Re-applying the default is keyed on the *answer*, not on
  every field it derives from, so a progress event cannot undo a user's own
  collapse.

### Integrations

MCP servers from the user’s Grok Build may still be projected by the host
(name, enabled, remote|local only — see `integrations.rs`). They are **not**
shown on the Home projects rail (hero is the project list). Scoped global vs
project tools/skills belong on session/project chrome in a later pass.

## Streaming & recovery

- Streaming: caret + Running chip; no bouncing dots (DESIGN §7).
- End of turn: host `sessionStatus: idle` + SPA backstop on command complete.
- WS drop: ConnectionBanner + automatic reconnect while pairing cookie holds.
- `interrupted_needs_review`: ReviewBanner; acknowledge only, never retry. A
  record names the conversation it belongs to and offers to open it, unless
  that conversation is already on screen or no longer open.
- Reload: the host gives a newly attached tab a snapshot per open conversation
  and re-raises every decision still owed, because the browser holds neither.

## Security presentation

- No filesystem paths in UI copy that came from the wire as paths.
- No persistent permission grants on screen.
- Model text is untrusted: markdown allowlist only, and tool names, details,
  and actions are rendered as text with the action drawn from a closed set.
- No integration address, command, or credential on screen.
- Errors use `role="alert"`; connection/status use `aria-live="polite"`. There
  is exactly one polite region per concern — shell connection/phase, and the
  latest tool outcome — because a live region over the whole tool list
  re-announced every row whenever any one of them changed.

## Layout influences

The information architecture, density, and restraint are modelled on the
OpenCode web interface: one home screen rather than two, rows instead of
buttoned list items, resting states that draw nothing, auxiliary controls
revealed on hover, and tool calls inline in the conversation.

The **visual language is not** borrowed. Light keeps the Grok Desktop system:
IBM Plex Sans/Mono (never Inter — DESIGN §9), the green-gray token family,
weights 400/500/600, the three radii 5/7/9, tinted matte elevation, and DESIGN
§7 motion limits (120–200 ms micro, `transform`/`opacity` plus colour only,
never width or height). Anything from that reference which conflicts —
per-character shimmer, spring height collapsibles, `0fr → 1fr` width
transitions, 0.5px pure-black hairlines — is deliberately not adopted.

Shared row, search, and icon-button recipes live in `components/ui.tsx`
(`rowClass`, `Row`, `SearchField`, `IconButton`) so density is defined once
rather than re-derived per view.

## Working agreement

Same as DESIGN.md §10: tokens first, primitives second, views third. Prefer
extending `apps/light` until Desktop and Light both need a shared package.
