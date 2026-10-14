import { useEffect, useRef, useState } from "react";
import { Button } from "../components/ui";
import { MarkdownMessage } from "../components/MarkdownMessage";
import type { InteractionRequest } from "../services/protocol";

interface Question {
  question: string;
  options: {label: string; description?: string}[];
  multiSelect?: boolean;
}

interface Field {
  type?: string;
  title?: string;
  description?: string;
  enum?: unknown[];
}

function questionsFrom(value: unknown): Question[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  if (!value.every((question) => question && typeof question.question === "string" && Array.isArray(question.options) && question.options.every((option: {label?: unknown; description?: unknown}) => option && typeof option.label === "string" && (option.description === undefined || typeof option.description === "string")))) return null;
  return value as Question[];
}

function requestedWebsite(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password ? url.href : null;
  } catch {return null;}
}

export function InteractionDialog({request, busy, connected = true, onReconnect, onAnswer}: {
  request: InteractionRequest;
  busy: boolean;
  connected?: boolean;
  onReconnect?: () => void;
  onAnswer: (answer: Record<string, unknown>) => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [answers, setAnswers] = useState<Record<string, string[]>>({});
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [content, setContent] = useState<Record<string, unknown>>({});
  const [feedback, setFeedback] = useState("");
  const [websiteCompleted, setWebsiteCompleted] = useState(false);
  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal();
    return () => dialog?.close();
  }, []);

  const details = request.details;
  const questions = questionsFrom(details.questions);
  const schema = (details.requestedSchema ?? {}) as {properties?: Record<string, Field>; required?: string[]};
  const fields = Object.entries(schema.properties ?? {});
  const urlMode = request.interactionKind === "mcp" && details.mode === "url";
  const website = requestedWebsite(details.url);
  const unsupported = request.interactionKind === "question" ? !questions
    : request.interactionKind === "plan" ? typeof details.planContent !== "string" || !details.planContent.trim()
    : urlMode ? !website
    : fields.some(([, field]) => !field || !["string", "number", "integer", "boolean"].includes(field.type ?? "") || (field.title !== undefined && typeof field.title !== "string") || (field.description !== undefined && typeof field.description !== "string") || (field.enum !== undefined && (!Array.isArray(field.enum) || field.enum.some((value) => !["string", "number", "boolean"].includes(typeof value)))));
  const unanswered = request.interactionKind === "question" && questions?.some((question) => {
    const selected = answers[question.question] ?? [];
    return !selected.length || (selected.includes("Other") && !notes[question.question]?.trim());
  });
  const sendAnswer = () => {
    if (busy || !connected || unsupported || unanswered || (urlMode && !websiteCompleted)) return;
    if (request.interactionKind === "question") {
      const annotations = Object.fromEntries(Object.entries(notes).filter(([question, text]) => answers[question]?.includes("Other") && text.trim()).map(([question, text]) => [question, {notes: text.trim()}]));
      onAnswer({outcome: "accepted", answers, ...(Object.keys(annotations).length ? {annotations} : {})});
    } else if (request.interactionKind === "plan") onAnswer({outcome: "approved"});
    else onAnswer({outcome: "accept", ...(urlMode ? {} : {content})});
  };
  const updateValue = (name: string, value: unknown) => setContent((held) => {
    const next = {...held};
    if (value === undefined) delete next[name]; else next[name] = value;
    return next;
  });

  return <dialog ref={ref} onCancel={(event) => {
    event.preventDefault();
    if (!busy) onAnswer({outcome: request.interactionKind === "mcp" ? "cancel" : "cancelled"});
  }} className="interaction-dialog" aria-labelledby="interaction-title">
    <h2 id="interaction-title" className="text-title-sm font-semibold">
      {request.interactionKind === "plan" ? "Review the plan" : request.interactionKind === "mcp" ? "Information requested by a tool" : "Grok needs your answer"}
    </h2>
    {!connected && <div role="status" className="my-3"><p>Your computer disconnected. Your answer is kept here.</p><Button onClick={onReconnect}>Reconnect</Button></div>}
    <form onSubmit={(event) => {event.preventDefault(); sendAnswer();}}>
      {unsupported && <p className="my-3 text-warning">This request needs the terminal. Return to Grok there to complete it.</p>}
      {request.interactionKind === "plan" && <>
        <MarkdownMessage>{String(details.planContent ?? "")}</MarkdownMessage>
        <label className="my-4 block">Feedback for changes
          <textarea value={feedback} onChange={(event) => setFeedback(event.target.value)} />
        </label>
      </>}
      {request.interactionKind === "question" && questions?.map((question, index) => <fieldset key={index} className="my-4">
        <legend className="mb-2 font-semibold">{question.question}</legend>
        {[...question.options.filter((option) => option.label !== "Other"), {label: "Other", description: "Write your answer"}].map((option) => <label key={option.label} className="interaction-option">
          <input type={question.multiSelect ? "checkbox" : "radio"} name={`question-${index}`} checked={(answers[question.question] ?? []).includes(option.label)} onChange={(event) => setAnswers((held) => ({
            ...held,
            [question.question]: question.multiSelect
              ? event.target.checked ? [...(held[question.question] ?? []), option.label] : (held[question.question] ?? []).filter((value) => value !== option.label)
              : [option.label],
          }))} />
          <span>{option.label}{option.description && <span className="block text-body-sm text-muted-foreground">{option.description}</span>}</span>
        </label>)}
        {(answers[question.question] ?? []).includes("Other") && <label className="block">Your answer
          <textarea required value={notes[question.question] ?? ""} onChange={(event) => setNotes((held) => ({...held, [question.question]: event.target.value}))} />
        </label>}
      </fieldset>)}
      {request.interactionKind === "mcp" && <>
        <p className="my-3 whitespace-pre-wrap">{String(details.serverName ?? "Tool")}: {String(details.message ?? "")}</p>
        {urlMode && website && <>
          <a className="break-all underline" href={website} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">Open requested website: {website}</a>
          <label className="interaction-option my-3"><input type="checkbox" checked={websiteCompleted} onChange={(event) => setWebsiteCompleted(event.target.checked)} />I completed the request on that website.</label>
        </>}
        {!urlMode && !unsupported && fields.map(([name, field]) => <label className="my-3 block" key={name}>
          <span className="block font-semibold">{field.title ?? name}</span>
          {field.description && <span className="block text-body-sm text-muted-foreground">{field.description}</span>}
          {field.enum || field.type === "boolean" ? <select required={schema.required?.includes(name)} value={String(content[name] ?? "")} onChange={(event) => updateValue(name, (field.enum ?? [true, false]).find((value) => String(value) === event.target.value))}>
            <option value="">Choose…</option>
            {(field.enum ?? [true, false]).map((value) => <option key={String(value)} value={String(value)}>{field.type === "boolean" ? value ? "Yes" : "No" : String(value)}</option>)}
          </select> : <input type={field.type === "string" ? "text" : "number"} step={field.type === "integer" ? 1 : "any"} required={schema.required?.includes(name)} onChange={(event) => updateValue(name, field.type === "string" ? event.target.value : event.target.value === "" ? undefined : Number(event.target.value))} />}
        </label>)}
      </>}
      <div className="mt-5 flex flex-wrap justify-end gap-3">
        <Button disabled={busy} onClick={() => onAnswer({outcome: request.interactionKind === "mcp" ? "decline" : "cancelled", ...(request.interactionKind === "plan" && feedback ? {feedback} : {})})}>{request.interactionKind === "plan" ? "Request changes" : "Decline"}</Button>
        <Button type="submit" variant="primary" disabled={busy || unsupported || Boolean(unanswered) || (urlMode && !websiteCompleted)}>{request.interactionKind === "plan" ? "Approve plan" : "Send answer"}</Button>
      </div>
    </form>
  </dialog>;
}
