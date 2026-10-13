export function externalizeSonnerStyles(source: string): string {
  const injector = /function __insertCSS\(code\) \{[\s\S]*?\n\}/;
  if (!injector.test(source)) throw new Error("The Sonner style injector changed; review its CSP integration before building.");
  return source.replace(injector, "function __insertCSS() {}");
}
