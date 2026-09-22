/**
 * Loads the vendored binjgb Emscripten build (public/vendor/binjgb).
 *
 * The upstream glue is a classic (non-ESM) script that defines a global
 * `Binjgb` factory, so we inject it with a <script> tag instead of importing
 * it through Vite, and point `locateFile` at the sibling .wasm file.
 */

/** The subset of binjgb's exported C API we use (see src/emscripten/wrapper.c upstream). */
export interface BinjgbModule {
  HEAPU8: Uint8Array;
  _malloc(size: number): number;
  _free(ptr: number): void;
  _emulator_new_simple(romPtr: number, romSize: number, sampleRate: number, audioFrames: number, cgbColorCurve: number): number;
  _emulator_delete(e: number): void;
  _emulator_set_builtin_palette(e: number, index: number): void;
  _emulator_get_ticks_f64(e: number): number;
  _emulator_run_until_f64(e: number, ticks: number): number;
  _emulator_was_ext_ram_updated(e: number): number;
  _emulator_read_ext_ram(e: number, fileData: number): number;
  _emulator_write_ext_ram(e: number, fileData: number): number;
  _emulator_read_mem(e: number, address: number): number;
  _emulator_set_default_joypad_callback(e: number, joypadBuffer: number): void;
  _ext_ram_file_data_new(e: number): number;
  _file_data_delete(fileData: number): void;
  _get_file_data_ptr(fileData: number): number;
  _get_file_data_size(fileData: number): number;
  _get_frame_buffer_ptr(e: number): number;
  _get_frame_buffer_size(e: number): number;
  _get_audio_buffer_ptr(e: number): number;
  _get_audio_buffer_capacity(e: number): number;
  _joypad_new(): number;
  _joypad_delete(joypadBuffer: number): void;
  _set_joyp_up(e: number, set: number): void;
  _set_joyp_down(e: number, set: number): void;
  _set_joyp_left(e: number, set: number): void;
  _set_joyp_right(e: number, set: number): void;
  _set_joyp_A(e: number, set: number): void;
  _set_joyp_B(e: number, set: number): void;
  _set_joyp_start(e: number, set: number): void;
  _set_joyp_select(e: number, set: number): void;
}

type BinjgbFactory = (options: { locateFile: (path: string) => string }) => Promise<BinjgbModule>;

declare global {
  interface Window {
    Binjgb?: BinjgbFactory;
  }
}

const BASE = `${import.meta.env.BASE_URL}vendor/binjgb/`;
let modulePromise: Promise<BinjgbModule> | null = null;

export function loadBinjgb(): Promise<BinjgbModule> {
  modulePromise ??= (async () => {
    if (!window.Binjgb) {
      await new Promise<void>((resolve, reject) => {
        const script = document.createElement("script");
        script.src = `${BASE}binjgb.js`;
        script.onload = () => resolve();
        script.onerror = () => reject(new Error("Failed to load the emulator core."));
        document.head.appendChild(script);
      });
    }
    return window.Binjgb!({ locateFile: (path) => `${BASE}${path}` });
  })();
  modulePromise.catch(() => (modulePromise = null));
  return modulePromise;
}
