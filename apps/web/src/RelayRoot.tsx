import { useCallback, useEffect, useRef, useState } from "react";
import { Monitor, ArrowLeft, RefreshCw, Unplug } from "lucide-react";
import { App } from "./App";
import { Button, Card } from "./components/ui";
import { LightClient } from "./services/client";
import { createRemoteTransport } from "./services/remoteConnector";
import { ACCOUNT_ORIGIN, RemoteAccountError, remoteAccount, takeRemotePairing, type RemoteHost } from "./services/remoteAccount";
import { ThemeToggle } from "./theme/ThemeToggle";
import { PublicLinks } from "./views/PublicLinks";
import { TerminalSessionHelp } from "./components/TerminalSessionHelp";
import { ShareInbox } from "./components/ShareInbox";
import { forgetDraftScope, managedDraftScope } from "./services/drafts";

export function RelayRoot() {
  const [hosts, setHosts] = useState<RemoteHost[]>([]);
  const [accountId, setAccountId] = useState<string>();
  const [pairing, setPairing] = useState(takeRemotePairing);
  const [selected, setSelected] = useState<{host: RemoteHost; client: LightClient; draftScope?: string} | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<string>();
  const [signedOut, setSignedOut] = useState(false);
  const lifecycle = useRef(0);
  const selectedClient = useRef<LightClient | null>(null);
  const connectionAbort = useRef<AbortController | null>(null);
  const refresh = useCallback(async () => {
    const generation = lifecycle.current;
    setBusy(true);
    setError(undefined);
    try {
      const result = await remoteAccount<{accountId?: string; hosts: RemoteHost[]}>("/hosts");
      if (generation !== lifecycle.current) return;
      setHosts(result.hosts.filter((host) => !host.revoked));
      setAccountId(result.accountId);
      setSignedOut(false);
    } catch (failure) {
      if (generation !== lifecycle.current) return;
      setSignedOut(failure instanceof RemoteAccountError && failure.status === 401);
      setError(failure instanceof Error ? failure.message : "The account service is unavailable.");
    } finally {if (generation === lifecycle.current) setBusy(false);}
  }, []);
  useEffect(() => {
    lifecycle.current += 1;
    void refresh();
    const onHashChange = () => {
      const incoming = takeRemotePairing();
      if (!incoming) return;
      lifecycle.current += 1;
      connectionAbort.current?.abort();
      selectedClient.current?.dispose();
      selectedClient.current = null;
      setSelected(null);
      setPairing(incoming);
      void refresh();
    };
    window.addEventListener("hashchange", onHashChange);
    return () => {
      lifecycle.current += 1;
      connectionAbort.current?.abort();
      selectedClient.current?.dispose();
      window.removeEventListener("hashchange", onHashChange);
    };
  }, [refresh]);
  const connect = async (host: RemoteHost) => {
    const generation = ++lifecycle.current;
    connectionAbort.current?.abort();
    const abort = new AbortController();
    connectionAbort.current = abort;
    setBusy(true);
    setError(undefined);
    try {
      if (pairing?.hostId === host.id && pairing.hostPublicKey !== host.publicKey) throw new Error("host_key_changed");
      const transport = await createRemoteTransport({hostId: host.id, signal: abort.signal, ...(pairing?.hostId === host.id ? {pairing: {secret: pairing.secret, hostPublicKey: pairing.hostPublicKey}} : {})});
      if (generation !== lifecycle.current) {transport.dispose?.(); return;}
      setPairing((current) => current?.hostId === host.id ? null : current);
      if (pairing?.hostId === host.id) {
        try {await forgetDraftScope(managedDraftScope(accountId, host));} catch {transport.dispose?.(); throw new Error("draft_storage_unavailable");}
      }
      if (generation !== lifecycle.current) {transport.dispose?.(); return;}
      const client = new LightClient({transport, storageKey: `grok-remote-session.v1:${host.id}`});
      selectedClient.current = client;
      setSelected({host, client, draftScope: managedDraftScope(accountId, host)});
    } catch (failure) {
      if (generation !== lifecycle.current) return;
      const code = failure instanceof Error ? failure.message : "unreachable";
      if (code === "revoked") {try {await forgetDraftScope(managedDraftScope(accountId, host));} catch {setError("Access was revoked, but saved drafts could not be deleted. Clear this browser’s site data."); return;}}
      const messages: Record<string, string> = {
        pairing_required: "Pair this browser from your computer with spanreed remote pair. Open its QR link here.",
        account_required: "Sign in to Fabrials, then reconnect to your computer.",
        host_offline: "Your computer is offline. Start Spanreed there, then reconnect.",
        crypto_unavailable: "The secure connection could not start. Reload after updating the app.",
        draft_storage_unavailable: "The browser paired, but old drafts could not be deleted. Clear this browser’s site data before reconnecting.",
        device_storage_unavailable: "This browser cannot store your device pairing. Allow site storage in your browser settings, or use a browser profile with storage enabled, then reconnect.",
        protocol_mismatch: "This computer uses a different protocol version. Update Spanreed and this app. Your pairing and drafts are preserved.",
        protocol_error: "The computer returned an invalid response. Reconnect after checking Spanreed. Your pairing and drafts are preserved.",
        revoked: "This browser's access was revoked. Pair it again from your computer.",
        host_key_changed: "This computer's key has changed. Create a new pairing code on the computer.",
      };
      setError(messages[code] ?? "The secure connection failed. Check that Spanreed is running, then reconnect.");
    } finally {if (generation === lifecycle.current) setBusy(false);}
  };
  const forgetSelectedBrowser = async () => {
    if (!selected || selectedClient.current !== selected.client) return;
    const generation = lifecycle.current;
    let revocationConfirmed = false;
    setBusy(true);
    setError(undefined);
    try {
      const result = await selected.client.revokePairing();
      if (generation !== lifecycle.current) return;
      if (!result.ok && result.failure.kind !== "not_paired") throw new Error("revocation_unconfirmed");
      revocationConfirmed = true;
      await forgetDraftScope(selected.draftScope);
      await selected.client.forgetPairing();
      if (generation !== lifecycle.current) return;
      selectedClient.current = null;
      setSelected(null);
    } catch (failure) {
      if (generation === lifecycle.current) setError(revocationConfirmed
        ? "Access was revoked, but browser storage could not be cleared. Close this tab."
        : "The computer did not confirm revocation. Reconnect and try again, or revoke this browser on the computer.");
      throw failure;
    } finally {if (generation === lifecycle.current) setBusy(false);}
  };
  if (selected) return <div className="remote-connected">
    <div className="remote-host-bar"><Button variant="ghost" size="sm" aria-label="Computers" title="Computers" disabled={busy} onClick={() => {lifecycle.current++; selected.client.dispose(); selectedClient.current = null; setSelected(null);}}><ArrowLeft size={18} aria-hidden="true" /><span className="max-[680px]:sr-only">Computers</span></Button><span className="min-w-0 flex-1 truncate text-body font-semibold" title={selected.host.label}>{selected.host.label}</span><Button variant="ghost" size="sm" aria-label="Forget this browser" title="Forget this browser" disabled={busy} onClick={() => {void forgetSelectedBrowser().catch(() => {});}}><Unplug size={18} aria-hidden="true" /><span className="max-[680px]:sr-only">Forget this browser</span></Button></div>
    {error && <p role="status" className="bg-warning-soft px-4 py-2 text-warning">{error}</p>}
    <App key={selected.draftScope ?? selected.host.id} client={selected.client} remoteHostId={selected.host.id} draftScope={selected.draftScope} onRevokeOwn={forgetSelectedBrowser} />
  </div>;
  return <main className="remote-home">
    <header className="flex items-center justify-between gap-4"><div><h1 className="text-title font-semibold">Grok Remote</h1><p className="mt-2 text-muted-foreground">Continue your terminal sessions from this device.</p></div><ThemeToggle /></header>
    {error && <p role="status" className="rounded-md bg-warning-soft p-3 text-warning">{error}</p>}
    <ShareInbox />
    {signedOut ? <a className="remote-signin" href={`${ACCOUNT_ORIGIN}/login?next=${encodeURIComponent("https://remote.fabrials.com")}`}>Sign in to Fabrials</a> : <>
      <div className="flex items-center justify-between"><h2 className="font-semibold">Your computers</h2><Button disabled={busy} onClick={() => {void refresh();}}><RefreshCw size={16} aria-hidden="true" />Refresh</Button></div>
      {busy && hosts.length === 0 && <p role="status">Loading your computers…</p>}
      {hosts.map((host) => <Card key={host.id}><div className="flex flex-wrap items-center gap-4"><Monitor aria-hidden="true" /><span className="min-w-0 flex-1 break-words font-semibold">{host.label}</span><Button variant="primary" disabled={busy} onClick={() => {void connect(host);}}>{pairing?.hostId === host.id ? "Pair and connect" : "Connect"}</Button></div></Card>)}
      {hosts.length === 0 && !busy && !error && <Card><h2 className="font-semibold">Add your first computer</h2><p className="mt-2 text-muted-foreground">On your computer, run <code>spanreed share login</code>, <code>spanreed remote enable "My computer"</code>, then <code>spanreed remote serve</code>. Keep it running.</p><p className="mt-2 text-muted-foreground">In a second terminal, run <code>spanreed remote pair</code>. Open its QR link on this device.</p></Card>}
      <TerminalSessionHelp className="text-body-sm text-muted-foreground" />
      <p className="text-body-sm text-muted-foreground">Your computer must remain on. On iPhone, use Share → Add to Home Screen, then pair from the installed app.</p>
      <PublicLinks />
    </>}
  </main>;
}
