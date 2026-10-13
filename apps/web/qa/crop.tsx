import {useMemo, useState} from "react";
import {createRoot} from "react-dom/client";
import {ImageAttachments} from "../src/components/ImageAttachments";
import {Button} from "../src/components/ui";
import {useImageComposer} from "../src/services/useImageComposer";
import type {LightClient} from "../src/services/client";
import "./crop.css";

if (!["localhost", "127.0.0.1", "[::1]"].includes(location.hostname)) throw new Error("Synthetic qualification must remain on loopback.");

function Fixture() {
  const [sends, setSends] = useState(0);
  const [draft, setDraft] = useState("Synthetic draft stays unchanged");
  const [sessionId, setSessionId] = useState("synthetic-crop-A");
  const client = useMemo(() => ({send: async () => {setSends(value => value + 1); throw new Error("Synthetic fixture forbids every host operation.");}} as unknown as LightClient), []);
  const composer = useImageComposer({client, sessionId, capable: true, canSend: false, onSent: () => {throw new Error("Synthetic fixture must never send.");}});
  const synthetic = async () => {
    const canvas = document.createElement("canvas");
    canvas.width = 128; canvas.height = 64;
    const context = canvas.getContext("2d")!;
    context.fillStyle = "red"; context.fillRect(0, 0, 64, 64);
    context.fillStyle = "blue"; context.fillRect(64, 0, 64, 64);
    const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, "image/png"));
    if (blob) await composer.add([new File([blob], "synthetic-pixels.png", {type: "image/png"})]);
  };
  return <main className="mx-auto max-w-3xl space-y-4 p-4">
    <h1 className="text-title font-semibold">Synthetic image crop qualification</h1>
    <p>No host is connected. Image support is synthetic; decoding, canvas, crop controls and draft handling use the product code.</p>
    <label className="block">Draft<textarea className="block min-h-24 w-full rounded-md border border-border bg-background p-3" value={draft} onChange={event => setDraft(event.target.value)} /></label>
    <div className="flex flex-wrap gap-2"><Button disabled={composer.busy} onClick={() => {void synthetic();}}>Add synthetic image</Button><Button onClick={() => setSessionId(value => value.endsWith("A") ? "synthetic-crop-B" : "synthetic-crop-A")}>Switch conversation</Button></div>
    <label className="block">Choose synthetic image<input type="file" accept="image/png,image/jpeg,image/webp" disabled={composer.busy} onChange={event => {void composer.add(Array.from(event.target.files ?? [])); event.target.value = "";}} /></label>
    <ImageAttachments composer={composer} />
    <output data-testid="crop-state" data-sends={sends} data-image-count={composer.images.length} data-width={composer.images[0]?.width ?? 0} data-height={composer.images[0]?.height ?? 0}>Host operations: {sends}; conversation: {sessionId}; images: {composer.images.length}</output>
  </main>;
}

createRoot(document.getElementById("root")!).render(<Fixture />);
