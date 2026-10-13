import { useCallback, useEffect, useRef, useState } from "react";
import { Button, Card } from "./ui";
import { remoteExperimentEnabled } from "../services/experiments";
import { formatAttachments } from "../services/attachments";
import { claimShare, readShareInbox, recoverShare, removeShare, type ShareInboxEntry } from "../services/shareInboxStore.js";

export interface ShareInboxProps {
  targetId?: string;
  targetLabel?: string;
  canAppend?: (text: string) => boolean;
  onAppend?: (text: string) => boolean;
}

export function ShareInbox(props: ShareInboxProps) {
  if (!remoteExperimentEnabled("share-target")) return null;
  return <EnabledShareInbox {...props} />;
}

function EnabledShareInbox(props: ShareInboxProps) {
  const [entries, setEntries] = useState<ShareInboxEntry[]>([]);
  const [error, setError] = useState<string>();
  const mounted = useRef(true);
  const refresh = useCallback(async () => {
    try {const next = await readShareInbox(); if (mounted.current) {setEntries(next); setError(undefined);}}
    catch {if (mounted.current) setError("Shared items could not be read. Check this browser's site storage settings.");}
  }, []);
  useEffect(() => {
    mounted.current = true;
    const fragment = new URLSearchParams(location.hash.slice(1));
    if (fragment.has("share")) {fragment.delete("share"); history.replaceState(null, "", `${location.pathname}${location.search}${fragment.size ? `#${fragment}` : ""}`);}
    void refresh();
    const visible = () => {if (document.visibilityState === "visible") void refresh();};
    const hash = () => {void refresh();};
    window.addEventListener("hashchange", hash);
    document.addEventListener("visibilitychange", visible);
    return () => {mounted.current = false; window.removeEventListener("hashchange", hash); document.removeEventListener("visibilitychange", visible);};
  }, [refresh]);
  if (!entries.length && !error) return null;
  return <section aria-label="Shared items" className="border-b border-border p-4">
    <h2 className="font-semibold">Shared with Grok</h2>
    <p className="mt-1 text-body-sm text-muted-foreground">Review before adding to a conversation. Nothing is sent automatically. Unused items expire after one hour.</p>
    {!props.targetId && <p className="mt-2 text-body-sm">Choose a computer and conversation to add an item to its draft.</p>}
    {error && <p role="status" className="mt-2 text-warning">{error}</p>}
    <div className="mt-3 flex flex-col gap-3">{entries.map((entry) => <ShareInboxItem key={entry.id} entry={entry} {...props} onChanged={refresh} />)}</div>
  </section>;
}

function ShareInboxItem({entry, targetId, targetLabel, canAppend, onAppend, onChanged}: ShareInboxProps & {entry: ShareInboxEntry; onChanged: () => Promise<void>}) {
  const [text, setText] = useState(() => [entry.content.title, entry.content.text, entry.content.url].filter(Boolean).join("\n\n"));
  const [includeFiles, setIncludeFiles] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const live = useRef(true);
  const latest = useRef({targetId, canAppend, onAppend});
  const targetGeneration = useRef(0);
  if (latest.current.targetId !== targetId) targetGeneration.current++;
  latest.current = {targetId, canAppend, onAppend};
  useEffect(() => {live.current = true; targetGeneration.current++; return () => {live.current = false; targetGeneration.current++;};}, []);

  const append = async () => {
    if (!targetId || !onAppend || busy) return;
    const destination = targetId;
    const generation = targetGeneration.current;
    setBusy(true); setError(undefined);
    try {
      let formatted = text;
      if (includeFiles && entry.content.files.length) {
        const files = entry.content.files.map((file) => new File([file.data], file.name, {type: file.type}));
        const result = await formatAttachments(files);
        if (result.skipped) throw new Error("Some files could not fit. Uncheck the files or share smaller ones. The original item is still here.");
        formatted = [text, result.text].filter(Boolean).join("\n\n");
      }
      if (!live.current || targetGeneration.current !== generation || latest.current.targetId !== destination) return;
      if (!formatted.trim()) throw new Error("Add text or include a file before adding this item.");
      if (latest.current.canAppend && !latest.current.canAppend(formatted)) throw new Error("This item would exceed the command limit with the current draft. Shorten it or uncheck the files. Nothing was added.");
      const claimId = await claimShare(entry.id);
      if (!live.current) return;
      if (targetGeneration.current !== generation || latest.current.targetId !== destination) {await onChanged(); return;}
      if (latest.current.onAppend?.(formatted) !== true) throw new Error("The destination changed. Check its draft, then choose Review again to try explicitly.");
      await removeShare(entry.id, claimId);
      await onChanged();
    } catch (failure) {
      if (live.current) setError(failure instanceof Error && !failure.message.startsWith("share_") ? failure.message : "This item changed or was taken in another tab. Refresh the list and check the draft before trying again.");
      await onChanged();
    } finally {if (live.current) setBusy(false);}
  };
  const discard = async () => {
    setBusy(true);
    try {await removeShare(entry.id); await onChanged();}
    catch {if (live.current) setError("The shared item could not be deleted. Check this browser's site storage settings.");}
    finally {if (live.current) setBusy(false);}
  };
  const recover = async () => {
    if (!entry.claimId) return;
    setBusy(true);
    try {await recoverShare(entry.id, entry.claimId); await onChanged();}
    catch {if (live.current) setError("This item changed in another tab. Refresh before trying again.");}
    finally {if (live.current) setBusy(false);}
  };
  return <Card>
    <label className="flex flex-col gap-2 text-body-sm">Shared text<textarea value={text} onChange={(event) => setText(event.target.value)} disabled={busy} rows={3} className="min-h-20 w-full resize-y rounded-md border border-input bg-background p-2 text-foreground" /></label>
    {entry.content.files.length > 0 && <div className="mt-3 text-body-sm"><label className="flex min-h-11 items-center gap-2"><input type="checkbox" checked={includeFiles} disabled={busy} onChange={(event) => setIncludeFiles(event.target.checked)} />Include files</label><ul>{entry.content.files.map((file, index) => <li key={index}>{file.name} · {file.data.byteLength.toLocaleString()} bytes</li>)}</ul><p className="mt-1 text-muted-foreground">Files become text or encoded text. Images are not sent to vision input.</p></div>}
    {entry.state === "claimed" && <p role="status" className="mt-2 text-warning">A transfer started in this or another tab. Check the destination draft for duplicates before choosing Review again.</p>}
    {error && <p role="status" className="mt-2 text-warning">{error}</p>}
    <div className="mt-3 flex flex-wrap gap-2">{entry.state === "pending" ? <Button disabled={busy || !targetId || !onAppend} onClick={() => {void append();}}>Add to {targetLabel ?? "selected conversation"} draft</Button> : <Button disabled={busy} onClick={() => {void recover();}}>Review again</Button>}<Button disabled={busy} onClick={() => {void discard();}}>Discard shared item</Button><Button disabled={busy} onClick={() => {void onChanged();}}>Refresh items</Button></div>
  </Card>;
}
