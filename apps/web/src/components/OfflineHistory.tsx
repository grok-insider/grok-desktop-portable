import {useId, useState} from "react";
import {HardDrive} from "lucide-react";
import {Button} from "./ui";
import {ComposerDialog} from "./ComposerDialog";
import {MarkdownMessage} from "./MarkdownMessage";
import {useOfflineHistory} from "../services/useOfflineHistory";
import type {Projections} from "../services/sessionProjection";

export function OfflineHistory({scope, projections}: {scope: string; projections?: Projections}) {
  const history = useOfflineHistory(scope, projections);
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<string>();
  const id = useId();
  const conversation = history.conversations.find(row => row.sessionId === selected);
  const title = (value: typeof conversation) => value?.messages.find(row => row.role === "user")?.text.trim().slice(0, 80) || "Saved conversation";
  return <>
    <Button variant="ghost" size="sm" className="min-h-11" aria-haspopup="dialog" aria-expanded={open} aria-controls={id} onClick={() => setOpen(true)}><HardDrive size={16} aria-hidden="true" />Offline history{history.saving ? " · Saving…" : history.error ? " · Not saved" : ""}</Button>
    <ComposerDialog open={open} id={id} title="Offline history" description="Read saved conversations on this device. They expire seven days after their last saved change. Opening a copy does not extend its lifetime." onClose={() => setOpen(false)}>
      <p className="text-body-sm text-muted-foreground">{history.enabled ? "Saving is on for this computer. Messages and tool summaries share a 100 MiB browser limit with drafts; each conversation is limited to 1 MiB. Images, reasoning and pending actions are not saved here." : "Saving is off. Enabling it keeps messages and tool summaries from conversations opened on this device. Only enable it on a device you trust."}</p>
      <p className="mt-2 text-body-sm text-muted-foreground">Copies are read only and can be outdated. Remote revocation deletes them when this browser next connects; a disconnected device cannot receive revocation.</p>
      {history.loading && <p role="status" className="mt-3">Reading saved history…</p>}
      {history.error && <p role="alert" className="mt-3 text-warning">{history.error}</p>}
      {conversation ? <section className="mt-4 min-w-0">
        <div className="flex flex-wrap items-center gap-2"><Button onClick={() => setSelected(undefined)}>All saved conversations</Button><Button variant="danger" disabled={history.busy} onClick={() => {void history.action("remove", conversation.sessionId); setSelected(undefined);}}>Delete this saved conversation</Button></div>
        <h3 className="mt-4 break-words font-semibold">{title(conversation)}</h3>
        <p className="text-body-sm text-muted-foreground">Saved <time dateTime={new Date(conversation.savedAt).toISOString()}>{new Date(conversation.savedAt).toLocaleString()}</time></p>
        <div className="mt-4 space-y-5">{[...conversation.messages.map(row => ({kind: "message" as const, ...row})), ...conversation.tools.map(row => ({kind: "tool" as const, ...row}))].sort((a, b) => a.seq - b.seq).map(row => <article key={`${row.kind}:${row.id}`} className="min-w-0 break-words border-t border-border pt-3">{row.kind === "message" ? <><h4 className="mb-1 text-body-sm font-semibold">{row.role === "user" ? "You" : "Grok"}</h4>{row.role === "agent" ? <MarkdownMessage>{row.text}</MarkdownMessage> : <p className="whitespace-pre-wrap">{row.text}</p>}{row.unavailableImages > 0 && <p className="mt-2 text-body-sm text-muted-foreground">{row.unavailableImages} image{row.unavailableImages === 1 ? "" : "s"} unavailable in this offline copy.</p>}</> : <><h4 className="font-semibold">{row.name}</h4><p className="whitespace-pre-wrap">{row.detail}</p><p className="text-body-sm text-muted-foreground">{row.finished ? row.failed ? "Reported failed" : "Reported finished" : "Was running when saved"}</p></>}</article>)}</div>
      </section> : <ul className="mt-4 divide-y divide-border" aria-label="Saved conversations">{history.conversations.map(row => <li key={row.sessionId} className="flex min-w-0 flex-wrap items-center justify-between gap-2 py-2"><Button variant="ghost" className="h-auto min-h-11 min-w-0 break-words text-left" onClick={() => setSelected(row.sessionId)}>{title(row)}</Button><span className="text-body-sm text-muted-foreground">{new Date(row.savedAt).toLocaleDateString()}</span></li>)}</ul>}
      {!history.loading && history.enabled && history.conversations.length === 0 && <p className="mt-3 text-body-sm text-muted-foreground">No saved conversations yet. Open a conversation while connected to save it.</p>}
      {history.excluded.length > 0 && <p className="mt-3 text-body-sm text-muted-foreground">Deleted conversations stay excluded from saving. Turn history off and on to include them again.</p>}
      <div className="mt-5 flex flex-wrap justify-end gap-2"><Button onClick={() => setOpen(false)}>Close</Button><Button variant={history.enabled ? "danger" : "primary"} disabled={history.loading || history.busy} onClick={() => {void history.action(history.enabled ? "disable" : "enable");}}>{history.enabled ? "Turn off and delete history" : "Save history on this device"}</Button></div>
    </ComposerDialog>
  </>;
}
