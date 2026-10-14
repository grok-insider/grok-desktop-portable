import { useRef, useState } from "react";
import { Button } from "../components/ui";
import type { LightClient } from "../services/client";
import { publicationCommand, publicationCommandStatus, PublicationUncertain, type PublicationCallback } from "../services/publications";

export function PublicationAuthorization({ client, profileId, callback, onComplete }: { client: LightClient; profileId: string; callback: PublicationCallback; onComplete?: () => void }) {
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string>();
  const pending = useRef<string | undefined>(undefined);
  if (!callback || done) return null;
  if ("error" in callback) return <p role="status">{callback.error}</p>;
  const matches = profileId === callback.profileId;
  const complete = async () => {
    if (!matches || busy) return;
    if (!pending.current && callback.expiresAt <= Date.now()) { setError("This authorization expired. Start again from this computer."); return; }
    setBusy(true); setError(undefined);
    try {
      const reply = pending.current ? await publicationCommandStatus(client, pending.current) : await publicationCommand(client, { kind: "completePublicationAuthorization", code: callback.code, nonce: callback.nonce });
      if (reply.outcome !== "publicationAuthorized") throw new Error("Authorization was not confirmed.");
      callback.code = "";
      setDone(true);
      onComplete?.();
      window.dispatchEvent(new Event("grok-publications-changed"));
    } catch (error) { if (error instanceof PublicationUncertain) pending.current = error.idempotencyKey; setError(error instanceof Error ? error.message : "Authorization was not confirmed."); }
    finally { setBusy(false); }
  };
  return <section aria-label="Complete publication authorization" className="border-b border-border p-3 text-body-sm">
    <p>{matches ? "Fabrials authorized public sharing. Confirm on this connected computer to finish. No conversation is published by this step." : "Connect the computer used to authorize publications to finish."}</p>
    {error && <p role="alert" className="text-warning">{error}</p>}
    {matches && <Button disabled={busy} onClick={() => { void complete(); }}>{pending.current ? "Check authorization status" : "Finish publication authorization"}</Button>}
  </section>;
}
