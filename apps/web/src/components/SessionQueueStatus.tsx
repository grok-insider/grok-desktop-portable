import {useState} from "react";
import {Button} from "./ui";
import type {SessionExecution} from "../services/sessionExecution";
import type {Operation} from "../services/protocol";

export function SessionQueueStatus({execution, enabled, reviewEnabled = enabled, onAction}: {execution: SessionExecution; enabled: boolean; reviewEnabled?: boolean; onAction: (operation: Operation) => Promise<void>}) {
  const [busy, setBusy] = useState(false);
  const [clearRevision, setClearRevision] = useState<number>();
  const [reviewTurn, setReviewTurn] = useState<string>();
  const run = async (operation: Operation) => {
    if (!(operation.kind === "reviewUncertainTurn" ? reviewEnabled : enabled) || busy) return;
    setBusy(true);
    try {await onAction(operation);} finally {setBusy(false); setClearRevision(undefined); setReviewTurn(undefined);}
  };
  const held = execution.queue.some(entry => entry.state === "originRevoked");
  return <section aria-label="Shared conversation queue" className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2 text-body-sm">
    <p role="status" className="min-w-0 basis-full sm:flex-1">{execution.uncertain ? "The previous action needs review. Check the conversation and terminal; pending messages will wait." : execution.externalTurnRunning ? "The terminal is running a turn. New messages will wait; stop that turn from the terminal." : execution.paused ? "Queue paused. Pending messages are kept." : "You can send from any paired device."}{held && " A revoked device has pending messages. Remove them or review them on the computer."}</p>
    {execution.activeTurn?.state === "uncertain" && (reviewTurn === undefined ? <Button disabled={!reviewEnabled || busy} onClick={() => setReviewTurn(execution.activeTurn!.turnId)}>Review interrupted turn</Button> : <><span>Confirm you checked its result. The queue will stay paused.</span><Button disabled={!reviewEnabled || busy} onClick={() => {void run({kind: "reviewUncertainTurn", sessionId: execution.sessionId, expectedTurnId: reviewTurn});}}>I reviewed the result</Button><Button disabled={busy} onClick={() => setReviewTurn(undefined)}>Keep paused</Button></>)}
    <Button disabled={!enabled || busy || execution.uncertain || held} onClick={() => {void run({kind: "setQueuePaused", sessionId: execution.sessionId, paused: !execution.paused, expectedQueueRevision: execution.revision});}}>{execution.paused ? "Resume queue" : "Pause queue"}</Button>
    {execution.queue.length > 0 && (clearRevision === undefined ? <Button disabled={!enabled || busy} onClick={() => setClearRevision(execution.revision)}>Clear pending messages</Button> : <><span>Remove the messages you selected?</span><Button disabled={!enabled || busy} onClick={() => {void run({kind: "clearQueuedPrompts", sessionId: execution.sessionId, expectedQueueRevision: clearRevision});}}>Confirm clear</Button><Button disabled={busy} onClick={() => setClearRevision(undefined)}>Keep messages</Button></>)}
  </section>;
}
