# Live terminal and browser qualification

The 2026-10-14 trial passed 22 checks with the exact native candidate recorded in
[`evaluation/terminal-continuity-2026-10-14.json`](evaluation/terminal-continuity-2026-10-14.json).
It uses the official Grok Build 1.0.52 interactive terminal, the existing PWA
artifact, real Noise transport and a local synthetic provider. It makes no paid
inference requests and does not mount the user's Grok profile or workspace.

Five user turns alternate between the terminal and browser. Both surfaces see
the live messages, and a browser reload preserves each answer exactly once. A
browser-originated tool request appears as a permission in both surfaces and
survives another browser reload. Selecting **Yes, proceed** in the terminal
grants that request once; the isolated effect file contains exactly one line.
A subsequent terminal-originated request for exactly the same command still
requires approval. Denying it in the browser cancels the terminal turn and
leaves the effect file with just the original line. There are six
provider requests: five initial turns and one continuation after the allowed
tool; denial does not call the provider again.

## Required terminal mode

Start the terminal with `grok --leader`, using the same account, `GROK_HOME` and
leader socket as Spanreed. `--leader-socket` alone does not enable that mode.
For an embedded terminal, finish its turn, exit and reopen it using
`grok --leader --resume <session-id>`. Do not run two independent engines over
the same session. The PWA's terminal help and `spanreed remote doctor` already
describe this requirement; socket presence is not proof of live attachment.

An explicit negative trial with a fresh home and no leader flag confirmed this
boundary: persisted history was visible in the browser, but the embedded
terminal did not receive the browser's next turn. Enabling `[cli].use_leader`
also passed the basic bidirectional trial. The recorded final trial uses the
explicit flag and includes permissions.

## Running the harness

Set `REMOTE_QA_NATIVE` to the candidate's exact CLI executable,
`REMOTE_QA_GROK` to the official unwrapped Grok ELF,
`REMOTE_QA_CHROME` to the unwrapped Chrome executable and
`REMOTE_QA_OPENSSL` to OpenSSL. `REMOTE_QA_PLAYWRIGHT` may select an installed
`playwright-core` module. The runner currently requires the recorded official
Grok 1.0.52 hash; a new version needs its own qualification.

```sh
bun scripts/qa/qualify-terminal-continuity.ts \
  /tmp/terminal-qa-unique /path/to/frozen-artifact/.vercel/output
```

The new output directory must have a short path for Unix sockets. Syl owns a
separate tmux session and hidden Sway compositor; Chrome uses a separate profile.
The fixture sets `SHELL` to the Nix Bash executable so that the bounded tool can
run inside its mount namespace. The terminal's permission selection is checked
before Enter; it never selects the CLI's always-approve option. Cleanup closes
the owned sessions, verifies exit of the directly launched subprocesses, and
removes temporary host state, pairings,
browser profile and TLS private key. Synthetic evidence remains in the private
output directory.

This tests application behavior using a laboratory certificate, with Chrome's
certificate exception confined to the isolated browser. It does not qualify
public TLS, Tailscale, an existing personal terminal, a real provider, simultaneous
terminal/browser submissions during one turn, or a process crash during an
effect. It inventories intercepted HTTP requests but not WebSocket or service
worker egress, and does not inventory every descendant process after cleanup.
Those are separate checks. The PWA bytes are the deployed artifact;
this additional test script does not rebuild or alter them.
