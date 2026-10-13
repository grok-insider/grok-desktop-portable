import { useEffect, useRef, useState } from "react";
import { Pause, Play, Square, Volume2 } from "lucide-react";
import { IconButton } from "./ui";

export function speechChunks(text: string): string[] {
  if (text.length > 200_000) throw new Error("This answer is too long for playback. Select a shorter answer.");
  const chunks: string[] = [];
  let remaining = text.trim();
  while (remaining) {
    let end = Math.min(remaining.length, 500);
    if (end < remaining.length) {
      const boundary = remaining.lastIndexOf(" ", end);
      if (boundary > 100) end = boundary;
      if (end > 0 && /[\uD800-\uDBFF]/.test(remaining[end - 1])) end -= 1;
    }
    chunks.push(remaining.slice(0, end));
    remaining = remaining.slice(end).trimStart();
  }
  return chunks;
}

export function localSpeechVoice(voices: readonly SpeechSynthesisVoice[], language: string): SpeechSynthesisVoice | undefined {
  const local = voices.filter(voice => voice.localService === true);
  const lang = language.toLowerCase();
  return local.find(voice => voice.lang.toLowerCase() === lang) ?? local.find(voice => voice.lang.split("-")[0].toLowerCase() === lang.split("-")[0]) ?? local.find(voice => voice.default) ?? local[0];
}

export function SpeechPlayback({text, disabled}: {text: string; disabled: boolean}) {
  const [status, setStatus] = useState<"idle" | "playing" | "paused">("idle");
  const [error, setError] = useState<string>();
  const generation = useRef(0);
  const speaking = useRef(false);
  const stop = () => {generation.current += 1;if (speaking.current) window.speechSynthesis?.cancel();speaking.current = false;setStatus("idle");};
  useEffect(() => () => {generation.current += 1;if (speaking.current) window.speechSynthesis?.cancel();}, []);
  useEffect(() => {stop();}, [text, disabled]);
  const start = () => {
    if (disabled || status !== "idle") return;
    if (!window.speechSynthesis || !window.SpeechSynthesisUtterance) {setError("Speech playback is unavailable in this browser.");return;}
    const voice = localSpeechVoice(window.speechSynthesis.getVoices(), navigator.language);
    if (!voice) {setError("No on-device voice is available. Install a voice in your device settings, then try again.");return;}
    let chunks: string[];
    try {chunks = speechChunks(text);} catch (failure) {setError((failure as Error).message);return;}
    const run = ++generation.current;
    setError(undefined);setStatus("playing");speaking.current = true;
    const next = () => {
      if (run !== generation.current) return;
      const chunk = chunks.shift();
      if (!chunk) {speaking.current = false;setStatus("idle");return;}
      const utterance = new SpeechSynthesisUtterance(chunk);
      if (!window.speechSynthesis.getVoices().some(current => current.localService === true && current.voiceURI === voice.voiceURI)) {stop();setError("The on-device voice is no longer available.");return;}
      utterance.voice = voice;
      utterance.lang = voice.lang;
      utterance.onend = next;
      utterance.onerror = () => {if (run === generation.current) {stop();setError("Playback stopped. You can start it again.");}};
      try {window.speechSynthesis.speak(utterance);} catch {stop();setError("Speech playback could not start.");}
    };
    next();
  };
  return <div className="flex min-w-0 flex-wrap items-center gap-1 text-body-sm" role="group" aria-label="Answer playback">
    {status === "idle" ? <IconButton disabled={disabled || !text.trim()} className="size-11" aria-label="Read last answer" title="Read last answer" onClick={start}><Volume2 size={18} aria-hidden="true" /></IconButton> : <>
      <IconButton className="size-11" aria-label={status === "playing" ? "Pause playback" : "Resume playback"} title={status === "playing" ? "Pause playback" : "Resume playback"} onClick={() => {if (status === "playing") {window.speechSynthesis.pause();setStatus("paused");} else {window.speechSynthesis.resume();setStatus("playing");}}}>{status === "playing" ? <Pause size={18} aria-hidden="true" /> : <Play size={18} aria-hidden="true" />}</IconButton>
      <IconButton className="size-11" aria-label="Stop playback" title="Stop playback" onClick={stop}><Square size={16} aria-hidden="true" /></IconButton>
      <span role="status" className="text-muted-foreground">{status === "playing" ? "Reading…" : "Paused"}</span>
    </>}
    {error && <p role="alert" className="w-full text-warning">{error}</p>}
  </div>;
}
