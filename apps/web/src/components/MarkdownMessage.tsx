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
      className="text-info underline decoration-info/40 underline-offset-2 hover:decoration-info"
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
        "min-w-0 break-words text-body-lg leading-[22px] text-foreground",
        "[&_blockquote]:my-3 [&_blockquote]:border-l-2 [&_blockquote]:border-input [&_blockquote]:pl-3 [&_blockquote]:text-muted-foreground",
        "[&_h1]:mb-2 [&_h1]:mt-5 [&_h1]:text-title [&_h1]:font-semibold",
        "[&_h2]:mb-2 [&_h2]:mt-5 [&_h2]:text-title-sm [&_h2]:font-semibold",
        "[&_h3]:mb-1.5 [&_h3]:mt-4 [&_h3]:text-body-lg [&_h3]:font-semibold",
        "[&_li]:my-1 [&_ol]:my-3 [&_ol]:list-decimal [&_ol]:pl-6 [&_p]:my-2 [&_ul]:my-3 [&_ul]:list-disc [&_ul]:pl-6",
        "[&_pre]:my-3 [&_pre]:max-w-full [&_pre]:overflow-x-auto [&_pre]:rounded-lg [&_pre]:border [&_pre]:border-border [&_pre]:bg-muted [&_pre]:p-3",
        "[&_pre_code]:bg-transparent [&_pre_code]:p-0 [&_code]:rounded-sm [&_code]:bg-muted [&_code]:px-1 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-body-sm",
        "[&_table]:my-3 [&_table]:block [&_table]:max-w-full [&_table]:overflow-x-auto [&_table]:border-collapse",
        "[&_td]:border [&_td]:border-border [&_td]:px-2 [&_td]:py-1.5 [&_th]:border [&_th]:border-border [&_th]:bg-muted [&_th]:px-2 [&_th]:py-1.5 [&_th]:text-left [&_th]:font-semibold",
        "[&>:first-child]:mt-0 [&>:last-child]:mb-0",
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
