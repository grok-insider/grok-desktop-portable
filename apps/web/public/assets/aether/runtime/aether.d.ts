/* tslint:disable */
/* eslint-disable */

/**
 * Browser-facing character session.
 */
export class WasmSession {
    free(): void;
    [Symbol.dispose](): void;
    height(): number;
    /**
     * Load the built-in minimal VRM fixture.
     */
    loadFixture(): void;
    /**
     * Load synthetic domain rig (no glTF).
     */
    loadSynthetic(): void;
    /**
     * Load VRM/GLB bytes from JS `Uint8Array`.
     */
    loadVrmBytes(data: Uint8Array): void;
    modelLoaded(): boolean;
    mouthOpen(): number;
    /**
     * Create a session. Call [`load_fixture`] or [`load_vrm_bytes`] before ticking.
     */
    constructor(max_fps: number);
    opaquePixels(): number;
    /**
     * RGBA8 pixel buffer length `width * height * 4`.
     */
    rgbaBytes(): Uint8Array;
    setLevel(level: number): void;
    setSize(width: number, height: number): void;
    setSpeaking(speaking: boolean): void;
    setVisemeWeights(aa: number, ee: number, ih: number, oh: number, ou: number): void;
    speaking(): boolean;
    /**
     * Advance simulation by `dt` seconds and refresh RGBA buffer.
     */
    tick(dt: number): void;
    width(): number;
}

export function protocolVersion(): number;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_wasmsession_free: (a: number, b: number) => void;
    readonly protocolVersion: () => number;
    readonly wasmsession_height: (a: number) => number;
    readonly wasmsession_loadFixture: (a: number) => [number, number];
    readonly wasmsession_loadSynthetic: (a: number) => [number, number];
    readonly wasmsession_loadVrmBytes: (a: number, b: number, c: number) => [number, number];
    readonly wasmsession_modelLoaded: (a: number) => number;
    readonly wasmsession_mouthOpen: (a: number) => number;
    readonly wasmsession_new: (a: number) => number;
    readonly wasmsession_opaquePixels: (a: number) => number;
    readonly wasmsession_rgbaBytes: (a: number) => [number, number];
    readonly wasmsession_setLevel: (a: number, b: number) => [number, number];
    readonly wasmsession_setSize: (a: number, b: number, c: number) => void;
    readonly wasmsession_setSpeaking: (a: number, b: number) => [number, number];
    readonly wasmsession_setVisemeWeights: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number];
    readonly wasmsession_speaking: (a: number) => number;
    readonly wasmsession_tick: (a: number, b: number) => [number, number];
    readonly wasmsession_width: (a: number) => number;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __externref_table_dealloc: (a: number) => void;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
