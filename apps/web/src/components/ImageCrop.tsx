import {useEffect, useId, useRef, useState, type KeyboardEvent, type PointerEvent} from "react";
import {Move, MoveDiagonal2} from "lucide-react";
import type {ImageComposer} from "../services/useImageComposer";
import type {ImageCropRect, PreparedImage} from "../services/imageUploads";
import {Button} from "./ui";

const clamp = (value: number, minimum: number, maximum: number) => Math.min(maximum, Math.max(minimum, Math.round(value)));

export function ImageCrop({image, composer, onDone}: {image: PreparedImage; composer: ImageComposer; onDone(): void}) {
  const [crop, setCrop] = useState<ImageCropRect>({x: 0, y: 0, width: image.width, height: image.height});
  const [applying, setApplying] = useState(false);
  const canvas = useRef<HTMLDivElement>(null);
  const pending = useRef<AbortController | undefined>(undefined);
  const drag = useRef<{pointer: number; mode: "move" | "resize"; x: number; y: number; bounds: DOMRect; crop: ImageCropRect} | undefined>(undefined);
  const controlsId = useId();
  useEffect(() => () => pending.current?.abort(), []);
  const change = (field: keyof ImageCropRect, value: number) => setCrop(current => {
    if (field === "x") return {...current, x: clamp(value, 0, image.width - current.width)};
    if (field === "y") return {...current, y: clamp(value, 0, image.height - current.height)};
    if (field === "width") return {...current, width: clamp(value, Math.max(8, Math.ceil(512 / current.height)), image.width - current.x)};
    return {...current, height: clamp(value, Math.max(8, Math.ceil(512 / current.width)), image.height - current.y)};
  });
  const start = (event: PointerEvent<HTMLButtonElement>, mode: "move" | "resize") => {
    if (applying || !event.isPrimary || event.button !== 0 || !canvas.current) return;
    const bounds = canvas.current.getBoundingClientRect();
    if (!bounds.width || !bounds.height) return;
    event.preventDefault();
    event.currentTarget.focus({preventScroll: true});
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = {pointer: event.pointerId, mode, x: event.clientX, y: event.clientY, bounds, crop};
  };
  const move = (event: PointerEvent<HTMLButtonElement>) => {
    const value = drag.current;
    if (!value || value.pointer !== event.pointerId || applying) return;
    const dx = Math.round((event.clientX - value.x) * image.width / value.bounds.width);
    const dy = Math.round((event.clientY - value.y) * image.height / value.bounds.height);
    if (value.mode === "move") setCrop({...value.crop, x: clamp(value.crop.x + dx, 0, image.width - value.crop.width), y: clamp(value.crop.y + dy, 0, image.height - value.crop.height)});
    else {
      let width = clamp(value.crop.width + dx, 8, image.width - value.crop.x);
      let height = clamp(value.crop.height + dy, 8, image.height - value.crop.y);
      width = Math.min(image.width - value.crop.x, Math.max(width, Math.ceil(512 / height)));
      height = Math.max(height, Math.ceil(512 / width));
      setCrop({...value.crop, width, height});
    }
  };
  const stop = (event: PointerEvent<HTMLButtonElement>) => {if (drag.current?.pointer === event.pointerId) drag.current = undefined;};
  const key = (event: KeyboardEvent<HTMLButtonElement>, resize: boolean) => {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
    event.preventDefault();
    const delta = (event.shiftKey ? 10 : 1) * (event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 1);
    const field = event.key === "ArrowLeft" || event.key === "ArrowRight" ? resize ? "width" : "x" : resize ? "height" : "y";
    change(field, crop[field] + delta);
  };
  const cancel = () => {pending.current?.abort(); onDone();};
  const apply = async () => {
    if (applying || composer.busy) return;
    const controller = new AbortController();
    pending.current = controller;
    setApplying(true);
    const applied = await composer.crop(image.id, crop, controller.signal);
    if (controller.signal.aborted) return;
    setApplying(false);
    if (applied) onDone();
  };
  const bounds: Array<{field: keyof ImageCropRect; label: string; min: number; max: number}> = [
    {field: "x", label: "Left", min: 0, max: image.width - crop.width},
    {field: "y", label: "Top", min: 0, max: image.height - crop.height},
    {field: "width", label: "Width", min: Math.max(8, Math.ceil(512 / crop.height)), max: image.width - crop.x},
    {field: "height", label: "Height", min: Math.max(8, Math.ceil(512 / crop.width)), max: image.height - crop.y},
  ];
  return <div className="space-y-4">
    <p id={`${controlsId}-help`} className="text-body-sm text-muted-foreground">Drag the selection to move it and its lower corner to resize. Use arrow keys for one pixel, or Shift and an arrow for ten. The sliders also work with touch and keyboard.</p>
    <div ref={canvas} className="relative mx-auto max-w-full" style={{width: `min(100%, ${40 * image.width / image.height}dvh)`, aspectRatio: `${image.width} / ${image.height}`}}>
      <img src={image.preview} alt={`Crop preview of ${image.name}`} draggable={false} className="block size-full select-none" />
      <div aria-hidden="true" className="pointer-events-none absolute inset-x-0 top-0 bg-background/70" style={{height: `${100 * crop.y / image.height}%`}} />
      <div aria-hidden="true" className="pointer-events-none absolute inset-x-0 bottom-0 bg-background/70" style={{height: `${100 * (image.height - crop.y - crop.height) / image.height}%`}} />
      <div aria-hidden="true" className="pointer-events-none absolute left-0 bg-background/70" style={{top: `${100 * crop.y / image.height}%`, height: `${100 * crop.height / image.height}%`, width: `${100 * crop.x / image.width}%`}} />
      <div aria-hidden="true" className="pointer-events-none absolute right-0 bg-background/70" style={{top: `${100 * crop.y / image.height}%`, height: `${100 * crop.height / image.height}%`, width: `${100 * (image.width - crop.x - crop.width) / image.width}%`}} />
      <div className="absolute border-2 border-primary" style={{left: `${100 * crop.x / image.width}%`, top: `${100 * crop.y / image.height}%`, width: `${100 * crop.width / image.width}%`, height: `${100 * crop.height / image.height}%`}}>
        <button type="button" aria-label="Move crop" aria-describedby={`${controlsId}-help`} disabled={applying} onPointerDown={event => start(event, "move")} onPointerMove={move} onPointerUp={stop} onPointerCancel={stop} onLostPointerCapture={stop} onKeyDown={event => key(event, false)} className="absolute left-1/2 top-1/2 flex min-h-11 min-w-11 -translate-x-1/2 -translate-y-1/2 touch-none items-center justify-center rounded-md border border-border bg-background text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"><Move size={18} aria-hidden="true" /></button>
        <button type="button" aria-label="Resize crop" aria-describedby={`${controlsId}-help`} disabled={applying} onPointerDown={event => start(event, "resize")} onPointerMove={move} onPointerUp={stop} onPointerCancel={stop} onLostPointerCapture={stop} onKeyDown={event => key(event, true)} className="absolute bottom-0 right-0 flex min-h-11 min-w-11 touch-none items-center justify-center rounded-md border border-border bg-background text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"><MoveDiagonal2 size={18} aria-hidden="true" /></button>
      </div>
    </div>
    <fieldset disabled={applying} className="grid gap-x-4 gap-y-2 sm:grid-cols-2">
      <legend className="sr-only">Crop bounds in pixels</legend>
      {bounds.map(({field, label, min, max}) => <label key={field} className="block text-body-sm" htmlFor={`${controlsId}-${field}`}><span className="flex justify-between gap-2"><span>{label}</span><output aria-hidden="true">{crop[field]} px</output></span><input id={`${controlsId}-${field}`} type="range" min={min} max={max} step={1} value={crop[field]} aria-valuetext={`${crop[field]} pixels`} onChange={event => change(field, Number(event.target.value))} className="block h-11 w-full accent-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary" /></label>)}
    </fieldset>
    <p className="text-body-sm">Selected: {crop.width} × {crop.height} pixels. Applying replaces only this attachment; nothing is sent.</p>
    {applying && <p role="status" className="text-body-sm">Preparing crop…</p>}
    {composer.error && <p role="alert" className="text-body-sm text-warning">{composer.error}</p>}
    <div className="flex flex-wrap gap-2"><Button variant="primary" className="min-h-11" disabled={applying || composer.busy} onClick={() => {void apply();}}>Apply crop</Button><Button className="min-h-11" disabled={applying} onClick={() => setCrop({x: 0, y: 0, width: image.width, height: image.height})}>Reset crop</Button><Button variant="ghost" className="min-h-11" onClick={cancel}>Cancel crop</Button></div>
  </div>;
}
