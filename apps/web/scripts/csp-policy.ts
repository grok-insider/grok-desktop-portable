const forbiddenModules = [
  /\/node_modules\/(cmdk|react-remove-scroll[^/]*|react-style-singleton|use-sidecar|@radix-ui\/[^/]+|motion|motion-dom|framer-motion|recharts|victory-vendor|embla-carousel[^/]*)\//,
  /\/@fabrials\/ui\/dist\/(command|command-parts|chart|carousel|number-ticker)\.js$/,
  /\/@fabrials\/ai-ui\/dist\/provider-icon[^/]*\.js$/,
  /\/@base-ui\/react\/.*prehydration/i,
];

const styleInjection = [
  /createElement\(\s*["'`]style["'`]\s*\)/,
  /\.insertRule\(/,
  /adoptedStyleSheets/,
  /setAttribute\(\s*["'`]style["'`]/,
  /\.cssText\s*=/,
];

export type RenderedModule = { id: string; code: string | null };

function normalized(id: string): string {
  return id.replaceAll("\\", "/").replace(/\?.*$/, "");
}

export function cspViolations(modules: RenderedModule[], allowedInjection: RegExp[] = []): string[] {
  const violations: string[] = [];
  for (const module of modules) {
    const id = normalized(module.id);
    if (forbiddenModules.some(pattern => pattern.test(id))) violations.push(`forbidden module ${id}`);
    if (module.code && !allowedInjection.some(pattern => pattern.test(id))) {
      for (const pattern of styleInjection) if (pattern.test(module.code)) violations.push(`style injection ${pattern.source} in ${id}`);
    }
  }
  return violations;
}
