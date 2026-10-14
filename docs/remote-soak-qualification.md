# Direct remote soak qualification

The bounded runner qualifies the exact r3 shell against a real native host with
synthetic ACP traffic. The short pilot passes; a 24-hour result is a separate
piece of evidence and must not be inferred from that pilot.

## Workload and invariants

`scripts/qa/direct-soak.ts` extends the existing direct browser qualification.
Two independent browser contexts stay connected to one native fixture. Each
cycle pauses the shared queue, submits distinct A/B messages, resumes A, reloads
B during the active turn, disconnects both private WebSockets, reconnects, drains
the queue and answers a permission request from the other device. Permission
answers alternate between Allow once and Deny. The runner checks stable active
turn and receipt IDs across reconnects, distinct device origins, exactly-once
transcripts, three completed receipts per cycle, an empty queue and zero
uncaught browser errors. These permissions are synthetic and execute no tool.

The default long run is 86,400 seconds, one cycle every 300 seconds, with a
1,000-cycle safety ceiling. Reaching a smaller cycle ceiling does not qualify
24 hours. Each active cycle has a 75-second deadline; after failure the runner
closes both pages, waits up to five seconds for the active cycle to settle and
records the outcome before teardown. There is no paid inference.

## Bounded execution

`scripts/qa/run-direct-soak.py` launches a transient systemd user **scope** with
6 GiB MemoryMax, no swap, 512 TasksMax, 200% CPUQuota, KillMode=control-group,
a 15-second stop timeout, and RuntimeMaxSec equal to the requested duration plus
180 seconds. The wrapper records the actual unit properties. A private user and
mount namespace contains a 2 GiB tmpfs for state, profile, fixture binaries and
TLS keys. RLIMIT_NOFILE is 4,096 per process. None of these settings changes the
host's persistent configuration.

The scope is deliberate: the shared native runtime moves an ACP agent out of a
service so that real Grok sessions survive Spanreed restarts. A service wrapper
therefore allowed the synthetic agent to leave the test's limits. Running the
unchanged fixture inside a scope preserves its runtime semantics and containment.
Chrome and Syl receive an unavailable session-bus address so Chrome cannot move
itself into a desktop application scope. Both earlier escapes were caught by
the cgroup membership assertion. TasksMax was raised from 256 to 512 after the
256-thread limit recorded kernel denials. This counts threads as well as
processes; the independent sampled process ceiling remains 96.

Every five seconds, and at cycle boundaries, the runner checks native, Chrome
and Syl process families, PID start times and cgroup membership. Sampled
thresholds are 3 GiB browser RSS, 512 MiB native RSS, 512 MiB runner RSS,
96 child processes, 4,096 child file descriptors, 512 MiB native state and
2 GiB browser profile. CPU ticks are recorded without a CPU-rate claim. These
sampled limits complement the kernel limits; they are not a product capacity
measurement or a bound on storage I/O.

Checkpoints use atomic replacement and file/directory fsync. Cycle and resource
records append to JSONL files. Evidence copying skips unchanged files and
appends only new JSONL bytes; individual files are limited to 16 MiB and copied
evidence to 63 MiB, reserving 1 MiB for final receipts within the 64 MiB budget.
Logs are copied only at the end, with a 256 KiB tail. No private browser/native
state or TLS key is copied out of tmpfs.

The outer wrapper stops only its own scope, verifies an empty cgroup and empty
outer scratch directory, and looks for its inherited run marker or private
mount namespace in readable same-user processes. Unreadable process counts
are reported. A sampled inventory is not hostile-process containment: it does
not prove that an adversarial child cannot scrub its marker or change namespaces.
The children in this test are trusted, sealed local binaries.

## Exact-source relationship

The tested r3 artifact remains unchanged:

| Component | Identity |
| --- | --- |
| Portable shell | `abe4f35895aacda102a09c3b50475379febf3b6c` |
| Native release source | `e6d9cc8cb076d7896edec98ee7338d4d4d8f1f7a` |
| Deployment manifest SHA-256 | `184a9e1bdabb95454e9be0842460dc7a3cafce35395500e271fccabac6803363` |
| Index plus service worker SHA-256 | `1f2dc241bdebeea17eb9f2373c86676f6c1e498c8976018307c01ae237a69423` |

Canonical libs `ea695a14dca7a19335a50271088bd92ddd4f1f16` differs from r3 libs
`ee3060d` only in the browser fixture example: its lifetime is configurable
between 60 and 90,000 seconds, default 1,800. This run requests 90,000 seconds.
No native runtime source changes, Spanreed subtree sync or r3 rebuild occurred.
The wrapper requires that exact one-file diff and a clean libs tree, records
fixture source and binary hashes, copies both the fixture and fake agent into
tmpfs, and verifies the copied bytes before launch. It also records Portable
commit/dirty state and the hashes of all four QA scripts. This is recorded local
build provenance, not an independent reproducible-build attestation.

## Controls completed on station

Evidence summary: [direct-soak-controls-2026-10-14.json](evaluation/direct-soak-controls-2026-10-14.json).
Full reports are under
`/home/friend/.local/share/fabrials-remote-release/2026-10-14/`.

| Control | Observation |
| --- | --- |
| Final guarded pilot, `soak-final-guard-pilot` | Four cycles, 102 soak assertions and 102 baseline checks; duration reached; zero browser errors; empty cgroup, no matching readable processes and empty outer scratch after cleanup. |
| Duplicate injection, `soak-negative-duplicate` | Cloning an actual accepted message fails `exactly_once_transcript`; historical short helper run before the final hard envelope. |
| RSS negative, `soak-negative-rss` | A 1 MiB native ceiling fails `native_rss_limit`; historical short helper run before the final hard envelope. |
| Kernel task negative, `soak-bounded-task-limit` | TasksMax=64 prevents fixture startup; `pids.events` records five denials; cleanup empties the cgroup. |
| Final guarded SIGKILL, `soak-final-guard-kill` | Bun is killed after the first durable soak checkpoint; its failure remains a failure, with completed-cycle evidence preserved and the scope retired. |
| Dead-launcher runtime control, `soak-runtime-dead-launcher` | A five-second scope stays alive after killing its launcher, then empties at 5.16 seconds through its effective RuntimeMax; uses a sleep process, not the browser workload. |

The old service pilots and old SIGKILL result predate strict descendant cgroup
checks and do not prove containment. The later strict tests caught those gaps;
the final guarded scope pilot and SIGKILL replace their containment claims.

## Reproduction and completion

Run from this Portable checkout with the existing Nix Chrome package, matching
r3 source verifier, Playwright module and OpenSSL executable:

```sh
python scripts/qa/run-direct-soak.py /absolute/fresh/private/evidence-directory \
  --artifact /absolute/r3/artifact \
  --spanreed /absolute/r3/spanreed-source \
  --libs /absolute/remote-libs \
  --chrome /nix/store/<package>/bin/google-chrome-stable \
  --playwright /absolute/node_modules/playwright-core/index.mjs \
  --openssl /nix/store/<package>/bin/openssl \
  --duration-seconds 86400 --interval-seconds 300
```

The directory must not already exist. For a short pilot use ten seconds and
one-second intervals. For the abrupt-death control add `--kill-after-seconds 20`
to a 60-second run; its expected exit is nonzero. The checkpoint, final report,
unit result, actual properties and bounded-run receipt must be reviewed together.
A full PASS requires the requested duration, invariant checks, resource bounds
and successful cleanup. A running checkpoint is progress, never a completed
24-hour result. Exact r3 multi-host evidence is described separately in
[remote-multihost-qualification.md](remote-multihost-qualification.md).

The [r3 launch receipt](evaluation/soak-r3-started-2026-10-14.json) records the
86,400-second run started on 2026-10-14 at 03:13:42 UTC from clean QA commit
`480f1be`. Its expected finish is 2026-10-15 at 03:13:42 UTC (05:13:42 in Paris).
The scope is `fabrials-direct-soak-418441350551.scope`; evidence is in
`~/.local/share/fabrials-remote-release/2026-10-14/soak-24h-r3-20261014/`.
At launch the first cycle passed.

**Result: failed.** The run completed 86 cycles and 37,777 checks, then failed
during cycle 87 at 10:23:46 UTC with `permission_transcript_not_duplicated`.
Resource bounds, receipts, queue drain and browser errors held. It is not a
duplicate: a run with one-second intervals reproduced it at the same cycle in
about four minutes, and an instrumented copy of the harness recorded the
counts. Both pages reconnect every cycle. Once the host journal holds more than
1,024 events, a reconnecting client receives the bounded session snapshot,
which keeps at most 512 messages and 256 KiB of text. From cycle 86 both pages
showed 258 user messages and their oldest entry moved from the fixture history
to `SOAK_1_A`; in cycle 87 the first `permission` message left the window and
the cumulative count stopped at 86 against 87 expected. The harness assumed a
complete history. The product truncates silently on every reconnect, which is
a defect: the next candidate reports omitted messages and the check counts
visible plus omitted entries exactly. The instrumentation diff and per-cycle
counts are in `~/.local/share/fabrials-remote-release/2026-10-14/soak-triage-counts/`;
the frozen `480f1be` checkout is unchanged. A new 24-hour run is required.

From the next candidate the cycle check counts exactly instead of assuming a
complete history. It reads each device's transcript window: the visible
message articles plus the `data-omitted-messages` count reported by the host
must equal the messages produced by every completed turn, no `SOAK_n_A/B`
marker may appear twice, `permission` rows may not exceed the turns that sent
them, and both devices must show the same window and omission count. A run
against a host that drops history without reporting it fails this accounting.

The laboratory certificate bypass does not qualify trusted TLS, Tailscale,
physical Android/Apple behavior, deployed CDN routing, real push delivery,
Grok/provider failure modes, GPU performance, host suspension or OS reboot.
The 24-hour test must survive normal idle operation without changing the user's
desktop focus; machine shutdown or suspension invalidates that run's continuity.
