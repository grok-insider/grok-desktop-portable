/**
 * Browser-picked files inlined into the prompt as text.
 *
 * The protocol only carries prompt text (ACP `session/prompt` text blocks).
 * Paths from the browser are never sent (light ADR 0013). Content is what the
 * agent can act on: text files as fenced blocks, small binaries as base64.
 */

/** Soft cap per file so a multi-MB pick cannot blow the draft or the wire. */
export const MAX_ATTACH_BYTES = 200_000;

/** Aggregate soft cap for one attach action. */
export const MAX_ATTACH_TOTAL_BYTES = 600_000;

const TEXTISH =
  /^(text\/|application\/(json|xml|javascript|x-javascript|typescript|yaml|x-yaml|toml|sql|graphql|ld\+json)|image\/svg\+xml)/i;

/** Whether a File is safe to read as UTF-8 text for the draft. */
export function isTextishFile(file: File): boolean {
  if (file.type && TEXTISH.test(file.type)) {
    return true;
  }
  // Empty MIME is common for local picks; fall back to extension.
  return /\.(txt|md|markdown|json|jsonc|ya?ml|toml|xml|html?|css|scss|less|js|jsx|ts|tsx|mjs|cjs|py|rs|go|java|kt|c|cc|cpp|h|hpp|cs|rb|php|sh|bash|zsh|fish|ps1|sql|graphql|gql|env|ini|cfg|conf|log|csv|tsv|svg|lock|dockerfile|makefile|cmake|r|lua|vim|el|clj|ex|exs|erl|hs|ml|mli|swift|dart|proto|tf|hcl)$/i.test(
    file.name,
  );
}

/**
 * Format one file for insertion into the draft.
 *
 * Returns null when the file is over the per-file cap (caller should skip).
 */
export async function formatAttachment(file: File): Promise<string | null> {
  if (file.size > MAX_ATTACH_BYTES) {
    return null;
  }
  const safeName = file.name.replace(/[\r\n`]/g, "_") || "file";
  if (isTextishFile(file)) {
    const text = await file.text();
    // Fence the body; triple-backticks inside content are rare enough and the
    // agent still sees the filename header.
    return `Attached: \`${safeName}\`\n\`\`\`\n${text.replace(/\r\n/g, "\n")}\n\`\`\`\n`;
  }
  const buffer = await file.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  const b64 = btoa(binary);
  const mime = file.type || "application/octet-stream";
  return `Attached: \`${safeName}\` (${mime}, base64)\n\`\`\`\n${b64}\n\`\`\`\n`;
}

/**
 * Read a FileList into draft snippets, respecting size caps.
 * Oversized files are skipped rather than truncating silently mid-body.
 */
export async function formatAttachments(files: Iterable<File>): Promise<{
  text: string;
  attached: number;
  skipped: number;
}> {
  let total = 0;
  let attached = 0;
  let skipped = 0;
  const parts: string[] = [];
  for (const file of files) {
    if (file.size > MAX_ATTACH_BYTES || total + file.size > MAX_ATTACH_TOTAL_BYTES) {
      skipped += 1;
      continue;
    }
    const snippet = await formatAttachment(file);
    if (snippet === null) {
      skipped += 1;
      continue;
    }
    parts.push(snippet);
    total += file.size;
    attached += 1;
  }
  return { text: parts.join("\n"), attached, skipped };
}
