import { act, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ApplicationLayout } from "./ApplicationLayout";

vi.mock("./PwaActions", () => ({PwaActions: () => null}));
afterEach(() => vi.unstubAllGlobals());

it("fits the visible viewport immediately and retains its contents across keyboard changes", () => {
  const viewport = Object.assign(new EventTarget(), {height: 749.866, scale: 1});
  vi.stubGlobal("visualViewport", viewport);
  vi.stubGlobal("innerHeight", 750);
  const {unmount} = render(<ApplicationLayout><textarea defaultValue="Keep this draft" /></ApplicationLayout>);
  const height = () => document.documentElement.style.getPropertyValue("--app-viewport-height");
  expect(height()).toBe("749.866px");
  act(() => {
    viewport.height = 491.2;
    vi.stubGlobal("innerHeight", 491);
    viewport.dispatchEvent(new Event("resize"));
  });
  expect(height()).toBe("491px");
  expect(screen.getByRole("textbox")).toHaveValue("Keep this draft");
  act(() => {
    viewport.height = 749.866;
    vi.stubGlobal("innerHeight", 750);
    window.dispatchEvent(new Event("resize"));
  });
  expect(height()).toBe("749.866px");
  expect(screen.getByRole("textbox")).toHaveValue("Keep this draft");
  unmount();
  viewport.dispatchEvent(new Event("resize"));
  expect(height()).toBe("");
});

it("keeps the layout viewport during pinch zoom and refreshes after restoring the page", () => {
  const viewport = Object.assign(new EventTarget(), {height: 375, scale: 2});
  vi.stubGlobal("visualViewport", viewport);
  vi.stubGlobal("innerHeight", 750);
  render(<ApplicationLayout>Conversation</ApplicationLayout>);
  expect(document.documentElement.style.getPropertyValue("--app-viewport-height")).toBe("750px");
  act(() => {
    viewport.scale = 1;
    viewport.height = 640;
    vi.stubGlobal("innerHeight", 640);
    window.dispatchEvent(new Event("pageshow"));
  });
  expect(document.documentElement.style.getPropertyValue("--app-viewport-height")).toBe("640px");
});

it("uses window height when VisualViewport is unavailable", () => {
  vi.stubGlobal("visualViewport", undefined);
  vi.stubGlobal("innerHeight", 750);
  render(<ApplicationLayout>Conversation</ApplicationLayout>);
  expect(document.documentElement.style.getPropertyValue("--app-viewport-height")).toBe("750px");
});
