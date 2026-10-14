import { act, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ApplicationLayout } from "./ApplicationLayout";

vi.mock("./PwaActions", () => ({PwaActions: () => null}));
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

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

it("marks a short visual viewport during landscape typing and clears it after keyboard dismissal", () => {
  const viewport = Object.assign(new EventTarget(), {height: 354, scale: 1});
  vi.stubGlobal("visualViewport", viewport);
  vi.stubGlobal("innerHeight", 354);
  const {unmount} = render(<ApplicationLayout><textarea defaultValue="Unsent landscape draft" /></ApplicationLayout>);
  expect(document.documentElement).not.toHaveAttribute("data-short-viewport");
  act(() => {
    viewport.height = 136;
    viewport.dispatchEvent(new Event("resize"));
  });
  expect(document.documentElement).toHaveAttribute("data-short-viewport");
  expect(document.documentElement.style.getPropertyValue("--app-viewport-height")).toBe("136px");
  expect(screen.getByRole("textbox")).toHaveValue("Unsent landscape draft");
  act(() => {
    viewport.height = 354;
    viewport.dispatchEvent(new Event("resize"));
  });
  expect(document.documentElement).not.toHaveAttribute("data-short-viewport");
  act(() => {
    viewport.height = 136;
    viewport.dispatchEvent(new Event("resize"));
  });
  unmount();
  expect(document.documentElement).not.toHaveAttribute("data-short-viewport");
});

it("reveals only the focused composer in a short viewport without changing its draft or selection", () => {
  vi.useFakeTimers();
  const viewport = Object.assign(new EventTarget(), {height: 354, scale: 1});
  vi.stubGlobal("visualViewport", viewport);
  vi.stubGlobal("innerHeight", 354);
  const scroll = vi.spyOn(Element.prototype, "scrollIntoView").mockImplementation(() => {});
  const {unmount} = render(<ApplicationLayout>
    <button>Read conversation</button>
    <div data-composer-chrome="card" role="group" aria-label="Active composer">
      <textarea defaultValue="Keep this selected draft" />
    </div>
    <div data-composer-chrome="card" role="group" aria-label="Inactive composer" />
  </ApplicationLayout>);
  const input = screen.getByRole("textbox") as HTMLTextAreaElement;
  const draftAndSelection = () => [input.value, input.selectionStart, input.selectionEnd, input.selectionDirection];
  act(() => {
    input.focus();
    input.setSelectionRange(5, 18, "backward");
    vi.advanceTimersToNextFrame();
  });
  const retained = draftAndSelection();
  expect(scroll).not.toHaveBeenCalled();

  act(() => {
    viewport.height = 136;
    viewport.dispatchEvent(new Event("resize"));
    vi.advanceTimersToNextFrame();
  });
  expect(scroll).toHaveBeenCalledExactlyOnceWith({block: "nearest", inline: "nearest"});
  expect(scroll.mock.contexts[0]).toBe(screen.getByRole("group", {name: "Active composer"}));
  expect(draftAndSelection()).toEqual(retained);
  expect(document.activeElement).toBe(input);
  scroll.mockClear();

  act(() => {
    viewport.height = 354;
    viewport.dispatchEvent(new Event("resize"));
    vi.advanceTimersToNextFrame();
  });
  expect(scroll).not.toHaveBeenCalled();
  expect(document.documentElement).not.toHaveAttribute("data-short-viewport");
  expect(draftAndSelection()).toEqual(retained);

  const reading = screen.getByRole("button", {name: "Read conversation"});
  act(() => {
    reading.focus();
    viewport.height = 136;
    viewport.dispatchEvent(new Event("resize"));
    vi.advanceTimersToNextFrame();
  });
  expect(document.documentElement).toHaveAttribute("data-short-viewport");
  expect(scroll).not.toHaveBeenCalled();
  expect(document.activeElement).toBe(reading);
  expect(draftAndSelection()).toEqual(retained);

  act(() => {
    input.focus();
    vi.advanceTimersToNextFrame();
  });
  expect(scroll).toHaveBeenCalledTimes(1);
  expect(scroll.mock.contexts[0]).toBe(screen.getByRole("group", {name: "Active composer"}));
  expect(draftAndSelection()).toEqual(retained);
  scroll.mockClear();

  act(() => {
    viewport.dispatchEvent(new Event("resize"));
  });
  unmount();
  act(() => {
    viewport.dispatchEvent(new Event("resize"));
    window.dispatchEvent(new Event("resize"));
    window.dispatchEvent(new Event("pageshow"));
    document.dispatchEvent(new FocusEvent("focusin"));
    vi.advanceTimersToNextFrame();
  });
  expect(scroll).not.toHaveBeenCalled();
  expect(document.documentElement).not.toHaveAttribute("data-short-viewport");
  expect(document.documentElement.style.getPropertyValue("--app-viewport-height")).toBe("");
});

it("does not treat a pinch-zoomed visual viewport as a keyboard or reveal the composer", () => {
  vi.useFakeTimers();
  const viewport = Object.assign(new EventTarget(), {height: 136, scale: 2});
  vi.stubGlobal("visualViewport", viewport);
  vi.stubGlobal("innerHeight", 354);
  const scroll = vi.spyOn(Element.prototype, "scrollIntoView").mockImplementation(() => {});
  render(<ApplicationLayout>
    <div data-composer-chrome="card"><textarea defaultValue="Zoomed draft" /></div>
  </ApplicationLayout>);
  const input = screen.getByRole("textbox") as HTMLTextAreaElement;
  act(() => {
    input.focus();
    input.setSelectionRange(0, 6);
    vi.advanceTimersToNextFrame();
  });
  expect(document.documentElement.style.getPropertyValue("--app-viewport-height")).toBe("354px");
  expect(document.documentElement).not.toHaveAttribute("data-short-viewport");
  expect(scroll).not.toHaveBeenCalled();

  act(() => {
    viewport.scale = 1;
    viewport.dispatchEvent(new Event("resize"));
    vi.advanceTimersToNextFrame();
  });
  expect(document.documentElement).toHaveAttribute("data-short-viewport");
  expect(scroll).toHaveBeenCalledExactlyOnceWith({block: "nearest", inline: "nearest"});
  scroll.mockClear();

  act(() => {
    viewport.scale = 2;
    viewport.dispatchEvent(new Event("resize"));
    vi.advanceTimersToNextFrame();
  });
  expect(document.documentElement).not.toHaveAttribute("data-short-viewport");
  expect(scroll).not.toHaveBeenCalled();
  expect(input).toHaveValue("Zoomed draft");
  expect([input.selectionStart, input.selectionEnd]).toEqual([0, 6]);
});
