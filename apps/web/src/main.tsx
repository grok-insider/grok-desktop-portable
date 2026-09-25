/**
 * Entry point. The SPA is hosted at desktop.grok.me (light ADR 0016); the
 * `spanreed agent` host can also serve it from its own loopback origin.
 */
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource-variable/ibm-plex-sans/index.css";
import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/500.css";
import "@fontsource/ibm-plex-mono/600.css";
import "./styles.css";
import { App } from "./App";
import { HostToaster } from "./components/HostToaster";
import { ThemeProvider } from "./theme/ThemeProvider";

const container = document.getElementById("root");
if (container === null) {
  throw new Error("missing #root");
}
createRoot(container).render(
  <StrictMode>
    <ThemeProvider>
      <App />
      <HostToaster />
    </ThemeProvider>
  </StrictMode>,
);
