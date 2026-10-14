export function controllerEpochAfterStatus(current: number | undefined, state: string): number | undefined {
  if (state === "watching") return undefined;
  const match = /^controlling:(\d+)$/.exec(state);
  return match ? Number(match[1]) : current;
}
