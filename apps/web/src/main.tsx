/**
 * Entry point. The SPA is served by `grok-bridge` from its own loopback
 * origin; there is no other deployment target (light ADR 0002).
 */
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource-variable/ibm-plex-sans/index.css";
import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/500.css";
import "@fontsource/ibm-plex-mono/600.css";
import "./styles.css";
import { App } from "./App";
import { ThemeProvider } from "./theme/ThemeProvider";

const container = document.getElementById("root");
if (container === null) {
  throw new Error("missing #root");
}
createRoot(container).render(
  <StrictMode>
    <ThemeProvider>
      <App />
    </ThemeProvider>
  </StrictMode>,
);
