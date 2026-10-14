# Current Remote candidate: physical-device evaluation

This checklist applies the current direct, multi-device release contract in
`public-release-plan.md` to the original `remote-evaluation.md` program.
The older private HTTPS observations in `remote-mobile-qualification.md` keep
their original artifact attribution. They do not qualify the current direct
PWA, durable drafts, push, share reception or voice candidates.

## Entry conditions

Finish the automated integration, recovery and browser checks first. Record the
exact served PWA manifest, native binary, Android and
Chrome versions, origin, device serial, and installation mode. The owner must
have a single available 45–60 minute window; previous phone availability and
previous successful typing are not evidence of participation in this run.

Use synthetic projects, conversations and canary text, with separately paired
desktop and mobile browser principals belonging to the owner. The deployed
candidate connects directly over trusted HTTPS/WSS and Noise to the user's
Spanreed through Tailscale. It needs no Fabrials login. Pair a second isolated
host for endpoint isolation checks; never use unrelated private conversations.
Explicitly distinguish the deterministic ACP fixture from a dedicated real Grok
session. Keep publication disabled; its host/PostgreSQL/S3 plane has a separate
qualification. Browser fixtures using local TLS or ADB reverse do not qualify
the deployed transport. Record account/publication builds only when exercising
that separate optional surface.

Do not read another application, clipboard or conversation to supply test data.
Do not change Proton Pass, Tailscale policy, Android security settings or daily
accounts. Record and restore only forwards, temporary site permissions and test
applications created for this run. Never include private pairing URLs, cookies,
keys or browser storage contents in exported reports.

## Session sequence

| Approximate time | Exercise | Required evidence |
|---|---|---|
| 0–5 min | Open the observed test target, pair, install or verify the PWA, record portrait viewport and keyboard | Exact target id, secure context, display mode, artifact hashes; shortcut and WebAPK distinguished |
| 5–12 min | Opt into drafts, type and correct canaries, reload, switch between the two authorized hosts and return | Exact unsent text; consent and drafts isolated by endpoint/host key/installation/browser/session; no prompt dispatched |
| 12–20 min | Share text, URL and a small synthetic image through Android's actual share sheet; repeat an intent, cancel, close/reopen and choose the destination | Typed attachment, explicit editable review, duplicate behavior, no automatic dispatch; compare task steps against copy/open/paste |
| 20–28 min | Explicitly enable notifications and emit generic fixture activity in foreground, after Home, and after task closure | Provider receipt and actual device notification recorded separately; minimal content; click resolves only while authorized |
| 28–43 min | Paired typing/dictation tasks and answer playback | Task timings include review/correction; no automatic send; participant reports audible start/pause/stop and comprehension |
| 43–52 min | Browse an approved project; enqueue synthetic turns from mobile and desktop, exercise targeted stop and a stale model change; revoke the other browser and this device | Both devices can enqueue, one active turn per session, shared FIFO, paused queue preserved after stop, explicit configuration conflict, revoked principal unable to mutate |
| 52–60 min | Recovery observation, utility ratings and cleanup | Candidate-bound participation receipt, expected OS limitations, removed test state and stopped owned processes |

Timing is a schedule, not a reason to mark unfinished checks passed. Pause the
sequence when the owner uses the phone. A requested permission that the owner
declines is a valid refusal-path observation, not a passed delivery/audio test.

Run the recovery cases separately if they exceed the interactive window: block
Fabrials origins while retaining the paired private endpoint, reopen the
installed shell offline, reconnect after Wi-Fi/mobile handoff, and qualify the
N/N−1 service-worker update and rollback with a saved draft and an active turn.
Record the source and license links for each loaded shell. Lose a command reply
deliberately and check its durable receipt from the same principal; do not send
it again automatically. A second principal must see the resulting host message
without being able to claim the first principal's private receipt.

## Voice comparison

Use ten short, predefined tasks with five typing-first and five dictation-first
pairs. Keep the target meaning equivalent within each pair, and include normal
Spanish prose and code terms such as branch names, file paths, an HTTP status,
and a command. End timing only when the owner accepts the corrected draft.
Record per-task elapsed time, corrections, final correctness and input method;
recognition duration alone does not establish a benefit. Clear each canary
explicitly and never submit a model command.

The fixed task order, texts and required observation fields are in
[`experiments/remote-mobile-tasks.json`](experiments/remote-mobile-tasks.json).
Each pair uses the same visible target in both methods. Meaning can tolerate
punctuation differences; literal code terms must match exactly. Record a refusal,
unsupported recognition or unfinished correction as such, without replacing its
timing with zero or dropping it from the report. This is one participant's
comparison, not a population-level usability claim.

Playback requires an audible short answer, pause/resume/stop, changing the
session while speech is active, and a long answer with ordered chunks. Ask one
content question to establish comprehension. A mocked SpeechSynthesis callback
or a visual playing indicator cannot substitute for audible output.

## Failure and recovery distinctions

- Losing a browser target is not evidence that Android killed the process.
  Record process identity before and after an actual background-process death,
  reopen the same origin/profile, and compare the last confirmed durable draft.
- Closing a PWA task, backgrounding it, killing an eligible background process,
  and force-stopping a package are distinct. Force-stop may intentionally block
  notifications until a manual launch; do not label this as ordinary closure.
- The short session cannot qualify eight-hour suspension. A 30-minute suspension
  also needs its full duration without reopening the relevant task. Leave these
  observations pending when the schedule does not provide that window.
- CDP offline mode and ADB reverse do not demonstrate a radio handoff or a
  Tailscale route. Record the actual transport and public/private origin.
- A successful push-provider request is not proof that Android displayed it.
  Expiry and revocation must also be checked on notification click.
- Microphone permission, recognition failure, silence, cancellation and late
  callbacks are separate checks. Synthetic browser tests cover state handling;
  this session must establish real recognition and audio behavior.

## Decision receipt

For each optional feature, record the participant's utility from 1 to 5 and the
observed task benefit against the declared baseline. Ratings alone cannot fill
missing correctness or performance checks. No participation means inconclusive;
never reuse ratings or typing observations from a previous candidate.

Keep all optional variants off in ordinary builds until their individual
receipts support acceptance. Preserve evidence of a rejection or missing device
capability, including unavailable iPhone, macOS and hardware DeX tests.
