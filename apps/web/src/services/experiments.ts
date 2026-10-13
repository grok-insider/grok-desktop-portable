export const REMOTE_EXPERIMENTS = ["push", "drafts", "transcript", "dictation", "speech-playback", "share-target", "remote-projects", "control-transfer", "device-panel"] as const;
export type RemoteExperiment = typeof REMOTE_EXPERIMENTS[number];

export function remoteExperimentEnabled(name: RemoteExperiment): boolean {
  return String(import.meta.env.VITE_REMOTE_EXPERIMENTS ?? "").split(",").map((value) => value.trim()).includes(name);
}
