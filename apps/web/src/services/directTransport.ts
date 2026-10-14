import type { HostTransport } from "./client";
import { directProfileId, readDirectProfile, type DirectPairing, type DirectProfile } from "./directProfiles";
import { createDirectNoiseTransport } from "./remoteConnector";

export async function createDirectTransport(options: {profile?: DirectProfile; pairing?: DirectPairing; signal?: AbortSignal}): Promise<{transport: HostTransport; profile: DirectProfile}> {
  const identity = options.pairing ?? options.profile;
  if (!identity) throw new Error("pairing_required");
  const transport = await createDirectNoiseTransport({...identity, signal: options.signal});
  try {
    const profile = await readDirectProfile(directProfileId(identity));
    if (!profile) throw new Error("device_storage_unavailable");
    return {transport, profile};
  } catch (error) {transport.dispose?.(); throw error;}
}
