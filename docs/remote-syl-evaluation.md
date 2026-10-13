# Syl integration evaluation

The installed Syl MCP was exercised against synthetic terminal and browser
fixtures using `scripts/qualify-syl-contract.py`. Both fixtures run outside the
daily desktop and close their owned sessions and server. The browser trial
uses Syl's ephemeral browser backend, not the daily Chrome profile.

```sh
python scripts/qualify-syl-contract.py /path/to/new-terminal-evidence
python scripts/qualify-syl-contract.py /path/to/new-browser-evidence --surface browser
```

The terminal trial stopped before its first action: `tui_capture` returned an
observation token and a line count, but no terminal text. Reading the terminal
through an unrelated channel would not prove the MCP observation contract.
This is a dependency defect to resolve before qualifying a terminal workflow.

The browser trial observed two synthetic state changes, performed both actions,
rejected a reused observation token without repeating the effect, and refused
an action after closing the surface. The first browser fixture exposed another
limit: ordinary paragraph text was absent from the returned snapshot. The
second round placed both state values in headings, which the snapshot exposes.
That round establishes the heading/button workflow; it does not establish that
Syl returns every visible piece of page content.

These are direct MCP trials. They do not qualify the full Remote → Grok ACP →
Syl path, device revocation, disconnection during a dispatched effect, or
recovery without automatic replay. They do not justify enabling autonomous
desktop or Android control. Those checks and the user's assessment remain
required for the integration experiment.
