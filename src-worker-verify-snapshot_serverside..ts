**Server-side (Workers — headless verification only):**
// src/worker/verify-snapshot.ts
// NOT for live play — for validating snapshot integrity on restore

import { createBinjgb } from "./binjgb-wasm"; // same .wasm file

export async function verifySnapshot(sramBytes: ArrayBuffer, expectedHash: string) {
  // Load the WASM emulator headlessly (no canvas, no input)
  const module = await createBinjgb({
    wasmBinary: wasmBytes, // fetched from R2
    noInitialRun: true,
    onRuntimeInitialized() {
      // Load SRAM into the emulator's memory
      module.HEAPU8.set(new Uint8Array(sramBytes), 0xC000); // GB SRAM offset
      // Run one frame to verify the state is valid (no crash, expected checksum)
      module.ccall('step_one_frame', null, [], []);
      const frameHash = sha256(module.HEAPU8.subarray(0, 160 * 240));
      return frameHash === expectedHash;
    },
  });
  return module;
}
