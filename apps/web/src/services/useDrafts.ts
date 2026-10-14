import { useCallback, useLayoutEffect, useMemo, useState, type SetStateAction } from "react";
import { DRAFT_CHANGED, DRAFT_DATABASE, DraftStore, type DraftChange } from "./drafts";
import { remoteExperimentEnabled } from "./experiments";

export type DraftStatus = "loading" | "off" | "saving" | "saved" | "failed";
interface DraftRuntime {
  store: DraftStore | null;
  drafts: Record<string, string>;
  enabled: boolean;
  status: DraftStatus;
  busy: boolean;
  notice?: string;
  epoch?: string;
  mounted: boolean;
  generation: number;
  consent: number;
  writes: Map<string, string>;
  writing: boolean;
  failed: Set<string>;
  clearing: boolean;
  barriers: Set<string>;
  edited: Set<string>;
}

export function useDrafts(scope: string | undefined) {
  const runtime = useMemo<DraftRuntime>(() => {
    const store = (remoteExperimentEnabled("drafts") || scope?.startsWith('["direct",')) && scope ? new DraftStore(scope) : null;
    return {store, drafts: {}, enabled: false, status: store ? "loading" : "off", busy: !!store, mounted: false, generation: 0, consent: 0, writes: new Map(), writing: false, failed: new Set(), clearing: false, barriers: new Set(), edited: new Set()};
  }, [scope]);
  const [, redraw] = useState(0);
  const publish = useCallback(() => {if (runtime.mounted) redraw(value => value + 1);}, [runtime]);
  const save = useCallback((sessionId: string, text: string) => {
    if (!runtime.store || !runtime.enabled || !runtime.epoch) return;
    const bytes = new TextEncoder().encode(text).length + [...runtime.writes.entries()].reduce((sum, [id, value]) => sum + (id === sessionId ? 0 : new TextEncoder().encode(value).length), 0);
    if (runtime.writes.size >= 64 && !runtime.writes.has(sessionId) || bytes > 4 * 1024 * 1024) {
      runtime.failed.add(sessionId);
      runtime.status = "failed";
      runtime.notice = "This draft could not be saved. Too many changes are pending; keep a copy before closing.";
      publish();
      return;
    }
    runtime.writes.set(sessionId, text);
    runtime.status = "saving";
    publish();
    if (runtime.writing) return;
    runtime.writing = true;
    const generation = runtime.generation;
    const active = () => runtime.mounted && generation === runtime.generation;
    void (async () => {
      while (active() && runtime.writes.size) {
        const [id, value] = runtime.writes.entries().next().value!;
        runtime.writes.delete(id);
        try {
          await runtime.store!.write(id, value, runtime.epoch);
          if (!active()) return;
          if (runtime.drafts[id] === value) runtime.failed.delete(id);
        }
        catch (error) {
          if (!active()) return;
          runtime.failed.add(id);
          runtime.notice = error instanceof Error && error.message.startsWith("This draft") ? error.message : "This draft could not be saved. Keep a copy before closing this page.";
        }
      }
      if (!active()) return;
      runtime.writing = false;
      runtime.status = runtime.failed.size ? "failed" : "saved";
      if (!runtime.failed.size) runtime.notice = undefined;
      publish();
    })();
  }, [runtime, publish]);

  useLayoutEffect(() => {
    runtime.mounted = true;
    const generation = ++runtime.generation;
    const change = (detail: DraftChange) => {
      if (detail?.scope !== runtime.store?.scope || detail.enabled !== false) return;
      if ("epoch" in detail && runtime.epoch && detail.epoch !== runtime.epoch) return;
      if (runtime.barriers.has(detail.operationId)) {if (detail.revoked) {runtime.drafts = {};publish();}return;}
      runtime.barriers.add(detail.operationId);
      if (runtime.barriers.size > 64) runtime.barriers.delete(runtime.barriers.values().next().value!);
      runtime.generation++;
      if (!runtime.clearing) runtime.consent++;
      runtime.enabled = false;
      runtime.epoch = undefined;
      runtime.writes.clear();
      runtime.writing = false;
      runtime.failed.clear();
      runtime.status = runtime.clearing ? "saving" : "off";
      runtime.busy = runtime.clearing;
      runtime.notice = undefined;
      if (detail.revoked) runtime.drafts = {};
      publish();
    };
    const changed = (event: Event) => {if (event instanceof CustomEvent) change(event.detail);};
    window.addEventListener(DRAFT_CHANGED, changed);
    let channel: BroadcastChannel | undefined;
    try {
      if (runtime.store && typeof BroadcastChannel !== "undefined") {
        channel = new BroadcastChannel(DRAFT_DATABASE);
        channel.onmessage = event => change(event.data);
      }
    } catch {}
    if (runtime.store) void runtime.store.load().then(snapshot => {
      if (!runtime.mounted || generation !== runtime.generation) return;
      runtime.epoch = snapshot.epoch;
      runtime.enabled = snapshot.enabled;
      runtime.drafts = {...snapshot.drafts, ...runtime.drafts};
      runtime.status = snapshot.enabled ? "saved" : "off";
      runtime.busy = false;
      if (snapshot.enabled) for (const sessionId of runtime.edited) save(sessionId, runtime.drafts[sessionId] ?? "");
      publish();
    }).catch(() => {
      if (!runtime.mounted || generation !== runtime.generation) return;
      runtime.status = "failed";
      runtime.busy = false;
      runtime.notice = "Saved drafts could not be read. Check this browser's site storage settings.";
      publish();
    });
    return () => {runtime.mounted = false;runtime.generation++;channel?.close();window.removeEventListener(DRAFT_CHANGED, changed);};
  }, [runtime, publish, save]);

  const setDrafts = useCallback((update: SetStateAction<Record<string, string>>) => {
    runtime.drafts = typeof update === "function" ? update(runtime.drafts) : update;
    publish();
  }, [runtime, publish]);

  const updateDraft = useCallback((sessionId: string, text: string) => {
    runtime.edited.add(sessionId);
    runtime.drafts = {...runtime.drafts, [sessionId]: text};
    save(sessionId, text);
    publish();
  }, [runtime, save, publish]);

  const remember = useCallback(async (enabled: boolean) => {
    if (!runtime.store || runtime.busy) return;
    const consent = ++runtime.consent;
    runtime.busy = true;
    runtime.failed.clear();
    runtime.notice = undefined;
    runtime.status = "saving";
    publish();
    try {
      if (enabled) {
        const generation = ++runtime.generation;
        const initial = {...runtime.drafts};
        const snapshot = await runtime.store.enable(initial);
        if (!runtime.mounted || generation !== runtime.generation) return;
        runtime.epoch = snapshot.epoch;
        runtime.enabled = true;
        runtime.status = "saved";
        for (const [sessionId, text] of Object.entries(runtime.drafts)) if (text !== initial[sessionId]) save(sessionId, text);
      } else {
        runtime.enabled = false;
        runtime.epoch = undefined;
        runtime.generation++;
        runtime.clearing = true;
        await runtime.store.clear();
        if (!runtime.mounted) return;
        runtime.status = "off";
      }
    } catch {
      if (!runtime.mounted || consent !== runtime.consent) return;
      runtime.status = "failed";
      runtime.enabled = false;
      runtime.notice = "Draft storage could not be updated. Check this browser's site storage settings; saved copies may remain until site data is cleared.";
    } finally {
      if (runtime.mounted && consent === runtime.consent) {runtime.clearing = false;runtime.busy = false;publish();}
    }
  }, [runtime, save, publish]);

  return {drafts: runtime.drafts, setDrafts, updateDraft, remember, enabled: runtime.enabled, available: runtime.store !== null, notice: runtime.notice, status: runtime.status, busy: runtime.busy};
}
