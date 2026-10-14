import { useLayoutEffect, type ReactNode } from "react";
import { PwaActions } from "./PwaActions";

export function ApplicationLayout({children}: {children: ReactNode}) {
  useLayoutEffect(() => {
    const viewport = window.visualViewport;
    let frame = 0;
    const revealComposer = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (viewport && viewport.scale !== 1) return;
        const composer = document.activeElement?.closest('[data-composer-chrome="card"]');
        if (!composer) return;
        const bounds = composer.getBoundingClientRect();
        let clipped = bounds.top < 0 || bounds.bottom > (viewport?.height ?? window.innerHeight);
        for (let parent = composer.parentElement; parent && !clipped; parent = parent.parentElement) {
          const style = getComputedStyle(parent), clip = parent.getBoundingClientRect();
          clipped = /(hidden|clip|scroll|auto)/.test(style.overflowY) && (bounds.top < clip.top || bounds.bottom > clip.bottom);
        }
        if (clipped || document.documentElement.hasAttribute("data-short-viewport")) composer.scrollIntoView({block: "nearest", inline: "nearest"});
      });
    };
    const updateHeight = () => {
      const height = viewport?.scale === 1 ? Math.min(window.innerHeight, viewport.height) : window.innerHeight;
      if (Number.isFinite(height) && height > 0) {
        document.documentElement.style.setProperty("--app-viewport-height", `${height}px`);
        document.documentElement.toggleAttribute("data-short-viewport", height <= 300);
        revealComposer();
      }
    };
    updateHeight();
    window.addEventListener("resize", updateHeight);
    window.addEventListener("pageshow", updateHeight);
    viewport?.addEventListener("resize", updateHeight);
    document.addEventListener("focusin", revealComposer);
    return () => {
      window.removeEventListener("resize", updateHeight);
      window.removeEventListener("pageshow", updateHeight);
      viewport?.removeEventListener("resize", updateHeight);
      document.removeEventListener("focusin", revealComposer);
      cancelAnimationFrame(frame);
      document.documentElement.style.removeProperty("--app-viewport-height");
      document.documentElement.removeAttribute("data-short-viewport");
    };
  }, []);
  return <div className="application-shell">
    <div className="application-content">{children}</div>
    <PwaActions />
  </div>;
}
