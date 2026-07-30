import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { IntegrationList } from "./IntegrationList";
import type { Integration } from "../services/outcomes";

const servers: Integration[] = [
  { name: "exa", enabled: true, transport: "remote" },
  { name: "wisp", enabled: true, transport: "local" },
  { name: "coolify", enabled: false, transport: "remote" },
];

describe("IntegrationList", () => {
  it("shows nothing when nothing is configured", () => {
    const { container } = render(<IntegrationList integrations={[]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("names every configured integration", () => {
    render(<IntegrationList integrations={servers} />);
    for (const name of ["exa", "wisp", "coolify"]) {
      expect(screen.getByText(name)).toBeInTheDocument();
    }
  });

  it("counts how many are actually on", () => {
    render(<IntegrationList integrations={servers} />);
    expect(screen.getByText(/2\/3/)).toBeInTheDocument();
  });

  it("shows a switched-off server rather than hiding it", () => {
    // Hiding it is indistinguishable from never having configured it, and the
    // user would wonder why a tool they set up is absent.
    render(<IntegrationList integrations={servers} />);
    expect(screen.getByText("off")).toBeInTheDocument();
  });

  it("says the agent uses them with the user's own authority", () => {
    render(<IntegrationList integrations={servers} />);
    expect(screen.getByText(/your own authority/i)).toBeInTheDocument();
  });

  it("never renders an address, command, or credential", () => {
    // The host must not send these. Asserted on what a person can read and on
    // the tooltips, not on raw markup, whose icon namespaces are noise.
    const { container } = render(<IntegrationList integrations={servers} />);
    const readable = [
      container.textContent ?? "",
      ...[...container.querySelectorAll("[title]")].map((node) => node.getAttribute("title") ?? ""),
    ].join(" ");
    for (const leak of ["://", "Bearer", "npx", "/home/", "apiKey", "8000"]) {
      expect(readable).not.toContain(leak);
    }
  });
});
