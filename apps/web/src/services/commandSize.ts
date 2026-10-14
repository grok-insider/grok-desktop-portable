import type { CommandEnvelope } from "./protocol";

export const MAX_COMMAND_BYTES = 256 * 1024;
export const COMMAND_ID_PLACEHOLDER = "00000000-0000-4000-8000-000000000000";
const encoder = new TextEncoder();

export function commandWireBytes(envelope: CommandEnvelope, remote: boolean): number {
  return encoder.encode(JSON.stringify(remote ? {id: COMMAND_ID_PLACEHOLDER, method: "command", body: envelope} : envelope)).length;
}

export function commandFits(envelope: CommandEnvelope, remote: boolean): boolean {
  return commandWireBytes(envelope, remote) <= MAX_COMMAND_BYTES;
}
