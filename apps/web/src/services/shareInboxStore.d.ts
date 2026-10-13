export const SHARE_BODY_BYTES: number;
export const SHARE_TTL_MS: number;
export const SHARE_QUEUE_LIMIT: number;
export interface SharedContent {
  title: string;
  text: string;
  url: string;
  files: {name: string; type: string; data: ArrayBuffer}[];
}
export interface ShareInboxEntry {
  id: string;
  createdAt: number;
  digest: string;
  content: SharedContent;
  state: "pending" | "claimed";
  claimId?: string;
}
export function parseSharedRequest(request: Request): Promise<SharedContent>;
export function enqueueSharedContent(content: SharedContent): Promise<string>;
export function readShareInbox(): Promise<ShareInboxEntry[]>;
export function claimShare(id: string): Promise<string>;
export function recoverShare(id: string, claimId: string): Promise<void>;
export function removeShare(id: string, claimId?: string): Promise<void>;
