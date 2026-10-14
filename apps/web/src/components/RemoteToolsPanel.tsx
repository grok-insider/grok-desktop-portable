import { useEffect, useId, useState, type ReactNode } from "react";
import { Settings2 } from "lucide-react";
import { ComposerDialog } from "./ComposerDialog";
import { Button, IconButton } from "./ui";
import type { RemoteControlsProps } from "./RemoteControls";
import { ThemeToggle } from "../theme/ThemeToggle";
import { useTheme } from "../theme/ThemeProvider";
import { preferenceLabel } from "../theme/theme";
import "./remote-tools-panel.css";

export interface RemoteControlAttention {
  incoming: number;
  outgoing: boolean;
}

export function useRemoteControlAttention(controls: RemoteControlsProps): RemoteControlAttention {
  const [tick, setTick] = useState(0);
  const requests = controls.browserDevices?.controlTransferRequests;
  const own = controls.ownControlRequest;
  const enabled = controls.connected && controls.capabilities?.controlTransfer;
  useEffect(() => {
    if (!enabled) return;
    const now = Date.now();
    const expirations = [...(requests ?? []).map(request => request.expiresAt), ...(own ? [own.expiresAt] : [])].filter(expiration => expiration > now);
    if (!expirations.length) return;
    const timer = setTimeout(() => setTick(value => value + 1), Math.min(2_147_483_647, Math.min(...expirations) - now + 1));
    return () => clearTimeout(timer);
  }, [enabled, requests, own, tick]);
  const now = Date.now();
  return {
    incoming: enabled && controls.canControl ? (requests ?? []).filter(request => request.expiresAt > now).length : 0,
    outgoing: Boolean(enabled && !controls.canControl && own && own.expiresAt > now),
  };
}

function attentionLabel(attention: RemoteControlAttention): string | undefined {
  if (attention.incoming) return attention.incoming === 1 ? "A browser is requesting control." : `${attention.incoming} browsers are requesting control.`;
  if (attention.outgoing) return "Your control request is waiting for approval.";
  return undefined;
}

export function RemoteToolsNotice({attention, error, onOpen}: {attention: RemoteControlAttention; error?: string; onOpen: () => void}) {
  const message = error ?? attentionLabel(attention);
  if (!message) return null;
  return <div className="remote-tools-notice" role="status">
    <span>{message}</span>
    <Button variant="ghost" size="sm" onClick={onOpen}>Review computer settings</Button>
  </div>;
}

export function RemoteToolsPanel({open, onOpenChange, attention, error, connected, available, children}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  attention: RemoteControlAttention;
  error?: string;
  connected: boolean;
  available: boolean;
  children: ReactNode;
}) {
  const id = useId();
  const {preference} = useTheme();
  const notice = error ?? attentionLabel(attention);
  return <>
    <IconButton className="remote-tools-trigger" aria-label="Computer settings" title={notice ? `Computer settings · ${notice}` : "Computer settings"} aria-haspopup="dialog" aria-controls={id} aria-expanded={open} onClick={() => onOpenChange(true)}>
      <Settings2 size={18} aria-hidden="true" />
      {notice && <span className="remote-tools-attention" aria-hidden="true">{attention.incoming || "!"}</span>}
    </IconButton>
    <ComposerDialog id={id} open={open} title="Computer settings" description="Projects, browser access and notifications for this computer." onClose={() => onOpenChange(false)}>
      <div className="remote-tools-content">
        {notice && <p role="status" className="remote-tools-panel-notice">{notice}</p>}
        {!available && <p role="status">{connected ? "Checking which settings this computer supports…" : "Reconnect to load computer settings."}</p>}
        {children}
        <section aria-label="Appearance" className="remote-tools-appearance">
          <div><h3 className="font-semibold">Appearance</h3><p className="text-body-sm text-muted-foreground">{preferenceLabel(preference)}</p></div>
          <ThemeToggle />
        </section>
      </div>
    </ComposerDialog>
  </>;
}
