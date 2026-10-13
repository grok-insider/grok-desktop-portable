interface NoiseClient {
  start(): Uint8Array;
  authenticate(frame: Uint8Array, credentials: Uint8Array): Uint8Array;
  encrypt(message: Uint8Array): Uint8Array[];
  decrypt(frame: Uint8Array): Uint8Array | undefined;
  free(): void;
}

export interface NoiseModule {
  default(input: {module_or_path: URL}): Promise<unknown>;
  generate_private_key(): Uint8Array;
  NoiseClient: new (privateKey: Uint8Array, hostKey: Uint8Array, hostId: string, channelId: string) => NoiseClient;
}

declare const __REMOTE_CRYPTO_URL__: string;

export async function loadNoiseModule(): Promise<NoiseModule> {
  try {
    const module = await import(/* @vite-ignore */ __REMOTE_CRYPTO_URL__) as NoiseModule;
    await module.default({module_or_path: new URL(__REMOTE_CRYPTO_URL__.replace(/\.js$/, "_bg.wasm"), window.location.origin)});
    return module;
  } catch {throw new Error("crypto_unavailable");}
}
