import {useCallback, useEffect, useRef, useState} from "react";
import type {LightClient} from "./client";
import {asSessionExecution, asSessionModels, type SessionExecution, type SessionModels} from "./sessionExecution";

export function useSessionRuntime(client: LightClient, connected: boolean, sessionId: string | null) {
  const [execution, setExecution] = useState<Record<string, SessionExecution>>({});
  const [models, setModels] = useState<Record<string, SessionModels>>({});
  const lifecycle = useRef({client, generation: 0, active: false, pending: new Set<string>(), running: new Set<string>()});
  const multiWriter = client.multiWriter;
  const refresh = useCallback((target: string) => {
    const life = lifecycle.current;
    if (!life.active || !client.multiWriter) return;
    if (life.running.has(target)) {life.pending.add(target); return;}
    const generation = life.generation;
    const current = () => life === lifecycle.current && life.active && life.generation === generation;
    life.running.add(target);
    const run = async () => {
      do {
        life.pending.delete(target);
        await Promise.allSettled([
          client.send({kind: "getSessionExecution", sessionId: target}).then(reply => {
            const next = reply.ok ? asSessionExecution(reply.value) : null;
            if (current() && next?.sessionId === target) setExecution(previous => !previous[target] || next.revision >= previous[target].revision ? {...previous, [target]: next} : previous);
          }),
          client.send({kind: "getSessionModels", sessionId: target}).then(reply => {
            const next = reply.ok ? asSessionModels(reply.value) : null;
            if (current() && next?.sessionId === target) setModels(previous => !previous[target] || next.revision >= previous[target].revision ? {...previous, [target]: next} : previous);
          }),
        ]);
      } while (current() && life.pending.has(target));
      life.running.delete(target);
    };
    void run();
  }, [client]);
  useEffect(() => {
    const life = {client, generation: lifecycle.current.generation + 1, active: connected && multiWriter, pending: new Set<string>(), running: new Set<string>()};
    lifecycle.current = life;
    setExecution({});
    setModels({});
    return () => {life.active = false; life.generation++;};
  }, [client, connected, multiWriter]);
  useEffect(() => {if (sessionId) refresh(sessionId);}, [refresh, sessionId, connected, multiWriter]);
  return {execution, models, refresh};
}
