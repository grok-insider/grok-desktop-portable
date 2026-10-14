import { useId, useState } from "react";
import { Check, HardDrive, LoaderCircle } from "lucide-react";
import { Button } from "./ui";
import { ComposerDialog } from "./ComposerDialog";
import type { DraftStatus } from "../services/useDrafts";

export function DraftRecovery({enabled, onChange, notice, status, busy}: {enabled: boolean; onChange: (enabled: boolean) => void; notice?: string; status: DraftStatus; busy: boolean}) {
  const [open, setOpen] = useState(false);
  const dialogId = useId();
  const label = status === "loading" ? "Loading drafts…" : status === "saving" ? "Saving…" : status === "failed" ? "Draft not saved" : enabled ? "Saved draft" : "Drafts off";
  const Icon = status === "loading" || status === "saving" ? LoaderCircle : enabled && status === "saved" ? Check : HardDrive;
  return <div className="flex min-w-0 flex-wrap items-center gap-x-2 text-body-sm">
    <Button variant="ghost" size="sm" className="min-h-11" aria-label={label} aria-haspopup="dialog" aria-expanded={open} aria-controls={dialogId} aria-busy={busy} onClick={() => setOpen(true)}>
      <Icon size={16} aria-hidden="true" />
      <span role="status" data-draft-status={status}>{label}</span>
    </Button>
    {status === "failed" && <p className="w-full text-warning" role="alert">Not saved. Keep a copy before closing.</p>}
    {notice && <p className="w-full text-warning" role="status">{notice}</p>}
    <ComposerDialog open={open} id={dialogId} title="Draft storage" description="Save unsent text and prepared images on this device. Each edit is kept for seven days. Nothing is sent automatically." onClose={() => setOpen(false)}>
      <p className="text-body-sm text-muted-foreground">{enabled ? "Draft saving is on for this computer and account. Turning it off deletes their saved drafts on this device." : "Draft saving is off. Turn it on only if you want this device to retain your unsent messages."}</p>
      {status === "saving" && <p role="status" className="mt-3 text-body-sm">Saving… Keep this page open.</p>}
      <div className="mt-5 flex flex-wrap justify-end gap-2">
        <Button className="min-h-11" onClick={() => setOpen(false)}>Close</Button>
        <Button className="min-h-11" variant={enabled ? "danger" : "primary"} aria-pressed={enabled} disabled={busy} onClick={() => {onChange(!enabled);setOpen(false);}}>{enabled ? "Delete saved drafts" : "Remember drafts on this device"}</Button>
      </div>
    </ComposerDialog>
  </div>;
}
