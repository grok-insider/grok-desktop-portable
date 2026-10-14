import {useState} from "react";
import {createRoot} from "react-dom/client";
import {Dictation} from "../src/components/Dictation";
import {SpeechPlayback} from "../src/components/SpeechPlayback";

function VoiceFixture() {
  const [session, setSession] = useState(0);
  const [disabled, setDisabled] = useState(false);
  const [refuse, setRefuse] = useState(false);
  const [draft, setDraft] = useState("");
  const [insertions, setInsertions] = useState(0);
  const [submissions, setSubmissions] = useState(0);
  const answer = ("Synthetic answer with git status, TypeScript, and 🦀. ".repeat(140)).trim();
  return <main>
    <h1>Remote voice control fixture</h1>
    <button onClick={() => {setSession(value => value + 1);setDraft("");}}>Change session</button>
    <label><input type="checkbox" checked={disabled} onChange={event => setDisabled(event.target.checked)} />Access unavailable</label>
    <label><input type="checkbox" checked={refuse} onChange={event => setRefuse(event.target.checked)} />Refuse insertion</label>
    <Dictation key={`dictation-${session}`} disabled={disabled} onInsert={text => {
      if (refuse || disabled) return false;
      setDraft(value => value ? `${value}\n\n${text}` : text);
      setInsertions(value => value + 1);
      return true;
    }} />
    <label htmlFor="draft">Message draft</label>
    <textarea id="draft" value={draft} onChange={event => setDraft(event.target.value)} />
    <button disabled={disabled || !draft.trim()} onClick={() => setSubmissions(value => value + 1)}>Send message</button>
    <output aria-label="Insertions">{insertions}</output>
    <output aria-label="Submissions">{submissions}</output>
    <SpeechPlayback key={`playback-${session}`} text={answer} disabled={disabled} />
    <p id="answer">{answer}</p>
  </main>;
}

createRoot(document.getElementById("root")!).render(<VoiceFixture />);
