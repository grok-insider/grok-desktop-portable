import { describe, expect, it } from "vitest";
import { cspViolations } from "./csp-policy";

describe("production CSP module policy", () => {
  it("rejects modules that insert style elements or pull in forbidden widgets", () => {
    expect(cspViolations([{id: "/x/node_modules/.pnpm/cmdk@1.1.1/node_modules/cmdk/dist/index.mjs", code: ""}])).toHaveLength(1);
    expect(cspViolations([{id: "/x/node_modules/@fabrials/ui/dist/chart.js", code: ""}])).toHaveLength(1);
    expect(cspViolations([{id: "/x/node_modules/@fabrials/ai-ui/dist/provider-icon-data.js", code: ""}])).toHaveLength(1);
    expect(cspViolations([{id: "/x/src/a.tsx", code: "const tag = document.createElement('style');"}])).toHaveLength(1);
    expect(cspViolations([{id: "/x/src/b.tsx", code: "sheet.insertRule(rule)"}])).toHaveLength(1);
    expect(cspViolations([{id: "/x/src/c.tsx", code: "node.setAttribute(\"style\", value)"}])).toHaveLength(1);
  });

  it("accepts ordinary modules and explicit allowances", () => {
    expect(cspViolations([{id: "/x/node_modules/@fabrials/ui/dist/dialog.js", code: "element.style.setProperty('--x', '1')"}])).toEqual([]);
    expect(cspViolations([{id: "/x/vendor/known.js", code: "document.createElement(\"style\")"}], [/known\.js$/])).toEqual([]);
  });
});
