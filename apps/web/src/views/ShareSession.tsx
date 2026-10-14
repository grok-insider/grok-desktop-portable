import { useContext, useEffect, useLayoutEffect, useRef, useState } from "react";
import { AlertCircle, Share2 } from "lucide-react";
import { Button } from "../components/ui";
import type { LightClient } from "../services/client";
import type { ImageDescriptor, Operation } from "../services/protocol";
import { OptionalDialogsBlockedContext } from "../components/ComposerDialog";
import { ImageReaderContext, TranscriptImages } from "../components/TranscriptImages";
import { PUBLICATION_ACCOUNT, publicationCommand, publicationCommandStatus, publicationStatus, PublicationUncertain, rememberPublicationAuthorization, type Publication, type PublicationResult } from "../services/publications";

type Preview = { outcome: "publicationPreview"; document: { title: string; entries: Array<{kind: string; role?: string; name?: string; path?: string; text: string}> }; availableImages: ImageDescriptor[]; selectedImageHashes: string[]; previewDigest: string; totalBytes: number; totalEntries: number };

export function ShareSession({client, hostId, sessionId, canPublish = true, compact = false}: {client: LightClient; hostId: string; sessionId: string; canPublish?: boolean; compact?: boolean}) {
  const [share, setShare] = useState<Publication | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [authorized, setAuthorized] = useState(false);
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [authorizationUrl, setAuthorizationUrl] = useState<string>();
  const [optionsOpen, setOptionsOpen] = useState(false);
  const [pending, setPending] = useState<string>();
  const dialog = useRef<HTMLDialogElement>(null);
  const optionsDialog = useRef<HTMLDialogElement>(null);
  const dialogsBlocked = useContext(OptionalDialogsBlockedContext);
  const generation = useRef(0);
  const allowed = useRef(canPublish);
  useLayoutEffect(() => {
    allowed.current = canPublish && !dialogsBlocked;
    if (!allowed.current) {generation.current++; dialog.current?.close(); setPreview(null); setConsent(false);}
    if (dialogsBlocked) {optionsDialog.current?.close(); setOptionsOpen(false);}
  }, [canPublish, dialogsBlocked]);
  const refresh = async () => {
    const status = await publicationStatus(client);
    setAuthorized(status.authorized);
    setShare(status.publications.find(value => value.sessionId === sessionId && !["revoked", "expired"].includes(value.phase)) ?? null);
  };
  useEffect(() => {
    let active = true;
    const read = () => { void publicationStatus(client).then(status => {
      if (active) {setAuthorized(status.authorized); setShare(status.publications.find(value => value.sessionId === sessionId && !["revoked", "expired"].includes(value.phase)) ?? null);}
    }).catch(() => {if (active) setError("Could not check public links on this computer.");}); };
    read();
    window.addEventListener("grok-publications-changed", read);
    return () => {active = false; window.removeEventListener("grok-publications-changed", read);};
  }, [client, hostId, sessionId]);
  useEffect(() => {if (preview && !dialogsBlocked && !dialog.current?.open) dialog.current?.showModal();}, [preview, dialogsBlocked]);
  useEffect(() => {
    const element = optionsDialog.current;
    if (optionsOpen && !dialogsBlocked && element && !element.open) element.showModal();
    return () => element?.close();
  }, [optionsOpen, dialogsBlocked]);
  const report = (failure: unknown) => {
    if (failure instanceof PublicationUncertain) setPending(failure.idempotencyKey);
    setError(failure instanceof Error ? failure.message : "The publication action could not be confirmed.");
  };
  const applyResult = async (result: PublicationResult) => {
    setPending(undefined);
    if (result.outcome === "publicationAuthorization") {setAuthorizationUrl(rememberPublicationAuthorization(result, hostId)); return;}
    if (result.outcome === "publicationStopped") {
      if (result.accessRevoked !== true || result.keysDestroyed !== true) throw new Error("Permanent deletion has not been confirmed. Check publication status.");
      setNotice(`Access is revoked and encryption keys are destroyed. ${result.metadataCleanup === "complete" ? "Identifying metadata is deleted." : "Identifying metadata cleanup is pending."} ${result.storageCleanup === "complete" ? "Encrypted file cleanup is verified complete." : "Encrypted file cleanup is pending."}`);
      setPreview(null);
    } else if (result.outcome === "publicationCreated") setPreview(null);
    await refresh();
  };
  const mutate = async (operation: Operation) => {
    if (!allowed.current || busy || pending) return;
    setBusy(true); setError(undefined);
    try {await applyResult(await publicationCommand(client, operation));} catch (failure) {report(failure); if (compact && !preview) setOptionsOpen(true);}
    finally {setBusy(false);}
  };
  const check = async () => {
    if (!pending || busy) return;
    setBusy(true); setError(undefined);
    try {await applyResult(await publicationCommandStatus(client, pending));} catch (failure) {report(failure);}
    finally {setBusy(false);}
  };
  const prepare = async (imageHashes: string[] = []) => {
    if (!allowed.current || pending) return;
    const current = ++generation.current;
    setBusy(true); setError(undefined); setConsent(false);
    try {
      const reply = await client.send({kind: "previewPublication", sessionId, imageHashes});
      const value = reply.ok ? reply.value as Preview : null;
      if (value?.outcome !== "publicationPreview" || !value.document || !Array.isArray(value.availableImages) || !Array.isArray(value.selectedImageHashes) || !/^[a-f0-9]{64}$/.test(value.previewDigest)) throw new Error("The computer could not prepare the public preview.");
      if (current === generation.current && allowed.current) setPreview(value);
    } catch (failure) {if (current === generation.current && allowed.current) {report(failure); if (compact && !preview) setOptionsOpen(true);}}
    finally {setBusy(false);}
  };
  const controls = <>
    {share && <div className="space-y-2 text-body-sm">
      <a className="break-words text-warning underline" href={`https://publications.fabrials.com/#${encodeURIComponent(share.id)}`} target="_blank" rel="noopener noreferrer">Public conversation</a>
      <p>Status: {share.phase}. Expires {new Date(share.expiresAt).toLocaleString()}.</p>
      {share.error && <p className="text-warning">Updates need attention: {share.error}</p>}
      {canPublish && <div className="flex flex-wrap gap-2"><Button disabled={busy || Boolean(pending)} onClick={() => {void mutate({kind: "stopPublication", publicationId: share.id});}}>Stop sharing</Button>{["paused", "needsReview"].includes(share.phase) && share.error !== "publication_source_changed" && <Button disabled={busy || Boolean(pending)} onClick={() => {void mutate({kind: "resumePublication", publicationId: share.id});}}>Resume updates</Button>}</div>}
    </div>}
    {error && <p role="alert" className="text-body-sm text-warning">{error}</p>}
    {notice && <p role="status" className="text-body-sm">{notice}</p>}
    {pending && <Button disabled={busy} onClick={() => {void check();}}>Check action status</Button>}
    <a className="text-body-sm underline" href={PUBLICATION_ACCOUNT} target="_blank" rel="noopener noreferrer">Manage all links on Fabrials, including when this computer is offline</a>
  </>;
  return <>
    {compact ? <Button variant="ghost" size="sm" className="min-h-11 min-w-11 shrink-0" aria-label={share ? "Public conversation" : error ? "Sharing needs attention" : !canPublish ? "Conversation sharing" : "Share conversation"} disabled={busy} onClick={() => {if (share || error || pending || !canPublish) setOptionsOpen(true); else void prepare();}}>{error ? <AlertCircle size={18} aria-hidden="true" /> : <Share2 size={18} aria-hidden="true" />}{share && <span>Public</span>}</Button> : <>{controls}{!share && canPublish && <Button disabled={busy || Boolean(pending)} onClick={() => {void prepare();}}>Share conversation</Button>}</>}
    {optionsOpen && <dialog ref={optionsDialog} className="interaction-dialog" aria-labelledby="share-options-title" onCancel={event => {event.preventDefault(); setOptionsOpen(false);}}>
      <h2 id="share-options-title" className="text-title-sm font-semibold">Conversation sharing</h2>
      <div className="my-4 space-y-3">{controls}</div>
      <div className="flex flex-wrap justify-end gap-2">{!share && canPublish && <Button disabled={busy || Boolean(pending)} onClick={() => {setOptionsOpen(false); void prepare();}}>Review public preview</Button>}<Button onClick={() => setOptionsOpen(false)}>Close sharing options</Button></div>
    </dialog>}
    {preview && canPublish && <dialog ref={dialog} className="interaction-dialog" aria-labelledby="share-title" onCancel={event => {event.preventDefault(); if (!busy) setPreview(null);}}>
      <h2 id="share-title" className="text-title-sm font-semibold">Publish this conversation</h2>
      <p className="my-3 text-muted-foreground">Anyone with the link can read the messages, tool calls, text results and diffs shown below. Future text is included. Only images selected here are included; future images remain private.</p>
      <p className="mb-3 text-body-sm">Expires seven days after new text is published. Views and edits do not extend it. Stopping sharing destroys the publication encryption keys and deletes its identifying metadata. Encrypted file cleanup is tracked separately; your originals stay on your computer. Copies downloaded by others cannot be recalled.</p>
      <div className="max-h-[35dvh] overflow-y-auto rounded-md border border-border p-3" aria-label="Public preview">{preview.document.entries.map((entry, index) => <article className="mb-4" key={index}><h3 className="font-semibold">{entry.role ?? entry.name ?? entry.path ?? entry.kind}</h3><pre className="whitespace-pre-wrap break-words text-body-sm">{entry.text}</pre></article>)}</div>
      {preview.availableImages.length > 0 && <fieldset className="my-3"><legend>Choose up to eight images to publish</legend><ImageReaderContext.Provider value={{client, sessionId}}><div className="grid grid-cols-2 gap-3">{preview.availableImages.map((image, index) => <div key={image.sha256}><TranscriptImages images={[image]} /><label className="flex min-h-11 items-center gap-2"><input type="checkbox" checked={preview.selectedImageHashes.includes(image.sha256)} disabled={busy || (!preview.selectedImageHashes.includes(image.sha256) && preview.selectedImageHashes.length >= 8)} onChange={event => {void prepare(event.target.checked ? [...preview.selectedImageHashes, image.sha256] : preview.selectedImageHashes.filter(hash => hash !== image.sha256));}} />Publish image {index + 1}</label></div>)}</div></ImageReaderContext.Provider></fieldset>}
      <p className="my-3 text-body-sm text-muted-foreground">{preview.totalEntries} entries · {(preview.totalBytes / 1024).toFixed(1)} KiB. Resource limits pause publishing or delivery; they never increase spending automatically.</p>
      {!authorized ? <div className="my-3 space-y-2"><p>Authorize this computer through your Fabrials account before publishing.</p>{authorizationUrl ? <a className="underline" href={authorizationUrl}>Continue to Fabrials authorization</a> : <Button disabled={busy || Boolean(pending)} onClick={() => {void mutate({kind: "beginPublicationAuthorization"});}}>Authorize computer</Button>}</div> : <label className="interaction-option my-3"><input type="checkbox" checked={consent} onChange={event => setConsent(event.target.checked)} /><span>I reviewed this content and selected images, and want to publish future text and tool results too.</span></label>}
      {error && <p role="alert" className="text-warning">{error}</p>}
      {pending && <Button disabled={busy} onClick={() => {void check();}}>Check action status</Button>}
      <div className="mt-4 flex justify-end gap-3"><Button disabled={busy} onClick={() => setPreview(null)}>Cancel</Button><Button variant="primary" disabled={busy || !consent || !authorized || Boolean(pending)} onClick={() => {void mutate({kind: "createPublication", sessionId, imageHashes: preview.selectedImageHashes, previewDigest: preview.previewDigest, publishFutureText: true});}}>Publish and sync</Button></div>
    </dialog>}
  </>;
}
