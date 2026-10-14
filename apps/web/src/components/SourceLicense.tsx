import {useEffect, useState} from "react";
import {Button} from "./ui";
import {ComposerDialog} from "./ComposerDialog";
import {loadSourceDistribution, shellBuildId, type SourceDistribution} from "../services/sourceDistribution";

export function SourceLicense() {
  const [open, setOpen] = useState(false);
  const [source, setSource] = useState<SourceDistribution>();
  const [error, setError] = useState("");
  useEffect(() => {
    if (!open) return;
    setSource(undefined);
    setError("");
    const shellId = shellBuildId(document);
    if (!shellId) {setError("Source information is unavailable for this local build."); return;}
    const controller = new AbortController();
    let active = true;
    const timer = setTimeout(() => controller.abort(), 10000);
    void loadSourceDistribution(shellId, controller.signal).then(value => {if (!controller.signal.aborted) setSource(value);}).catch(() => {
      if (active) setError("Source information is unavailable for this app version. Connect to the website and try again.");
    }).finally(() => clearTimeout(timer));
    return () => {active = false; clearTimeout(timer); controller.abort();};
  }, [open]);
  return <>
    <Button variant="ghost" size="sm" onClick={() => setOpen(true)}>Source and license</Button>
    <ComposerDialog open={open} title="Source and license" onClose={() => setOpen(false)}>
      <p className="text-body text-muted-foreground">Grok Remote is available under AGPL-3.0-or-later, or a separate written commercial license.</p>
      {error ? <p role="status" className="mt-4 text-body-sm text-muted-foreground">{error}</p> : !source ? <p role="status" className="mt-4 text-body-sm text-muted-foreground">Checking this app version…</p> : <div className="mt-4 flex flex-col gap-3">
        <a className="text-foreground underline" href={source.archive.path} download rel="noreferrer">Download corresponding source ({(source.archive.bytes / 1024 / 1024).toFixed(1)} MiB)</a>
        <a className="text-foreground underline" href={source.license.path} target="_blank" rel="noreferrer">Read license</a>
        <a className="text-foreground underline" href={source.notices.path} target="_blank" rel="noreferrer">Third-party notices</a>
        <p className="text-body-sm text-muted-foreground">The archive includes this app’s source, its libraries and build instructions.</p>
        <details className="text-body-sm"><summary className="cursor-pointer">Source version and checksum</summary><p className="mt-2 break-all">Portable {source.sources.portable.commit}</p><p className="mt-2 break-all">SHA256 {source.archive.sha256}</p></details>
      </div>}
    </ComposerDialog>
  </>;
}
