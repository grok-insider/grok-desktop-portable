/**
 * Entry point. The SPA is hosted at desktop.grok.me (light ADR 0016); the
 * `spanreed agent` host can also serve it from its own loopback origin.
 */
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { CSPProvider } from "@base-ui/react/csp-provider";
import "./styles/layers.css";
import "@fabrials/ui/tokens.css";
import "./styles/fonts.css";
import "@fabrials/ui/styles.css";
import "@fabrials/ai-ui/styles.css";
import "sonner/dist/styles.css";
import "./styles.css";
import { App } from "./App";
import { RemoteRoot } from "./RemoteRoot";
import { ApplicationLayout } from "./components/ApplicationLayout";
import { APPLICATION_ORIGIN, applicationEntry } from "./services/deploymentOrigin";
import { HostToaster } from "./components/HostToaster";
import { ThemeProvider } from "./theme/ThemeProvider";
import { takePublicationCallback } from "./services/publications";

const entry = applicationEntry(location.origin, location.hash);
const redirecting = entry === "redirect";
if (redirecting) location.replace(APPLICATION_ORIGIN + location.pathname + location.search + location.hash);
const publicationCallback = redirecting || entry === "blocked" ? null : takePublicationCallback();

const container = document.getElementById("root");
if (container === null) {
  throw new Error("missing #root");
}
if (!redirecting) createRoot(container).render(
  <StrictMode>
    <CSPProvider disableStyleElements>
    <ThemeProvider>
      <ApplicationLayout>
        {entry === "blocked" ? <main className="max-w-[48rem] p-(--fui-page-padding)"><h1 className="font-display text-title-lg font-semibold">This build belongs to another website</h1><p className="mt-3 text-muted-foreground">Open <a className="text-brand-ink underline underline-offset-2" href={APPLICATION_ORIGIN}>{APPLICATION_ORIGIN}</a> to continue. Pairing links must be created for that website.</p></main> : entry === "remote" ? <RemoteRoot publicationCallback={publicationCallback} /> : <App />}
      </ApplicationLayout>
      <HostToaster />
    </ThemeProvider>
    </CSPProvider>
  </StrictMode>,
);
