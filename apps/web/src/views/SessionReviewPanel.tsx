/**
 * Read-only Changes and Context inspection for the open conversation.
 *
 * Every path, ref, patch, and metric is host-projected and bounded. The panel
 * renders text only; it never interprets a patch as markup or sends a path back.
 */

import { useEffect, useState } from "react";
import { FileCode2, X } from "lucide-react";
import { IconButton, StatusChip, cn } from "../components/ui";
import type {
  ChangedFileProjection,
  ChangeStatus,
  SessionChangesProjection,
  SessionInspectorProjection,
  ToolProjection,
} from "../services/outcomes";
import type { ChangeMode } from "../services/protocol";

type InspectorTab = "changes" | "context";

const MODE_LABELS: Record<ChangeMode, string> = {
  git: "Git",
  branch: "Branch",
  lastTurn: "Last turn",
};

const EMPTY_FILES: ChangedFileProjection[] = [];
const EMPTY_MODES: ChangeMode[] = [];

const STATUS_LABELS: Record<ChangeStatus, string> = {
  added: "Added",
  modified: "Modified",
  deleted: "Deleted",
  renamed: "Renamed",
  copied: "Copied",
  typeChanged: "Type changed",
  untracked: "Untracked",
};

const STATUS_MARKS: Record<ChangeStatus, string> = {
  added: "A",
  modified: "M",
  deleted: "D",
  renamed: "R",
  copied: "C",
  typeChanged: "T",
  untracked: "U",
};

function formatCount(value: number): string {
  return new Intl.NumberFormat(undefined, { notation: "compact" }).format(value);
}

function formatDuration(milliseconds: number): string {
  if (milliseconds < 1_000) {
    return `${milliseconds} ms`;
  }
  if (milliseconds < 60_000) {
    return `${(milliseconds / 1_000).toFixed(1)} s`;
  }
  return `${(milliseconds / 60_000).toFixed(1)} min`;
}

function fileTone(status: ChangeStatus): string {
  switch (status) {
    case "added":
    case "untracked":
      return "text-success";
    case "deleted":
      return "text-destructive";
    case "renamed":
    case "copied":
      return "text-info";
    default:
      return "text-warning";
  }
}

function DiffBody({ file }: { file: ChangedFileProjection }) {
  if (file.patchState !== "complete" || file.patch === undefined) {
    const message =
      file.patchState === "binary"
        ? "Binary file changed."
        : file.patchState === "tooLarge"
          ? "The complete patch exceeds the review limit."
          : "The host could not provide a trustworthy patch.";
    return (
      <div className="flex min-h-40 items-center justify-center px-6 text-center text-body text-muted-foreground">
        {message}
      </div>
    );
  }

  return (
    <pre
      className="min-w-max bg-muted/50 py-3 font-mono text-label leading-5 text-foreground"
      aria-label={`Unified patch for ${file.path}`}
    >
      <code>
        {file.patch.split("\n").map((line, index) => {
          const addition = line.startsWith("+") && !line.startsWith("+++");
          const deletion = line.startsWith("-") && !line.startsWith("---");
          const hunk = line.startsWith("@@");
          return (
            <span
              // Patch content can repeat; position is the stable identity.
              key={index}
              className={cn(
                "block min-h-5 whitespace-pre px-3",
                addition && "bg-success-soft text-success",
                deletion && "bg-destructive-soft text-destructive",
                hunk && "bg-info-soft text-info",
              )}
            >
              {line || " "}
            </span>
          );
        })}
      </code>
    </pre>
  );
}

function ChangesTab({
  inspector,
  changes,
  loading,
  mode,
  onModeChange,
}: {
  inspector: SessionInspectorProjection | null;
  changes: SessionChangesProjection | null;
  loading: boolean;
  mode: ChangeMode;
  onModeChange: (mode: ChangeMode) => void;
}) {
  const files = changes?.files ?? EMPTY_FILES;
  const [selectedPath, setSelectedPath] = useState<string | null>(null);

  useEffect(() => {
    if (!files.some((file) => file.path === selectedPath)) {
      setSelectedPath(files[0]?.path ?? null);
    }
  }, [files, selectedPath]);

  const selected = files.find((file) => file.path === selectedPath) ?? null;
  const modes = inspector?.availableChangeModes ?? EMPTY_MODES;

  useEffect(() => {
    if (modes.length > 0 && !modes.includes(mode)) {
      onModeChange(modes[0] ?? "git");
    }
  }, [mode, modes, onModeChange]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {modes.length === 0 ? null : (
        <div
          className="flex shrink-0 gap-1 border-b border-border px-3 py-2"
          role="tablist"
          aria-label="Change comparison"
        >
          {modes.map((candidate) => (
            <button
              key={candidate}
              type="button"
              role="tab"
              aria-selected={candidate === mode}
              onClick={() => onModeChange(candidate)}
              className={cn(
                "h-7 rounded-md px-2 text-body-sm font-medium",
                "transition-[background-color,color] duration-150 ease-fluid",
                candidate === mode
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
              )}
            >
              {MODE_LABELS[candidate]}
            </button>
          ))}
        </div>
      )}

      {loading ? (
        <p className="px-4 py-6 text-body text-muted-foreground" role="status">
          Reading changes…
        </p>
      ) : modes.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
          <FileCode2 size={20} className="text-subtle-foreground" aria-hidden="true" />
          <p className="text-body font-medium text-foreground">No change source available</p>
          <p className="max-w-[32ch] text-body-sm text-muted-foreground">
            Start a turn, or open a workspace backed by Git.
          </p>
        </div>
      ) : changes === null ? (
        <p className="px-4 py-6 text-body text-muted-foreground">
          This comparison is not available.
        </p>
      ) : (
        <>
          <div className="flex shrink-0 items-center justify-between gap-3 border-b border-border px-3 py-2">
            <div className="min-w-0">
              <p className="truncate text-body-sm text-muted-foreground" title={changes.comparison}>
                {changes.comparison}
              </p>
              <p className="font-mono text-label text-subtle-foreground">
                {files.length} {files.length === 1 ? "file" : "files"}
                {changes.omittedFiles > 0 ? ` · ${changes.omittedFiles} omitted` : ""}
              </p>
            </div>
            {changes.complete ? null : <StatusChip tone="warning">Partial</StatusChip>}
          </div>

          {files.length === 0 ? (
            <p className="px-4 py-6 text-body text-muted-foreground">
              No changes in this comparison.
            </p>
          ) : (
            <div className="grid min-h-0 flex-1 grid-rows-[minmax(104px,32%)_minmax(0,1fr)]">
              <ul className="min-h-0 overflow-y-auto border-b border-border p-1.5">
                {files.map((file) => (
                  <li key={file.path}>
                    <button
                      type="button"
                      onClick={() => setSelectedPath(file.path)}
                      aria-current={file.path === selectedPath ? "true" : undefined}
                      className={cn(
                        "flex h-8 w-full items-center gap-2 rounded-md px-2 text-left",
                        "transition-[background-color,color] duration-150 ease-fluid",
                        file.path === selectedPath
                          ? "bg-accent text-foreground"
                          : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
                      )}
                    >
                      <span
                        className={cn("w-3 shrink-0 font-mono text-label font-semibold", fileTone(file.status))}
                        title={STATUS_LABELS[file.status]}
                      >
                        {STATUS_MARKS[file.status]}
                        <span className="sr-only">{STATUS_LABELS[file.status]}</span>
                      </span>
                      <span className="min-w-0 flex-1 truncate font-mono text-body-sm">
                        {file.path}
                      </span>
                      <span className="shrink-0 font-mono text-label" aria-label={`${file.additions} additions, ${file.deletions} deletions`}>
                        <span className="text-success">+{file.additions}</span>{" "}
                        <span className="text-destructive">−{file.deletions}</span>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
              <div className="min-h-0 overflow-auto">
                {selected === null ? null : (
                  <>
                    <div className="sticky top-0 z-10 flex min-h-9 items-center justify-between gap-3 border-b border-border bg-card px-3 py-2">
                      <span className="min-w-0 truncate font-mono text-body-sm text-foreground">
                        {selected.path}
                      </span>
                      <span className="shrink-0 font-mono text-label text-subtle-foreground">
                        {formatCount(selected.additions + selected.deletions)} lines
                      </span>
                    </div>
                    <DiffBody file={selected} />
                  </>
                )}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-border py-2 last:border-b-0">
      <dt className="text-body-sm text-muted-foreground">{label}</dt>
      <dd className="font-mono text-body-sm text-foreground">{value}</dd>
    </div>
  );
}

function ToolsChrome({ tools }: { tools: ToolProjection[] }) {
  if (tools.length === 0) {
    return null;
  }
  const mcp = tools.filter((tool) => tool.kind === "mcp");
  const skills = tools.filter((tool) => tool.kind === "skill");
  return (
    <section className="border-b border-border py-4">
      <h3 className="text-body font-semibold text-foreground">Tools and skills</h3>
      <p className="mt-1 text-body-sm text-muted-foreground">
        Names only, as configured for this workspace. Enable or disable them in
        the Grok Build CLI — Light never rewrites configuration.
      </p>
      {mcp.length === 0 ? null : (
        <ul className="mt-3 m-0 list-none space-y-1 p-0" aria-label="MCP servers">
          {mcp.map((tool) => (
            <li
              key={`mcp-${tool.scope}-${tool.name}`}
              className="flex min-h-6 items-center justify-between gap-2 text-body-sm"
            >
              <span className="min-w-0 truncate text-foreground">{tool.name}</span>
              <span className="shrink-0 font-mono text-label text-subtle-foreground">
                {tool.scope}
                {tool.enabled ? "" : " · off"}
              </span>
            </li>
          ))}
        </ul>
      )}
      {skills.length === 0 ? null : (
        <ul className="mt-3 m-0 list-none space-y-1 p-0" aria-label="Skills">
          {skills.map((tool) => (
            <li
              key={`skill-${tool.scope}-${tool.name}`}
              className="flex min-h-6 items-center justify-between gap-2 text-body-sm"
            >
              <span className="min-w-0 truncate text-foreground">{tool.name}</span>
              <span className="shrink-0 font-mono text-label text-subtle-foreground">
                skill · {tool.scope}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function ContextTab({
  inspector,
  loading,
  configTools = [],
}: {
  inspector: SessionInspectorProjection | null;
  loading: boolean;
  configTools?: ToolProjection[];
}) {
  if (loading) {
    return (
      <p className="px-4 py-6 text-body text-muted-foreground" role="status">
        Reading context…
      </p>
    );
  }
  if (inspector === null) {
    return (
      <p className="px-4 py-6 text-body text-muted-foreground">
        Context information is not available from this CLI.
      </p>
    );
  }

  const context = inspector.context;
  const usage = inspector.usage;
  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
      <ToolsChrome tools={configTools} />
      <section className="border-b border-border pb-4">
        <p className="text-label font-semibold uppercase tracking-[0.06em] text-subtle-foreground">
          Session
        </p>
        <p className="mt-2 text-title-sm font-semibold text-foreground">
          {inspector.modelDisplayName ?? inspector.model ?? "Current session"}
        </p>
        <p className="mt-0.5 font-mono text-label text-subtle-foreground">
          {inspector.agentName ?? "Agent"}
          {inspector.turns > 0 ? ` · turn ${inspector.turnIndex + 1}` : ""}
        </p>
        {inspector.currentBranch === undefined ? null : (
          <p className="mt-2 truncate font-mono text-body-sm text-muted-foreground">
            {inspector.currentBranch}
            {inspector.defaultBranch === undefined
              ? ""
              : ` → ${inspector.defaultBranch}`}
          </p>
        )}
      </section>

      {context === undefined ? null : (
        <section className="border-b border-border py-4">
          <div className="flex items-baseline justify-between gap-3">
            <h3 className="text-body font-semibold text-foreground">Context window</h3>
            <span className="font-mono text-body-sm text-muted-foreground">
              {context.usagePercent}%
            </span>
          </div>
          <div
            className="mt-2 grid h-1.5 grid-cols-10 gap-px overflow-hidden rounded-full"
            role="img"
            aria-label={`${context.usagePercent}% of context used`}
          >
            {Array.from({ length: 10 }, (_, index) => (
              <span
                key={index}
                className={
                  index < Math.ceil(context.usagePercent / 10) ? "bg-info" : "bg-secondary"
                }
                aria-hidden="true"
              />
            ))}
          </div>
          <p className="mt-2 font-mono text-label text-subtle-foreground">
            {formatCount(context.used)} used · {formatCount(context.free)} free ·{" "}
            {formatCount(context.total)} total
          </p>
          <dl className="mt-3">
            <Metric label="Turns" value={formatCount(context.turnCount)} />
            <Metric label="Messages" value={formatCount(context.messageCount)} />
            <Metric label="Tool calls" value={formatCount(context.toolCallCount)} />
            <Metric label="Compactions" value={formatCount(context.compactionCount)} />
            <Metric
              label="Auto-compact"
              value={`${context.autoCompactThresholdPercent}%`}
            />
          </dl>
        </section>
      )}

      {context?.categories.length === 0 || context === undefined ? null : (
        <section className="border-b border-border py-4">
          <h3 className="text-body font-semibold text-foreground">In context</h3>
          <dl className="mt-2">
            {context.categories.map((category, index) => (
              <Metric
                key={`${category.label}-${index}`}
                label={category.detail ?? category.label}
                value={formatCount(category.tokens)}
              />
            ))}
          </dl>
        </section>
      )}

      <section className="pt-4">
        <div className="flex items-center justify-between gap-3">
          <h3 className="text-body font-semibold text-foreground">Usage</h3>
          {usage?.incomplete === true ? <StatusChip tone="warning">Partial</StatusChip> : null}
        </div>
        <dl className="mt-2">
          <Metric
            label="Input tokens"
            value={usage === undefined ? "—" : formatCount(usage.inputTokens)}
          />
          <Metric
            label="Output tokens"
            value={usage === undefined ? "—" : formatCount(usage.outputTokens)}
          />
          <Metric
            label="Cached reads"
            value={usage === undefined ? "—" : formatCount(usage.cachedReadTokens)}
          />
          <Metric
            label="Reasoning"
            value={usage === undefined ? "—" : formatCount(usage.reasoningTokens)}
          />
          <Metric
            label="Model calls"
            value={usage === undefined ? "—" : formatCount(usage.modelCalls)}
          />
          <Metric
            label="API time"
            value={usage === undefined ? "—" : formatDuration(usage.apiDurationMs)}
          />
          <Metric
            label="Cost"
            value={
              usage?.costUsd === undefined
                ? "—"
                : new Intl.NumberFormat(undefined, {
                    style: "currency",
                    currency: "USD",
                    minimumFractionDigits: 2,
                    maximumFractionDigits: 4,
                  }).format(usage.costUsd)
            }
          />
        </dl>
      </section>
    </div>
  );
}

export function SessionReviewPanel({
  inspector,
  changes,
  inspectorLoading,
  changesLoading,
  mode,
  onModeChange,
  onClose,
  configTools = [],
}: {
  inspector: SessionInspectorProjection | null;
  changes: SessionChangesProjection | null;
  inspectorLoading: boolean;
  changesLoading: boolean;
  mode: ChangeMode;
  onModeChange: (mode: ChangeMode) => void;
  onClose: () => void;
  /** Read-only MCP/skill names for this workspace. Never enable/disable. */
  configTools?: ToolProjection[];
}) {
  const [tab, setTab] = useState<InspectorTab>("changes");

  return (
    <aside
      className={cn(
        "z-20 flex w-[400px] shrink-0 flex-col border-l border-sidebar-border bg-card",
        "max-[1180px]:absolute max-[1180px]:inset-y-0 max-[1180px]:right-0",
        "max-[1180px]:w-[min(400px,100%)] max-[1180px]:shadow-dialog",
        "max-[680px]:fixed",
      )}
      aria-label="Session review"
    >
      <div className="flex h-11 shrink-0 items-center justify-between gap-2 border-b border-border px-2">
        <div className="flex gap-1" role="tablist" aria-label="Session review sections">
          {(["changes", "context"] as const).map((candidate) => (
            <button
              key={candidate}
              type="button"
              role="tab"
              aria-selected={tab === candidate}
              onClick={() => setTab(candidate)}
              className={cn(
                "h-7 rounded-md px-2.5 text-body-sm font-semibold",
                "transition-[background-color,color] duration-150 ease-fluid",
                tab === candidate
                  ? "bg-accent text-foreground"
                  : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
              )}
            >
              {candidate === "changes" ? "Changes" : "Context"}
            </button>
          ))}
        </div>
        <IconButton size="sm" onClick={onClose} aria-label="Close review panel">
          <X size={14} aria-hidden="true" />
        </IconButton>
      </div>

      {tab === "changes" ? (
        <ChangesTab
          inspector={inspector}
          changes={changes}
          loading={inspectorLoading || changesLoading}
          mode={mode}
          onModeChange={onModeChange}
        />
      ) : (
        <ContextTab
          inspector={inspector}
          loading={inspectorLoading}
          configTools={configTools}
        />
      )}
    </aside>
  );
}
