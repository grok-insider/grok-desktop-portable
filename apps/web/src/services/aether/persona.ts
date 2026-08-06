/**
 * Thin browser façade over the Aether wasm-bindgen module.
 *
 * Mirrors `@aether/runtime` (Aether packages/runtime) so Portable can pin
 * built wasm without an npm publish of Aether. Keep behaviour in sync when
 * syncing wasm — see docs/aether-presence.md.
 */

export type WasmModule = {
  WasmSession: new (maxFps: number) => WasmSessionHandle;
  protocolVersion(): number;
};

export type WasmSessionHandle = {
  setSize(width: number, height: number): void;
  loadFixture(): void;
  loadSynthetic(): void;
  loadVrmBytes(data: Uint8Array): void;
  setSpeaking(speaking: boolean): void;
  setLevel(level: number): void;
  setVisemeWeights(
    aa: number,
    ee: number,
    ih: number,
    oh: number,
    ou: number,
  ): void;
  tick(dt: number): void;
  rgbaBytes(): Uint8Array;
  mouthOpen(): number;
  speaking(): boolean;
  modelLoaded(): boolean;
  opaquePixels(): number;
  width(): number;
  height(): number;
  free?(): void;
};

export type PersonaOptions = {
  maxFps?: number;
  width?: number;
  height?: number;
};

/** High-level browser persona bound to a canvas 2D context. */
export class Persona {
  private session: WasmSessionHandle;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private maxFps: number;
  private raf = 0;
  private last = 0;
  private running = false;
  /** When false, skip ticks (tab hidden / user toggle) without disposing. */
  private active = true;

  constructor(
    wasm: WasmModule,
    canvas: HTMLCanvasElement,
    opts: PersonaOptions = {},
  ) {
    this.maxFps = opts.maxFps ?? 30;
    this.session = new wasm.WasmSession(this.maxFps);
    const w = opts.width ?? (canvas.width || 256);
    const h = opts.height ?? (canvas.height || 256);
    canvas.width = w;
    canvas.height = h;
    this.session.setSize(w, h);
    this.canvas = canvas;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      throw new Error("2d context unavailable");
    }
    this.ctx = ctx;
  }

  loadFixture(): void {
    this.session.loadFixture();
  }

  loadSynthetic(): void {
    this.session.loadSynthetic();
  }

  loadVrmBytes(data: ArrayBuffer | Uint8Array): void {
    const u8 = data instanceof Uint8Array ? data : new Uint8Array(data);
    this.session.loadVrmBytes(u8);
  }

  setSpeaking(speaking: boolean): void {
    this.session.setSpeaking(speaking);
  }

  setLevel(level: number): void {
    this.session.setLevel(level);
  }

  get mouthOpen(): number {
    return this.session.mouthOpen();
  }

  get speaking(): boolean {
    return this.session.speaking();
  }

  get modelLoaded(): boolean {
    return this.session.modelLoaded();
  }

  setActive(active: boolean): void {
    this.active = active;
  }

  tick(dt: number): void {
    this.session.tick(dt);
    this.blit();
  }

  private blit(): void {
    const w = this.session.width();
    const h = this.session.height();
    const rgba = this.session.rgbaBytes();
    // Copy into a fresh buffer: wasm memory may be a detached SharedArrayBuffer view.
    const copy = new Uint8ClampedArray(rgba.length);
    copy.set(rgba);
    const img = new ImageData(copy, w, h);
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.ctx.putImageData(img, 0, 0);
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.last = performance.now();
    const minFrame = 1 / Math.max(1, this.maxFps);
    let accum = 0;
    const loop = (now: number) => {
      if (!this.running) return;
      const raw = Math.min(0.05, (now - this.last) / 1000);
      this.last = now;
      if (this.active && !document.hidden) {
        accum += raw;
        if (accum >= minFrame) {
          this.tick(accum);
          accum = 0;
        }
      }
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  stop(): void {
    this.running = false;
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  dispose(): void {
    this.stop();
    this.session.free?.();
  }
}

export function createPersona(
  wasm: WasmModule,
  canvas: HTMLCanvasElement,
  opts?: PersonaOptions,
): Persona {
  return new Persona(wasm, canvas, opts);
}
