import origins from "./deploymentOrigins.json";

export function deploymentOrigin(value: string = origins.production): string {
  if (value !== origins.production && value !== origins.qualification) throw new Error("Unsupported application origin");
  return value;
}

export const APPLICATION_ORIGIN = deploymentOrigin(import.meta.env.VITE_REMOTE_ORIGIN ?? origins.production);

export function isKnownHostedOrigin(origin: string): boolean {
  return Object.values(origins).includes(origin);
}

export function applicationEntry(origin: string, fragment: string, configured: string = APPLICATION_ORIGIN): "redirect" | "blocked" | "remote" | "local" {
  deploymentOrigin(configured);
  if (origin === origins.legacyAlias && configured === origins.production) return "redirect";
  if (isKnownHostedOrigin(origin) && origin !== configured) return "blocked";
  if ((origin === configured && !fragment.startsWith("#pair=")) || fragment.startsWith("#directPair=")) return "remote";
  return "local";
}
