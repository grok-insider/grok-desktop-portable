import { describe, expect, it } from "vitest";
import {
  PROTOCOL_VERSION,
  RENDERABLE_OPTIONS,
  WS_SUBPROTOCOL,
  hasSingleUseOption,
  renderableOptions,
} from "./protocol";

describe("permission option projection", () => {
  it("keeps only the three options Light may render", () => {
    const offered = [
      "always-allow",
      "allow-once",
      "allow-edits-session",
      "reject-once",
      "reject-always",
      "allow-always-mcp",
      "allow-always-domain",
      "enable-always-approve",
    ];
    expect(renderableOptions(offered)).toEqual([
      "allow-once",
      "allow-edits-session",
      "reject-once",
    ]);
  });

  it("never renders a persistent grant", () => {
    for (const withheld of [
      "always-allow",
      "reject-always",
      "allow-always-mcp",
      "allow-always-domain",
      "enable-always-approve",
    ]) {
      expect(renderableOptions([withheld, "allow-once", "reject-once"])).not.toContain(
        withheld,
      );
    }
  });

  it("orders options the same way regardless of the agent's order", () => {
    const a = renderableOptions(["reject-once", "allow-once"]);
    const b = renderableOptions(["allow-once", "reject-once"]);
    expect(a).toEqual(b);
    expect(a).toEqual(["allow-once", "reject-once"]);
  });

  it("reports an offer that cannot be answered without a standing grant", () => {
    expect(hasSingleUseOption(["allow-once", "reject-once"])).toBe(true);
    expect(hasSingleUseOption(["always-allow", "reject-always"])).toBe(false);
    expect(hasSingleUseOption(["allow-once"])).toBe(false);
    expect(hasSingleUseOption([])).toBe(false);
  });

  it("pins the wire constants the host also implements", () => {
    expect(PROTOCOL_VERSION).toBe(2);
    expect(WS_SUBPROTOCOL).toBe("light.local.v1");
    expect(RENDERABLE_OPTIONS).toHaveLength(3);
  });
});
