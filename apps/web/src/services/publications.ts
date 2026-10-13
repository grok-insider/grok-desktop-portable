import type { LightClient } from "./client";
import type { Operation } from "./protocol";

export const PUBLICATION_ACCOUNT = "https://fabrials.com/account/publications";
const PENDING = "grok-publication-authorization-v2";
const token = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value);
export type PublicationCallback = { code: string; nonce: string; profileId: string; expiresAt: number } | { error: string } | null;
export interface Publication { id: string; sessionId: string; phase: string; expiresAt: number; revision: number; error?: string }
export interface PublicationStatus { outcome: "publicationStatus"; authorized: boolean; authorizationExpiresAt?: number; publications: Publication[] }
export type PublicationResult = { outcome: string; [key: string]: unknown };
export class PublicationUncertain extends Error {
  constructor(readonly idempotencyKey: string) { super("The computer has not confirmed this action. Check its status before trying another action."); }
}

function completed(value: unknown, key: string): PublicationResult {
  if (!value || typeof value !== "object") throw new PublicationUncertain(key);
  const receipt = value as { outcome?: string; state?: string; result?: PublicationResult; error?: string };
  if (receipt.outcome !== "publicationCommand") throw new PublicationUncertain(key);
  if (receipt.state === "failed") throw new Error(receipt.error === "publications_not_ready" ? "Public sharing is not available yet." : "The computer rejected the publication action. Check publication status for details.");
  if (receipt.state !== "completed" || !receipt.result?.outcome) throw new PublicationUncertain(key);
  return receipt.result;
}

export async function publicationCommandStatus(client: LightClient, key: string): Promise<PublicationResult> {
  const reply = await client.send({ kind: "getPublicationCommandStatus", idempotencyKey: key });
  if (!reply.ok) throw new PublicationUncertain(key);
  return completed(reply.value, key);
}

export async function publicationCommand(client: LightClient, operation: Operation): Promise<PublicationResult> {
  const key = crypto.randomUUID();
  const reply = await client.send(operation, { idempotencyKey: key }).catch(() => null);
  if (reply?.ok) return completed(reply.value, key);
  return publicationCommandStatus(client, key);
}

export async function publicationStatus(client: LightClient): Promise<PublicationStatus> {
  const reply = await client.send({ kind: "getPublicationStatus" });
  const value = reply.ok ? reply.value as PublicationStatus : null;
  if (value?.outcome !== "publicationStatus" || !Array.isArray(value.publications)) throw new Error("Could not check public links on this computer.");
  return value;
}

export function rememberPublicationAuthorization(result: PublicationResult, profileId: string): string {
  if (result.outcome !== "publicationAuthorization" || typeof result.url !== "string" || !token(result.nonce) || typeof result.expiresAt !== "number" || result.expiresAt <= Date.now() || result.expiresAt > Date.now() + 6 * 60_000 || !profileId) throw new Error("The computer returned an invalid authorization request.");
  const url = new URL(result.url);
  const fields = new URLSearchParams(url.hash.slice(1));
  if (url.origin !== "https://fabrials.com" || url.pathname !== "/account/publications/authorize" || url.search || url.username || url.password || fields.get("publication_nonce") !== result.nonce) throw new Error("The authorization address was rejected.");
  sessionStorage.setItem(PENDING, JSON.stringify({ nonce: result.nonce, profileId, expiresAt: result.expiresAt }));
  return url.href;
}

export function takePublicationCallback(): PublicationCallback {
  if (!/^#publication(?:_|=)/.test(location.hash)) return null;
  const fragment = location.hash;
  history.replaceState(null, "", location.pathname + location.search);
  try {
    const stored = JSON.parse(sessionStorage.getItem(PENDING) ?? "null");
    sessionStorage.removeItem(PENDING);
    const fields = new URLSearchParams(fragment.slice(1));
    if (fields.get("publication") === "cancelled") return { error: "Publication authorization was cancelled. Your private connection is unchanged." };
    const code = fields.get("publication_code");
    const nonce = fields.get("publication_nonce");
    if ([...fields].length !== 2 || !token(code) || !token(nonce) || !stored || nonce !== stored.nonce || typeof stored.profileId !== "string" || !stored.profileId || typeof stored.expiresAt !== "number" || stored.expiresAt <= Date.now()) throw new Error();
    return { code, nonce, profileId: stored.profileId, expiresAt: stored.expiresAt };
  } catch { return { error: "This publication authorization is missing, expired or belongs to another request. Start again from the intended computer." }; }
}
