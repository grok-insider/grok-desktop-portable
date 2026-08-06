/**
 * Floating avatar for all Portable surfaces (ADR light 0020).
 *
 * Stage: @aether/studio (three-vrm WebGL). Optional Studio dogfood panel when
 * `?aetherStudio=1` or Vite DEV — model/anim/camera/lights/debug metrics.
 * StudioPanel + CSS load only when the panel opens (lazy).
 * Agent API: window.__AETHER_STUDIO__ when stage is ready and studio gate allows.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  attachAetherStudioAgent,
  createStage,
  type Stage,
  type StagePhase,
} from "@aether/studio";
import {
  activityForPhase,
  phaseFromSearch,
  type AvatarPhase,
} from "../../services/aether/activity";
import { assetUrl, loadAetherManifest } from "../../services/aether/load";
import {
  readAetherVisible,
  writeAetherVisible,
} from "../../services/aether/preference";
import { isAetherStudioAllowed } from "../../services/aether/studioGate";

const CANVAS_W = 480;
const CANVAS_H = 720;

type PanelHandle = {
  mount: (parent?: HTMLElement) => void;
  unmount: () => void;
};

type StudioPanelCtor = new (
  stage: Stage,
  opts?: {
    defaultModelUrl?: string;
    onClose?: () => void;
    libraryCatalogUrl?: string;
  },
) => PanelHandle;

let studioPanelModule: { StudioPanel: StudioPanelCtor } | null = null;
let studioStylesLoaded = false;

async function loadStudioPanelModule(): Promise<StudioPanelCtor> {
  if (!studioStylesLoaded) {
    await import("@aether/studio/styles.css");
    studioStylesLoaded = true;
  }
  if (!studioPanelModule) {
    studioPanelModule = await import("@aether/studio/panel");
  }
  return studioPanelModule.StudioPanel;
}

export function AvatarPresence({
  phase = "idle",
}: {
  phase?: AvatarPhase;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const stageRef = useRef<Stage | null>(null);
  const panelRef = useRef<PanelHandle | null>(null);
  const detachAgentRef = useRef<(() => void) | null>(null);
  const openStudioRef = useRef<() => Promise<void>>(async () => {});
  const closeStudioRef = useRef<() => void>(() => {});
  const streamStartedRef = useRef<number | null>(null);
  const [visible, setVisible] = useState(() => readAetherVisible());
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);
  const [studioOpen, setStudioOpen] = useState(false);
  const studioAllowed = useMemo(() => isAetherStudioAllowed(), []);
  const reducedMotion = usePrefersReducedMotion();
  const modelUrlRef = useRef<string>("");
  const libraryUrl = useMemo(
    () =>
      typeof window !== "undefined"
        ? assetUrl("assets/aether/library/catalog.json")
        : "",
    [],
  );

  const effectivePhase = useMemo(() => {
    if (typeof window === "undefined") return phase;
    return phaseFromSearch(window.location.search, phase);
  }, [phase]);
  const phaseRef = useRef(effectivePhase);
  phaseRef.current = effectivePhase;

  const toggleVisible = useCallback(() => {
    setVisible((v) => {
      const next = !v;
      writeAetherVisible(next);
      return next;
    });
  }, []);

  const closeStudio = useCallback(() => {
    panelRef.current?.unmount();
    panelRef.current = null;
    stageRef.current?.enableControls(false);
    setStudioOpen(false);
  }, []);

  const openStudio = useCallback(async () => {
    const stage = stageRef.current;
    if (!stage || !studioAllowed) return;
    if (panelRef.current) return;
    try {
      const StudioPanel = await loadStudioPanelModule();
      if (stageRef.current !== stage || panelRef.current) return;
      const panel = new StudioPanel(stage, {
        defaultModelUrl: modelUrlRef.current,
        onClose: closeStudio,
        libraryCatalogUrl: libraryUrl,
      });
      panel.mount();
      panelRef.current = panel;
      stage.enableControls(true);
      setStudioOpen(true);
    } catch (err) {
      console.warn("[aether] studio panel load failed", err);
    }
  }, [studioAllowed, closeStudio, libraryUrl]);

  const toggleStudio = useCallback(() => {
    if (studioOpen) closeStudio();
    else void openStudio();
  }, [studioOpen, openStudio, closeStudio]);

  openStudioRef.current = openStudio;
  closeStudioRef.current = closeStudio;

  // Init stage + agent bridge
  useEffect(() => {
    if (!visible || failed) return;
    const canvas = canvasRef.current;
    if (!canvas) return;

    let cancelled = false;
    const start = () => {
      void (async () => {
        try {
          const manifest = await loadAetherManifest();
          const modelPath = manifest?.modelPath ?? "avatar.vrm";
          if (manifest && manifest.distributionAllowed === false) {
            if (!cancelled) setFailed(true);
            return;
          }
          const url = assetUrl(`assets/aether/${modelPath}`);
          const head = await fetch(url, { method: "GET", cache: "force-cache" });
          if (!head.ok) {
            if (!cancelled) setFailed(true);
            return;
          }
          modelUrlRef.current = url;

          const stage = await createStage(canvas, url, {
            width: CANVAS_W,
            height: CANVAS_H,
            maxFps: 24,
            studioControls: false,
            idleVrmaUrl: assetUrl("assets/aether/animations/idle.vrma"),
            speakingVrmaUrl: assetUrl("assets/aether/animations/speaking.vrma"),
          });
          if (cancelled) {
            stage.dispose();
            return;
          }
          stageRef.current = stage;
          stage.start();
          setReady(true);

          if (studioAllowed) {
            detachAgentRef.current?.();
            detachAgentRef.current = attachAetherStudioAgent({
              stage,
              libraryCatalogUrl: libraryUrl,
              openPanel: () => openStudioRef.current(),
              closePanel: () => closeStudioRef.current(),
              isPanelOpen: () => panelRef.current != null,
            });
          }

          // Auto-open studio once when query requests it
          if (
            studioAllowed &&
            typeof window !== "undefined" &&
            new URLSearchParams(window.location.search).get("aetherStudio") ===
              "1"
          ) {
            try {
              await openStudioRef.current();
            } catch (err) {
              console.warn("[aether] studio auto-open failed", err);
            }
          }
        } catch (err) {
          console.warn("[aether] stage init failed", err);
          if (!cancelled) setFailed(true);
        }
      })();
    };

    let idleId: number | undefined;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    if (typeof requestIdleCallback === "function") {
      idleId = requestIdleCallback(() => start(), { timeout: 800 });
    } else {
      timeoutId = setTimeout(start, 100);
    }

    return () => {
      cancelled = true;
      if (idleId !== undefined && typeof cancelIdleCallback === "function") {
        cancelIdleCallback(idleId);
      }
      if (timeoutId !== undefined) clearTimeout(timeoutId);
      detachAgentRef.current?.();
      detachAgentRef.current = null;
      panelRef.current?.unmount();
      panelRef.current = null;
      stageRef.current?.dispose();
      stageRef.current = null;
      setReady(false);
      setStudioOpen(false);
    };
    // openStudio/closeStudio stable enough; avoid re-init on every toggle
    // eslint-disable-next-line react-hooks/exhaustive-deps -- stage init once per visible/failed/gate
  }, [visible, failed, studioAllowed, libraryUrl]);

  // Session phase → activity
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage || !ready) return;

    if (effectivePhase === "streaming") {
      if (streamStartedRef.current === null) {
        streamStartedRef.current = performance.now();
      }
    } else {
      streamStartedRef.current = null;
    }

    const apply = () => {
      const s = stageRef.current;
      if (!s) return;
      const started = streamStartedRef.current;
      const elapsed =
        phaseRef.current === "streaming" && started !== null
          ? (performance.now() - started) / 1000
          : 0;
      const act = activityForPhase(
        reducedMotion && phaseRef.current === "streaming"
          ? "interrupted"
          : phaseRef.current,
        elapsed,
      );
      const phase: StagePhase =
        act.speaking ? "streaming" : phaseRef.current === "interrupted" ? "interrupted" : "idle";
      s.setActivity(phase, act.level);
    };

    apply();
    if (effectivePhase !== "streaming" || reducedMotion) return;
    const id = window.setInterval(apply, 50);
    return () => clearInterval(id);
  }, [effectivePhase, ready, reducedMotion]);

  useEffect(() => {
    stageRef.current?.setActive(visible && !document.hidden);
    const onVis = () => {
      stageRef.current?.setActive(visible && !document.hidden);
    };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, [visible, ready]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !ready) return;
    const ro = new ResizeObserver((entries) => {
      const cr = entries[0]?.contentRect;
      if (!cr || !stageRef.current) return;
      stageRef.current.setSize(
        Math.max(280, Math.round(cr.width)),
        Math.max(400, Math.round(cr.height)),
      );
    });
    ro.observe(canvas);
    return () => ro.disconnect();
  }, [ready, visible]);

  useEffect(() => {
    if (!studioAllowed || !ready) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "`" || (e.altKey && e.key.toLowerCase() === "a")) {
        e.preventDefault();
        toggleStudio();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [studioAllowed, ready, toggleStudio]);

  if (failed) return null;

  return (
    <div
      className="aether-presence"
      data-testid="aether-presence"
      data-ready={ready ? "true" : "false"}
      data-visible={visible ? "true" : "false"}
      data-engine="three-vrm"
      data-studio={studioOpen ? "open" : studioAllowed ? "allowed" : "off"}
      data-agent={studioAllowed && ready ? "1" : "0"}
    >
      <div className="aether-presence-controls">
        <button
          type="button"
          className="aether-presence-toggle"
          onClick={toggleVisible}
          aria-pressed={visible}
          aria-label={visible ? "Hide character" : "Show character"}
        >
          {visible ? "Hide" : "Show"} character
        </button>
        {studioAllowed && ready ? (
          <button
            type="button"
            className="aether-presence-toggle aether-studio-open"
            onClick={() => void toggleStudio()}
            aria-pressed={studioOpen}
            title="Aether Studio (dev tools). Also ` or Alt+A · Esc closes · agent: __AETHER_STUDIO__"
          >
            {studioOpen ? "Close Studio" : "Studio"}
          </button>
        ) : null}
      </div>
      {visible ? (
        <canvas
          ref={canvasRef}
          className="aether-presence-canvas"
          width={CANVAS_W}
          height={CANVAS_H}
          role="img"
          aria-label="Assistant character Ani"
        />
      ) : null}
    </div>
  );
}

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() => {
    if (typeof window === "undefined" || !window.matchMedia) return false;
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  });
  useEffect(() => {
    if (!window.matchMedia) return;
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const onChange = () => setReduced(mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  return reduced;
}
