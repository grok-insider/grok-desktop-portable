/**
 * Safe markdown body for agent turns.
 *
 * Adapted from Desktop's MarkdownMessage: same allowlist, GFM, no raw HTML.
 * Light runs in a normal browser, so https links open in a new tab rather than
 * through Electron's openExternal.
 *
 * Model output is untrusted. Never widen the allowlist without a threat review.
 */

import type { ReactNode } from "react";
import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import { cn } from "./ui";

const ALLOWED_ELEMENTS = [
  "a",
  "blockquote",
  "br",
  "code",
  "del",
  "em",
  "h1",
  "h2",
  "h3",
  "h4",
  "hr",
  "li",
  "ol",
  "p",
  "pre",
  "strong",
  "table",
  "tbody",
  "td",
  "th",
  "thead",
  "tr",
  "ul",
];

function MarkdownLink({ href, children }: { href?: string; children?: ReactNode }) {
  if (href === undefined || href.length === 0) {
    return <span>{children}</span>;
  }
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer noopener"
    >
      {children}
    </a>
  );
}

export function MarkdownMessage({
  children,
  streaming = false,
  className,
}: {
  children: string;
  streaming?: boolean;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "fui-markdown min-w-0 break-words text-foreground",
        className,
      )}
    >
      <ReactMarkdown
        allowedElements={ALLOWED_ELEMENTS}
        components={{ a: MarkdownLink }}
        remarkPlugins={[remarkGfm]}
        skipHtml
        urlTransform={(url) => (url.startsWith("https://") ? defaultUrlTransform(url) : "")}
      >
        {children}
      </ReactMarkdown>
      {streaming ? (
        <span
          data-testid="streaming-caret"
          aria-hidden="true"
          className="ml-1 inline-block h-3.5 w-0.5 animate-pulse bg-info align-[-1px] motion-reduce:animate-none"
        />
      ) : null}
    </div>
  );
}
