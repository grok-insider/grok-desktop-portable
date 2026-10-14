import { describe, expect, it } from "vitest";
import { cn } from "./ui";

describe("cn", () => {
  it("keeps a custom type size next to a colour instead of treating both as colours", () => {
    expect(cn("h-7 px-2 text-body-sm", "bg-primary text-primary-foreground")).toBe("h-7 px-2 text-body-sm bg-primary text-primary-foreground");
    expect(cn("text-body-sm", "text-title")).toBe("text-title");
  });
});
