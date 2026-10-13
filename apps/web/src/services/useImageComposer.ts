import {useCallback, useLayoutEffect, useMemo, useRef, useState} from "react";
import {DRAFT_CHANGED, DRAFT_DATABASE, DraftStore, type DraftChange} from "./drafts";
import type {LightClient} from "./client";
import {MAX_IMAGES, MAX_IMAGE_NORMALIZED, MAX_IMAGE_SELECTION, cropImage, prepareImage, uploadImage, type ImageCropRect, type PreparedImage} from "./imageUploads";

export interface ImageComposer {
  images: PreparedImage[];
  capable: boolean;
  busy: boolean;
  storage: "off" | "saving" | "saved" | "failed";
  progress?: string;
  error?: string;
  add(files: File[]): Promise<void>;
  crop(id: string, rectangle: ImageCropRect, signal?: AbortSignal): Promise<boolean>;
  remove(id: string): void;
  submit(text: string, sendNow: boolean): Promise<void>;
}

interface ImageRuntime {
  store: DraftStore | null;
  drafts: Record<string, PreparedImage[]>;
  consent: boolean;
  epoch?: string;
  generation: number;
  storageGeneration: number;
  mounted: boolean;
  working: boolean;
  storage: ImageComposer["storage"];
  activity?: {sessionId: string; progress?: string; error?: string};
  lifetime: AbortController;
  transferring?: AbortController;
  editing?: AbortController;
  pending: Map<string, PreparedImage[]>;
  writing: boolean;
  failed: Set<string>;
  changes: Set<string>;
}

type Inputs = {client: LightClient; sessionId: string | null; scope?: string; capable: boolean; canSend: boolean; onSent(sessionId: string, text: string): void};
const release = (images: PreparedImage[]) => {for (const image of images) URL.revokeObjectURL(image.preview);};

export function useImageComposer(inputs: Inputs): ImageComposer {
  const runtime = useMemo<ImageRuntime>(() => ({store: inputs.scope ? new DraftStore(inputs.scope) : null, drafts: {}, consent: false, generation: 0, storageGeneration: 0, mounted: false, working: false, storage: "off", lifetime: new AbortController(), pending: new Map(), writing: false, failed: new Set(), changes: new Set()}), [inputs.scope, inputs.client]);
  const latest = useRef(inputs);
  latest.current = inputs;
  const [, redraw] = useState(0);
  const publish = useCallback(() => {if (runtime.mounted) redraw(value => value + 1);}, [runtime]);
  const persist = useCallback((sessionId: string, images: PreparedImage[]) => {
    if (!runtime.store || !runtime.consent || !runtime.epoch) return;
    runtime.pending.set(sessionId, images);
    runtime.storage = "saving";
    publish();
    if (runtime.writing) return;
    runtime.writing = true;
    const generation = runtime.storageGeneration;
    const active = () => runtime.mounted && generation === runtime.storageGeneration;
    void (async () => {
      while (active() && runtime.pending.size) {
        const [id, values] = runtime.pending.entries().next().value!;
        runtime.pending.delete(id);
        try {
          await runtime.store!.writeImages(id, values.map(({preview: _preview, ...image}) => image), runtime.epoch);
          if (!active()) return;
          if (runtime.drafts[id] === values) runtime.failed.delete(id);
        } catch {
          if (!active()) return;
          runtime.failed.add(id);
        }
      }
      if (!active()) return;
      runtime.writing = false;
      runtime.storage = runtime.failed.size ? "failed" : "saved";
      publish();
    })();
  }, [runtime, publish]);
  const update = (sessionId: string, images: PreparedImage[]) => {runtime.drafts[sessionId] = images; persist(sessionId, images); publish();};

  useLayoutEffect(() => {
    runtime.mounted = true;
    runtime.lifetime = new AbortController();
    const restore = async () => {
      if (!runtime.store) return;
      const generation = runtime.storageGeneration;
      try {
        const result = await runtime.store.readImages();
        if (!runtime.mounted || generation !== runtime.storageGeneration) return;
        runtime.consent = result.enabled;
        runtime.epoch = result.epoch;
        runtime.storage = result.enabled ? "saved" : "off";
        const unsaved = Object.keys(runtime.drafts);
        for (const [sessionId, images] of Object.entries(result.images)) if (runtime.drafts[sessionId] === undefined) runtime.drafts[sessionId] = images.map(image => ({...image, preview: URL.createObjectURL(image.blob)}));
        if (result.enabled) for (const sessionId of unsaved) persist(sessionId, runtime.drafts[sessionId]);
        publish();
      } catch {if (runtime.mounted && generation === runtime.storageGeneration) {runtime.storage = "failed"; publish();}}
    };
    void restore();
    const change = (detail: DraftChange) => {
      if (detail?.scope !== runtime.store?.scope) return;
      if ("epoch" in detail && runtime.epoch && detail.epoch !== runtime.epoch) return;
      if (runtime.changes.has(detail.operationId)) return;
      runtime.changes.add(detail.operationId);
      if (runtime.changes.size > 64) runtime.changes.delete(runtime.changes.values().next().value!);
      runtime.storageGeneration++;
      runtime.pending.clear();
      runtime.writing = false;
      runtime.failed.clear();
      if (detail.enabled) {void restore(); return;}
      runtime.consent = false;
      runtime.epoch = undefined;
      runtime.storage = "off";
      if (detail.revoked) {
        runtime.generation++;
        runtime.transferring?.abort();
        runtime.editing?.abort();
        release(Object.values(runtime.drafts).flat());
        runtime.drafts = {};
        runtime.activity = undefined;
      }
      publish();
    };
    const listener = (event: Event) => change((event as CustomEvent<DraftChange>).detail);
    window.addEventListener(DRAFT_CHANGED, listener);
    let channel: BroadcastChannel | undefined;
    try {if (runtime.store && typeof BroadcastChannel !== "undefined") {channel = new BroadcastChannel(DRAFT_DATABASE); channel.onmessage = event => change(event.data as DraftChange);}} catch {}
    return () => {
      runtime.mounted = false;
      runtime.generation++;
      runtime.storageGeneration++;
      runtime.lifetime.abort();
      runtime.transferring?.abort();
      runtime.editing?.abort();
      release(Object.values(runtime.drafts).flat());
      runtime.drafts = {};
      window.removeEventListener(DRAFT_CHANGED, listener);
      channel?.close();
    };
  }, [runtime, persist, publish]);
  useLayoutEffect(() => {if (!inputs.canSend || !inputs.capable) runtime.transferring?.abort();}, [runtime, inputs.canSend, inputs.capable]);
  useLayoutEffect(() => {runtime.editing?.abort();}, [runtime, inputs.sessionId, inputs.capable]);

  return {
    images: inputs.sessionId ? runtime.drafts[inputs.sessionId] ?? [] : [],
    capable: inputs.capable,
    storage: runtime.storage,
    busy: runtime.working,
    progress: runtime.activity?.sessionId === inputs.sessionId ? runtime.activity.progress : undefined,
    error: runtime.activity?.sessionId === inputs.sessionId ? runtime.activity.error : undefined,
    async add(files) {
      const target = latest.current.sessionId;
      if (!target || !latest.current.capable || runtime.working || !runtime.mounted) return;
      const existing = runtime.drafts[target] ?? [];
      if (existing.length + files.length > MAX_IMAGES || files.reduce((sum, file) => sum + file.size, 0) > MAX_IMAGE_SELECTION) {runtime.activity = {sessionId: target, error: "Choose up to eight images and no more than 100 MiB per selection."}; publish(); return;}
      const prepared: PreparedImage[] = [];
      const generation = runtime.generation;
      const active = () => runtime.mounted && runtime.generation === generation;
      runtime.working = true;
      runtime.activity = {sessionId: target, progress: "Preparing images…"};
      publish();
      try {
        for (const file of files) {
          if (!active()) throw new Error("Image selection was cancelled.");
          prepared.push(await prepareImage(file));
        }
        if (!active()) throw new Error("Image selection was cancelled.");
        if ([...existing, ...prepared].reduce((sum, image) => sum + image.blob.size, 0) > MAX_IMAGE_NORMALIZED) throw new Error("These images exceed 5 MiB after preparation. Remove an image or select a smaller crop.");
        if (Object.values(runtime.drafts).flat().reduce((sum, image) => sum + image.blob.size, 0) + prepared.reduce((sum, image) => sum + image.blob.size, 0) > MAX_IMAGE_SELECTION) throw new Error("Image drafts are using 100 MiB. Remove images from another conversation before adding more.");
        update(target, [...existing, ...prepared]);
        runtime.activity = {sessionId: target};
      } catch (error) {
        release(prepared);
        if (active()) runtime.activity = {sessionId: target, error: error instanceof Error ? error.message : "The image could not be prepared."};
      } finally {runtime.working = false; publish();}
    },
    remove(id) {
      const target = latest.current.sessionId;
      if (!target || runtime.working || !runtime.mounted) return;
      const images = runtime.drafts[target] ?? [];
      release(images.filter(image => image.id === id));
      update(target, images.filter(image => image.id !== id));
      runtime.activity = {sessionId: target};
      publish();
    },
    async crop(id, rectangle, cancellation) {
      const target = latest.current.sessionId;
      if (!target || !latest.current.capable || runtime.working || !runtime.mounted || cancellation?.aborted) return false;
      const original = runtime.drafts[target]?.find(image => image.id === id);
      if (!original) return false;
      const controller = new AbortController();
      runtime.editing = controller;
      const signal = AbortSignal.any([controller.signal, runtime.lifetime.signal, ...(cancellation ? [cancellation] : [])]);
      const generation = runtime.generation;
      const active = () => runtime.mounted && runtime.generation === generation && latest.current.sessionId === target && !signal.aborted;
      runtime.working = true;
      runtime.activity = {sessionId: target, progress: "Preparing crop…"};
      publish();
      let prepared: PreparedImage | undefined;
      try {
        prepared = await cropImage(original, rectangle, signal);
        if (!active()) return false;
        const images = runtime.drafts[target] ?? [];
        if (!images.includes(original)) return false;
        if (images.reduce((sum, image) => sum + image.blob.size, 0) - original.blob.size + prepared.blob.size > MAX_IMAGE_NORMALIZED) throw new Error("These images exceed 5 MiB after cropping. Choose a smaller crop or remove an image.");
        if (Object.values(runtime.drafts).flat().reduce((sum, image) => sum + image.blob.size, 0) - original.blob.size + prepared.blob.size > MAX_IMAGE_SELECTION) throw new Error("Image drafts are using 100 MiB. Choose a smaller crop or remove another image.");
        const replacement = {...prepared, id: original.id};
        update(target, images.map(image => image === original ? replacement : image));
        prepared = undefined;
        release([original]);
        runtime.activity = {sessionId: target};
        return true;
      } catch (error) {
        if (active()) runtime.activity = {sessionId: target, error: error instanceof Error ? error.message : "The crop could not be prepared. Your original selection is kept."};
        return false;
      } finally {
        if (prepared) release([prepared]);
        if (runtime.activity?.sessionId === target && runtime.activity.progress === "Preparing crop…") runtime.activity = {sessionId: target};
        runtime.working = false;
        if (runtime.editing === controller) runtime.editing = undefined;
        publish();
      }
    },
    async submit(text, sendNow) {
      const target = latest.current.sessionId;
      if (!target || !latest.current.capable || !latest.current.canSend || runtime.working || !runtime.mounted) return;
      const images = runtime.drafts[target] ?? [];
      if (!images.length) return;
      if (text.trimStart().startsWith("!")) {runtime.activity = {sessionId: target, error: "Images cannot be attached to shell commands."}; publish(); return;}
      const client = latest.current.client;
      const controller = new AbortController();
      runtime.transferring = controller;
      const signal = AbortSignal.any([controller.signal, runtime.lifetime.signal]);
      const generation = runtime.generation;
      const active = () => runtime.mounted && runtime.generation === generation;
      runtime.working = true;
      const uploaded: string[] = [];
      let dispatched = false;
      runtime.activity = {sessionId: target, progress: "Uploading images…"};
      publish();
      try {
        for (const [index, image] of images.entries()) {
          const ready = await uploadImage(client, target, image, signal, sent => {if (active()) {runtime.activity = {sessionId: target, progress: `Uploading image ${index + 1} of ${images.length}: ${Math.round(sent * 100 / image.blob.size)}%`}; publish();}});
          uploaded.push(ready.imageId);
        }
        signal.throwIfAborted();
        if (!active() || !latest.current.canSend || !latest.current.capable) throw new Error("Control or image support changed. Reconnect before sending these images.");
        runtime.activity = {sessionId: target, progress: "Sending message…"};
        publish();
        dispatched = true;
        const reply = await client.send({kind: "promptContent", sessionId: target, text: text.trim(), imageIds: uploaded, sendNow}, {idempotencyKey: crypto.randomUUID()});
        if (!reply.ok) {
          if (reply.failure.kind !== "unreachable") dispatched = false;
          throw new Error(reply.failure.kind === "refused" ? reply.failure.code : "The message outcome is uncertain. Check the conversation and terminal before sending again. It was not retried.");
        }
        if (!active()) return;
        release(images);
        update(target, []);
        latest.current.onSent(target, text);
        runtime.activity = {sessionId: target};
      } catch (error) {
        if (!dispatched) for (const imageId of uploaded) void client.send({kind: "discardImage", imageId}).catch(() => {});
        if (active()) runtime.activity = {sessionId: target, error: signal.aborted ? "Image transfer stopped when the connection, control or image support changed. Your images are kept here; no message was resent." : error instanceof Error ? error.message : "The image message could not be sent."};
      } finally {runtime.working = false; if (runtime.transferring === controller) runtime.transferring = undefined; publish();}
    },
  };
}
