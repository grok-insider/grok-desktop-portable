import {useState} from "react";
import {Button} from "./ui";
import type {CommandReceipts, PendingCommand} from "../services/commandReceipts";

const descriptions: Record<PendingCommand["state"], string> = {
  sending: "Waiting for this computer to confirm the action…",
  uncertain: "The computer has not confirmed the action. It may already have run. Check its status before sending anything else.",
  unknown: "The computer has no receipt for this action. Check the conversation and terminal before deciding how to continue.",
  queued: "The computer received the message and queued it. Your draft may contain a copy.",
  running: "The computer received the action and is running it. Your draft may contain a copy.",
  completed: "The computer confirmed the action completed. Your draft may contain a copy.",
  reviewed: "The interrupted action was reviewed. Pending messages remain paused.",
  failed: "The action failed. It may have made changes before failing. Review the result before trying again.",
  removed: "The queued message was removed. Review the conversation before trying again.",
  needsReview: "The action was interrupted and needs review. Check the conversation and terminal; it will not be replayed.",
};

export function CommandReceiptNotice({receipts, sessionId, connected, clearDisabled = false, onClearDraft}: {receipts: CommandReceipts; sessionId: string; connected: boolean; clearDisabled?: boolean; onClearDraft: () => void}) {
  const [checking, setChecking] = useState(false);
  const [reviewed, setReviewed] = useState(false);
  const pending = receipts.pending.find(row => row.sessionId === sessionId);
  if (receipts.storageFailed) return <p role="alert" className="border-b border-border px-4 py-3 text-body-sm text-warning">This browser could not save the action receipt. Sending is paused to avoid repeating an action. Restore browser storage and reload before continuing.</p>;
  if (!pending) return null;
  const sending = pending.state === "sending";
  const clear = ["prompt", "promptContent", "interruptAndEnqueue"].includes(pending.kind);
  const finish = (discard: boolean) => {
    if (!reviewed || sending || checking || (discard && clearDisabled)) return;
    if (receipts.acknowledge(sessionId, pending.key)) {
      if (discard) onClearDraft();
      setReviewed(false);
    }
  };
  return <section aria-label="Unconfirmed action" className="space-y-2 border-b border-border px-4 py-3 text-body-sm">
    <p role="status">{descriptions[pending.state]}</p>
    {!sending && <>
      <Button disabled={!connected || checking} onClick={() => {setChecking(true); setReviewed(false); void receipts.check(sessionId).finally(() => setChecking(false));}}>{checking ? "Checking action status…" : "Check action status"}</Button>
      <label className="flex min-h-11 items-center gap-2"><input type="checkbox" checked={reviewed} disabled={checking} onChange={event => setReviewed(event.target.checked)} />I reviewed the result and understand this action will not be resent.</label>
      <div className="flex flex-wrap gap-2"><Button disabled={!reviewed || checking} onClick={() => finish(false)}>{clear ? "Keep draft and continue" : "Continue after review"}</Button>{clear && <Button disabled={!reviewed || checking || clearDisabled} onClick={() => finish(true)}>Clear draft and continue</Button>}</div>
    </>}
  </section>;
}
