import {createContext, useContext, useEffect, useMemo, useRef, useState} from "react";
import type {LightClient} from "../services/client";
import type {ImageDescriptor} from "../services/protocol";
import {readImage, withImageReadSlot} from "../services/readImage";
import {Button} from "./ui";
import {ComposerDialog} from "./ComposerDialog";

export const ImageReaderContext = createContext<{client: LightClient; sessionId: string} | null>(null);

export function TranscriptImages({images = [], unavailable = 0, live = []}: {images?: ImageDescriptor[]; unavailable?: number; live?: Array<{id: string; phase: "pending" | "ready" | "unavailable"; image?: ImageDescriptor}>}) {
  return <div className="mt-2 flex flex-wrap gap-2" aria-label="Conversation images">{images.map((image, index) => <TranscriptImage key={`${image.sha256}-${index}`} image={image} number={index + 1} />)}{live.map((slot, index) => slot.phase === "ready" && slot.image ? <TranscriptImage key={slot.id} image={slot.image} number={images.length + index + 1} /> : <p key={slot.id} className="text-body-sm text-muted-foreground">{slot.phase === "pending" ? "Preparing conversation image…" : "Image unavailable in this history."}</p>)}{unavailable > 0 && <p className="text-body-sm text-muted-foreground">{unavailable} image{unavailable > 1 ? "s" : ""} unavailable in this history.</p>}</div>;
}

function TranscriptImage({image, number}: {image: ImageDescriptor; number: number}) {
  const reader = useContext(ImageReaderContext);
  const client = reader?.client;
  const sessionId = reader?.sessionId;
  const element = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const identity = useMemo(() => ({}), [client, sessionId, image.sha256, image.byteLength]);
  const [loaded, setLoaded] = useState<{identity: object; url: string}>();
  const url = loaded?.identity === identity ? loaded.url : undefined;
  const [failed, setFailed] = useState(false);
  const [retry, setRetry] = useState(0);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (typeof IntersectionObserver === "undefined") {setVisible(true); return;}
    const observer = new IntersectionObserver(entries => {if (entries.some(entry => entry.isIntersecting)) {setVisible(true); observer.disconnect();}}, {rootMargin: "100px"});
    if (element.current) observer.observe(element.current);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    setLoaded(undefined);
    setOpen(false);
    setFailed(false);
    if (!visible || !client || !sessionId) return;
    const controller = new AbortController();
    let preview: string | undefined;
    void withImageReadSlot(controller.signal, () => readImage(client, sessionId, image, controller.signal)).then(blob => {
      if (controller.signal.aborted) return;
      preview = URL.createObjectURL(blob);
      setLoaded({identity, url: preview});
    }).catch(() => {if (!controller.signal.aborted) setFailed(true);});
    return () => {controller.abort(); if (preview) URL.revokeObjectURL(preview);};
  }, [client, sessionId, identity, visible, retry]);
  return <div ref={element} className="min-w-24 max-w-56">
    {url ? <Button variant="ghost" className="h-auto p-0" aria-label={`View image ${number}`} onClick={() => setOpen(true)}><img src={url} alt={`Image ${number}`} className="max-h-40 max-w-48 object-contain" /></Button> : <p className="text-body-sm text-muted-foreground">Image {number} · {image.width} × {image.height}{failed ? " · unavailable" : client ? " · loading" : ""}</p>}
    {failed && <Button size="sm" onClick={() => setRetry(value => value + 1)}>Retry image</Button>}
    <ComposerDialog open={open && Boolean(url)} title="Conversation image" onClose={() => setOpen(false)}>{url && <img src={url} alt={`Image ${number}`} className="max-h-[65dvh] max-w-full object-contain" />}</ComposerDialog>
  </div>;
}
