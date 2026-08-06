import { beforeEach, describe, expect, it } from "vitest";
import {
  AETHER_VISIBLE_KEY,
  readAetherVisible,
  writeAetherVisible,
} from "./preference";

describe("aether preference", () => {
  beforeEach(() => {
    localStorage.removeItem(AETHER_VISIBLE_KEY);
  });

  it("defaults to visible", () => {
    expect(readAetherVisible()).toBe(true);
  });

  it("persists hide", () => {
    writeAetherVisible(false);
    expect(readAetherVisible()).toBe(false);
    expect(localStorage.getItem(AETHER_VISIBLE_KEY)).toBe("0");
  });

  it("persists show", () => {
    writeAetherVisible(false);
    writeAetherVisible(true);
    expect(readAetherVisible()).toBe(true);
  });
});
