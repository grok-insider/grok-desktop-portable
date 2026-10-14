import { useEffect, useRef, useState } from "react";
import { Button } from "./ui";
import { registerShellWorker, shellWorkerMessage } from "../services/pwa";

interface InstallEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{outcome: string}>;
}

export function PwaActions() {
  const [install, setInstall] = useState<InstallEvent | null>(null);
  const [update, setUpdate] = useState<ServiceWorkerRegistration | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const [canRollback, setCanRollback] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const removeReloadListener = useRef<(() => void) | undefined>(undefined);
  useEffect(() => {
    let mounted = true;
    void shellWorkerMessage({kind: "shellStatus"}).then(result => {if (mounted) setCanRollback(result.canRollback === true);});
    void registerShellWorker((registration) => {if (mounted) {setUpdate(registration); setDismissed(false);}});
    const offered = (event: Event) => {event.preventDefault(); setInstall(event as InstallEvent); setDismissed(false); setError(undefined);};
    const installed = () => setInstall(null);
    window.addEventListener("beforeinstallprompt", offered);
    window.addEventListener("appinstalled", installed);
    return () => {
      mounted = false;
      removeReloadListener.current?.();
      window.removeEventListener("beforeinstallprompt", offered);
      window.removeEventListener("appinstalled", installed);
    };
  }, []);
  if (dismissed || (!install && !update && !canRollback)) return null;
  return <aside className="pwa-actions" aria-label="App installation and updates">
    {error && <p role="status">{error}</p>}
    {install && <Button disabled={busy} onClick={() => {
      setBusy(true); setError(undefined);
      void install.prompt().then(() => install.userChoice).then(() => setInstall(null)).catch(() => setError("Installation could not start. Try again or install from your browser menu.")).finally(() => setBusy(false));
    }}>Install app</Button>}
    {update && <Button disabled={busy} onClick={() => {
      if (!update.waiting) {setUpdate(null); return;}
      setBusy(true);
      const reload = () => location.reload();
      navigator.serviceWorker.addEventListener("controllerchange", reload, {once: true});
      removeReloadListener.current = () => navigator.serviceWorker.removeEventListener("controllerchange", reload);
      update.waiting.postMessage({kind: "activateUpdate"});
    }}>Update and reload</Button>}
    {canRollback && <Button disabled={busy} onClick={() => {
      setBusy(true);
      void shellWorkerMessage({kind: "rollbackShell"}).then(result => {
        if (result.ok) location.reload();
        else {setError("The previous app version is unavailable. Keep this version and try a new update."); setBusy(false);}
      });
    }}>Restore previous app and reload</Button>}
    <Button variant="ghost" disabled={busy} onClick={() => setDismissed(true)}>Later</Button>
  </aside>;
}
