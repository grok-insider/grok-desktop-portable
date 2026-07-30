/**
 * The MCP servers the agent can reach, from the user's own configuration.
 *
 * Light runs the user's Grok Build with the user's configuration (light ADR
 * 0004), so these are already active — this only makes them visible. It is
 * honest context for a surface that runs with the user's full authority: an
 * integration can reach the network and act on their behalf, and until now
 * nothing in Light said which ones existed.
 *
 * The host projects a name, whether it is on, and how it is reached. Never an
 * address, a command, or a header: that file holds bearer tokens and API keys.
 */

import { Plug, Server, Wifi } from "lucide-react";
import { SectionLabel, cn } from "../components/ui";
import type { Integration } from "../services/outcomes";

export function IntegrationList({ integrations }: { integrations: Integration[] }) {
  if (integrations.length === 0) {
    return null;
  }
  const active = integrations.filter((entry) => entry.enabled);

  return (
    <section className="flex flex-col gap-1.5">
      <SectionLabel>
        Integrations ({active.length}/{integrations.length})
      </SectionLabel>
      <ul className="flex flex-wrap gap-1.5">
        {integrations.map((entry) => {
          const Icon = entry.transport === "remote" ? Wifi : Server;
          return (
            <li key={entry.name}>
              <span
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-label",
                  entry.enabled
                    ? "border-border bg-card text-muted-foreground"
                    : "border-dashed border-border text-subtle-foreground",
                )}
                title={
                  entry.enabled
                    ? `${entry.name} — reached ${entry.transport === "remote" ? "over the network" : "as a local process"}`
                    : `${entry.name} — configured but switched off`
                }
              >
                <Icon size={11} aria-hidden="true" />
                {entry.name}
                {entry.enabled ? null : <span className="text-subtle-foreground">off</span>}
              </span>
            </li>
          );
        })}
      </ul>
      <p className="text-label text-subtle-foreground">
        <Plug size={10} className="mr-1 inline align-[-1px]" aria-hidden="true" />
        Configured in your Grok Build. The agent can use these with your own authority.
      </p>
    </section>
  );
}
