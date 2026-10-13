import { useState } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { SessionView, type TranscriptEntry, type ToolEntry, type ThoughtEntry } from "../src/views/SessionView";
import { ThemeProvider } from "../src/theme/ThemeProvider";
import { remoteExperimentEnabled } from "../src/services/experiments";
import "@fontsource-variable/ibm-plex-sans/index.css";
import "@fontsource/ibm-plex-mono/400.css";
import "../src/styles.css";

const requestedSize = Number(new URL(location.href).searchParams.get("size") ?? 100);
if (![100, 1000, 10_000].includes(requestedSize)) throw new Error("unsupported fixture size");
const messages: TranscriptEntry[] = [];
const tools: ToolEntry[] = [];
const thoughts: ThoughtEntry[] = [];
for (let index = 0; index < requestedSize; index++) {
  if (index % 4 === 0) messages.push({id: `user-${index}`, role: "user", text: `Synthetic task ${index}: inspect fixture and preserve exact token CANARY-${index}.`, seq: index});
  if (index % 4 === 1) thoughts.push({id: `thought-${index}`, text: `Synthetic reasoning ${index}`, seq: index});
  if (index % 4 === 2) tools.push({id: `tool-${index}`, name: "fixture reader", action: "read", readOnly: true, detail: `fixture-${index}.txt`, finished: true, failed: false, truncated: false, seq: index});
  if (index % 4 === 3) messages.push({id: `agent-${index}`, role: "agent", text: `**Synthetic result ${index}**: preserve \`value_${index}\`.\n\n- Read the fixture\n- Keep the original`, seq: index});
}
const empty = [];
const noop = () => {};
const sessions = [{sessionId: "fixture", workspaceId: "workspace", workspaceName: "Synthetic fixture", running: true, openedAtMs: 1}];
let stream: (iteration: number) => void = noop;
let committedDraft = "";
function Fixture() {
  const [draft, setDraft] = useState("");
  committedDraft = draft;
  const [transcript, setTranscript] = useState(messages);
  stream = (iteration) => setTranscript((previous) => previous.map((entry, index) => index === previous.length - 1 ? {...entry, text: `${messages.at(-1)!.text}\n\nStream sample ${iteration}`} : entry));
  return <ThemeProvider><SessionView transcript={transcript} tools={tools} thoughts={thoughts} reviews={empty} phase="streaming" connected sessions={sessions} activeSessionId="fixture" sessionTitles={{fixture: "Synthetic transcript"}} draft={draft} onDraftChange={setDraft} queued={empty} onSendNow={noop} onRemoveQueued={noop} onSelectSession={noop} onCloseSession={noop} onLeaveSession={noop} onPrompt={noop} onCancel={noop} onAcknowledge={noop} /></ThemeProvider>;
}
flushSync(() => createRoot(document.getElementById("root")!).render(<Fixture />));
const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
const inputValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
const api = {
  variant: remoteExperimentEnabled("transcript") ? "candidate" : "reference",
  requestedSize,
  async step(kind: "input" | "stream", iteration: number) {
    await frame();
    const start = performance.now();
    flushSync(() => {
      if (kind === "input") {
        const input = document.querySelector<HTMLTextAreaElement>("#composer")!;
        inputValue.call(input, `Synthetic draft ${iteration}`);
        input.dispatchEvent(new InputEvent("input", {bubbles: true, inputType: "insertText", data: String(iteration)}));
      } else stream(iteration);
    });
    const root = document.getElementById("root")!;
    root.getBoundingClientRect();
    const layoutMs = performance.now() - start;
    await frame();
    const nextFrameMs = performance.now() - start;
    const input = document.querySelector<HTMLTextAreaElement>("#composer")!;
    if (kind === "input" && (input.value !== `Synthetic draft ${iteration}` || committedDraft !== `Synthetic draft ${iteration}`)) throw new Error("input was not committed");
    if (kind === "stream" && !root.textContent?.includes(`Stream sample ${iteration}`)) throw new Error("stream was not committed");
    return {layoutMs, nextFrameMs};
  },
  inspect() {
    const rows = [...document.querySelectorAll("article[data-turn-id]")];
    return {variant: api.variant, requestedSize, messages: rows.length, order: rows.map((row) => row.getAttribute("data-turn-id")), first: rows[0]?.textContent, last: rows.at(-1)?.textContent, visibility: document.visibilityState, viewport: [innerWidth, innerHeight], scrollHeight: document.documentElement.scrollHeight, liveRegions: [...document.querySelectorAll('[role="status"]')].map((node) => node.textContent), carets: document.querySelectorAll('[data-testid="streaming-caret"]').length};
  },
};
(window as unknown as {transcriptBenchmark: typeof api}).transcriptBenchmark = api;
