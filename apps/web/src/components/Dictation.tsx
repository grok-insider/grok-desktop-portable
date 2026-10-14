import { useEffect, useId, useRef, useState } from "react";
import { Mic } from "lucide-react";
import { Button, IconButton } from "./ui";
import { ComposerDialog } from "./ComposerDialog";

export interface Recognition {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((event: {results: ArrayLike<{isFinal: boolean; 0: {transcript: string}}>}) => void) | null;
  onerror: ((event: {error: string}) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}

export function recognitionConstructor(): (new () => Recognition) | undefined {
  const browser = window as unknown as {SpeechRecognition?: new () => Recognition; webkitSpeechRecognition?: new () => Recognition};
  return browser.SpeechRecognition ?? browser.webkitSpeechRecognition;
}

export function Dictation({disabled, onInsert, onOpen}: {disabled: boolean; onInsert: (text: string) => boolean; onOpen?: () => void}) {
  const [open, setOpen] = useState(false);
  const [listening, setListening] = useState(false);
  const [text, setText] = useState("");
  const [error, setError] = useState<string>();
  const [language, setLanguage] = useState(navigator.language || "en-US");
  const active = useRef<Recognition | null>(null);
  const generation = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const id = useId();
  const stop = (discard: boolean) => {
    if (discard) {
      generation.current += 1;
      active.current?.abort();
      active.current = null;
      clearTimeout(timer.current);
      setListening(false);
      setText("");
    } else active.current?.stop();
  };
  const close = () => {stop(true);setError(undefined);setOpen(false);};
  useEffect(() => () => {generation.current += 1; active.current?.abort(); clearTimeout(timer.current);}, []);
  useEffect(() => {if (disabled) {stop(true);setOpen(false);}}, [disabled]);
  const start = () => {
    if (disabled || active.current) return;
    const Constructor = recognitionConstructor();
    if (!Constructor) {setError("Dictation is unavailable in this browser. You can type or use your keyboard's dictation.");return;}
    const run = ++generation.current;
    let recognition: Recognition;
    try {recognition = new Constructor();}
    catch {setError("Dictation could not start. Check whether this browser supports speech recognition.");return;}
    recognition.lang = language;
    recognition.continuous = true;
    recognition.interimResults = false;
    recognition.onresult = (event) => {
      if (run !== generation.current) return;
      const words = Array.from(event.results).filter(result => result.isFinal).map(result => result[0].transcript).join(" ");
      if (words.length > 32_000) {setError("The dictation reached its limit. Review this text, then record the next part.");recognition.stop();return;}
      setText(words);
    };
    recognition.onerror = (event) => {
      if (run !== generation.current) return;
      const messages: Record<string, string> = {"not-allowed":"Microphone access was denied. Enable it in this site's settings to dictate.", "service-not-allowed":"The browser's recognition service is unavailable.", "no-speech":"No speech was detected. Try again when you are ready.", "network":"Dictation lost its network connection. Review any captured text before retrying.", "audio-capture":"The microphone is unavailable. Check your device's microphone settings."};
      setError(messages[event.error] ?? "Dictation stopped. Review any captured text before retrying.");
      setListening(false);
      active.current = null;
      clearTimeout(timer.current);
      generation.current += 1;
      recognition.abort();
    };
    recognition.onend = () => {if (run === generation.current) {setListening(false);active.current = null;clearTimeout(timer.current);}};
    active.current = recognition;
    setText("");setError(undefined);
    try {recognition.start();setListening(true);timer.current = setTimeout(() => {if (run === generation.current) recognition.stop();}, 120_000);}
    catch {generation.current += 1;active.current = null;setListening(false);setError("Dictation could not start. Check the browser's microphone permission.");}
  };
  return <>
    <IconButton disabled={disabled} className="size-11" aria-label="Dictate" title="Dictate" aria-haspopup="dialog" aria-expanded={open} aria-controls={`${id}-dialog`} onClick={() => {onOpen?.();setOpen(true);}}><Mic size={18} aria-hidden="true" /></IconButton>
    <ComposerDialog open={open} id={`${id}-dialog`} title="Dictation" description="Your browser's recognition service may process microphone audio. Start when you are ready, then review the text before adding it to your draft." onClose={close}>
      <div className="space-y-4">
        <label htmlFor={`${id}-language`} className="flex flex-wrap items-center gap-3 text-body-sm">Language
          <input id={`${id}-language`} value={language} disabled={listening} onChange={event => setLanguage(event.target.value)} className="min-h-11 min-w-0 max-w-36 rounded-md border border-input bg-card px-3" />
        </label>
        <div className="flex flex-wrap items-center gap-2">
          {listening ? <Button className="min-h-11" onClick={() => stop(false)}>Stop recording</Button> : <Button disabled={disabled || text.length > 0} variant="primary" className="min-h-11" onClick={start}><Mic size={16} aria-hidden="true" />Start microphone</Button>}
          {listening && <p role="status" className="text-body-sm text-muted-foreground">Listening…</p>}
        </div>
        {error && <p role="alert" className="text-body-sm text-warning">{error}</p>}
        {text && <div className="space-y-2"><label htmlFor={`${id}-text`} className="text-body-sm">Review dictation</label><textarea id={`${id}-text`} value={text} disabled={listening} onChange={event => {setText(event.target.value);setError(undefined);}} rows={5} className="block min-h-28 w-full resize-y rounded-md border border-input bg-card p-3" /></div>}
        <div className="flex flex-wrap justify-end gap-2 border-t border-border pt-4">
          <Button className="min-h-11" onClick={close}>Cancel dictation</Button>
          {text && <Button variant="primary" disabled={disabled || listening || !text.trim()} className="min-h-11" onClick={() => {if (onInsert(text)) {setText("");setOpen(false);} else setError("This text could not be inserted. Your draft is unchanged. Shorten the review or cancel and reopen dictation.");}}>Insert into draft</Button>}
        </div>
      </div>
    </ComposerDialog>
  </>;
}
