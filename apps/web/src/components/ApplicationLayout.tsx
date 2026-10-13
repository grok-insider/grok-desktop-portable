import { useLayoutEffect, type ReactNode } from "react";
import { PwaActions } from "./PwaActions";

export function ApplicationLayout({children}: {children: ReactNode}) {
  useLayoutEffect(() => {
    const viewport = window.visualViewport;
    const updateHeight = () => {
      const height = viewport?.scale === 1 ? Math.min(window.innerHeight, viewport.height) : window.innerHeight;
      if (Number.isFinite(height) && height > 0) document.documentElement.style.setProperty("--app-viewport-height", `${height}px`);
    };
    updateHeight();
    window.addEventListener("resize", updateHeight);
    window.addEventListener("pageshow", updateHeight);
    viewport?.addEventListener("resize", updateHeight);
    return () => {
      window.removeEventListener("resize", updateHeight);
      window.removeEventListener("pageshow", updateHeight);
      viewport?.removeEventListener("resize", updateHeight);
      document.documentElement.style.removeProperty("--app-viewport-height");
    };
  }, []);
  return <div className="application-shell">
    <div className="application-content">{children}</div>
    <PwaActions />
  </div>;
}
