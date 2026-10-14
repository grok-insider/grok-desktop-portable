import {useCallback, useEffect, useLayoutEffect, useMemo, useState} from "react";
import {OfflineHistoryStore, observeOfflineHistory, offlineContent, offlineSignature, type HistorySnapshot} from "./offlineHistory";
import type {Projections} from "./sessionProjection";

const EMPTY: HistorySnapshot = {enabled: false, epoch: "", conversations: [], excluded: []};

export function useOfflineHistory(scope: string | undefined, projections?: Projections) {
  const runtime = useMemo(() => ({store: scope ? new OfflineHistoryStore(scope) : null, snapshot: EMPTY, alive: false, generation: 0, loading: Boolean(scope), busy: false, error: "", saving: false, saved: new Map<string, string>(), failed: new Map<string, string>(), loadingTicket: 0, latest: undefined as Projections | undefined, pending: false, timer: undefined as number | undefined}), [scope]);
  const [, redraw] = useState(0);
  const publish = useCallback(() => {if (runtime.alive) redraw(value => value + 1);}, [runtime]);
  const refresh = useCallback(async () => {
    if (!runtime.store) return;
    const ticket = ++runtime.loadingTicket;
    const generation = runtime.generation;
    try {
      const snapshot = await runtime.store.load();
      if (!runtime.alive || generation !== runtime.generation || ticket !== runtime.loadingTicket) return;
      runtime.snapshot = snapshot;
      if (!runtime.saving) for (const {savedAt: _, ...content} of snapshot.conversations) runtime.saved.set(content.sessionId, `${content.observationEpoch ?? 0}:${content.observedThrough ?? "legacy"}:${offlineSignature(content)}`);
      runtime.loading = false;
      publish();
    } catch {
      if (!runtime.alive || generation !== runtime.generation || ticket !== runtime.loadingTicket) return;
      runtime.loading = false;
      runtime.error = "Offline history could not be read. Check this browser’s storage settings.";
      publish();
    }
  }, [runtime, publish]);
  useLayoutEffect(() => {
    runtime.alive = true;
    runtime.generation++;
    void refresh();
    const stop = runtime.store ? observeOfflineHistory(runtime.store.scope, revoked => {
      if (revoked) {runtime.generation++; runtime.snapshot = EMPTY; runtime.saved.clear(); runtime.failed.clear(); runtime.saving = false; runtime.pending = false; window.clearTimeout(runtime.timer); runtime.timer = undefined; publish();}
      void refresh();
    }) : () => {};
    const timer = window.setInterval(() => {void refresh();}, 60000);
    return () => {runtime.alive = false; runtime.generation++; window.clearInterval(timer); window.clearTimeout(runtime.timer); runtime.timer = undefined; stop();};
  }, [runtime, refresh, publish]);
  const enabled = runtime.snapshot.enabled;
  const busy = runtime.busy;
  useEffect(() => {
    runtime.latest = projections;
    if (!runtime.store || !enabled || !projections || runtime.busy) return;
    runtime.pending = true;
    if (runtime.saving || runtime.timer !== undefined) return;
    const generation = runtime.generation;
    runtime.timer = window.setTimeout(() => {
      runtime.timer = undefined;
      if (!runtime.alive || generation !== runtime.generation) return;
      runtime.saving = true;
      publish();
      void (async () => {
        while (runtime.pending && runtime.alive && generation === runtime.generation && runtime.snapshot.enabled) {
          runtime.pending = false;
          const ids = Object.keys(runtime.latest ?? {});
          for (const id of ids) {
            if (!runtime.alive || generation !== runtime.generation || !runtime.snapshot.enabled) return;
            const projection = runtime.latest?.[id];
            if (!projection || projection.observedThrough === -1 || runtime.snapshot.excluded.includes(id) || !projection.transcript.length && !projection.tools.length) continue;
            const content = `${projection.observationEpoch ?? 0}:${projection.observedThrough ?? "legacy"}:${offlineSignature(offlineContent(id, projection))}`;
            if (runtime.saved.get(id) === content || runtime.failed.get(id) === content) continue;
            try {
              await runtime.store!.save(id, projection, runtime.snapshot.epoch);
              if (runtime.alive && generation === runtime.generation) {runtime.saved.set(id, content); runtime.failed.delete(id);}
            } catch (error) {
              if (runtime.alive && generation === runtime.generation) {
                runtime.failed.set(id, content);
                runtime.error = error instanceof Error ? error.message : "Offline history could not be saved. Its previous copy is preserved.";
              }
            }
          }
          if (runtime.pending && runtime.alive && generation === runtime.generation) await new Promise(resolve => window.setTimeout(resolve, 1000));
        }
        if (!runtime.alive || generation !== runtime.generation) return;
        runtime.saving = false;
        if (!runtime.failed.size) runtime.error = "";
        await refresh();
        publish();
      })();
    }, 1000);
  }, [runtime, enabled, busy, projections, publish, refresh]);
  const action = useCallback(async (kind: "enable" | "disable" | "remove", sessionId?: string) => {
    if (!runtime.store || runtime.busy) return;
    runtime.busy = true;
    runtime.error = "";
    runtime.failed.clear();
    runtime.generation++;
    runtime.saving = false;
    runtime.pending = false;
    window.clearTimeout(runtime.timer);
    runtime.timer = undefined;
    publish();
    try {
      if (kind === "enable") await runtime.store.enable();
      else if (kind === "disable") {runtime.snapshot = EMPTY; publish(); await runtime.store.disable();}
      else if (sessionId) {runtime.snapshot = {...runtime.snapshot, conversations: runtime.snapshot.conversations.filter(row => row.sessionId !== sessionId), excluded: [...runtime.snapshot.excluded, sessionId]}; publish(); await runtime.store.remove(sessionId);}
      await refresh();
    } catch (error) {if (runtime.alive) runtime.error = `${error instanceof Error ? error.message : "Offline storage could not be changed."} Saved copies may remain until site data is cleared.`;}
    finally {if (runtime.alive) {runtime.busy = false; publish();}}
  }, [runtime, refresh, publish]);
  return {available: Boolean(runtime.store), ...runtime.snapshot, loading: runtime.loading, busy: runtime.busy, saving: runtime.saving, error: runtime.error, action};
}
