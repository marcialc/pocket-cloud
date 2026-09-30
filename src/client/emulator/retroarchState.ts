import { unzlibSync } from "fflate";

/**
 * The core's own snapshot inside a RetroArch state file, for the link
 * server's mGBA (link-server/), which doesn't know RetroArch's wrapping.
 * RetroArch loads the bare core snapshot back as is (content_deserialize_state
 * takes a file without the RASTATE header as core data).
 *
 * RetroArch 1.22 (tasks/task_save.c, libretro-common/streams/rzip_stream.c):
 * - Compressed files are RZIP: "#RZIPv\x01#", chunk size (u32), total size
 *   (u64), then chunks of compressed size (u32) + zlib data.
 * - Inside, "RASTATE" + version byte, then blocks of a 4-byte name and a
 *   length (u32), each padded to 8 bytes; "MEM " is the core's snapshot and
 *   "END " the last block.
 * - Anything else is a bare core snapshot (older RetroArch).
 * Numbers are little-endian.
 */
export function coreStateOf(file: Uint8Array): Uint8Array {
  const data = startsWith(file, "#RZIPv") ? unRzip(file) : file;
  if (!startsWith(data, "RASTATE")) return data;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let at = 8;
  while (at + 8 <= data.length) {
    const name = String.fromCharCode(...data.subarray(at, at + 4));
    const length = view.getUint32(at + 4, true);
    if (name === "MEM ") {
      if (at + 8 + length > data.length) break;
      return data.slice(at + 8, at + 8 + length);
    }
    if (name === "END ") break;
    at += 8 + align8(length);
  }
  throw new Error("No core snapshot in this RetroArch state file.");
}

function unRzip(file: Uint8Array): Uint8Array {
  const view = new DataView(file.buffer, file.byteOffset, file.byteLength);
  if (file.length < 20 || file[6] !== 1 || file[7] !== 0x23) throw new Error("Unsupported RZIP file.");
  const total = Number(view.getBigUint64(12, true));
  const out = new Uint8Array(total);
  let written = 0;
  let at = 20;
  while (at + 4 <= file.length && written < total) {
    const length = view.getUint32(at, true);
    const chunk = unzlibSync(file.subarray(at + 4, at + 4 + length));
    if (written + chunk.length > total) throw new Error("RZIP file larger than it says.");
    out.set(chunk, written);
    written += chunk.length;
    at += 4 + length;
  }
  if (written !== total) throw new Error("RZIP file cut short.");
  return out;
}

function startsWith(data: Uint8Array, text: string): boolean {
  if (data.length < text.length) return false;
  for (let i = 0; i < text.length; i++) if (data[i] !== text.charCodeAt(i)) return false;
  return true;
}

function align8(n: number): number {
  return (n + 7) & ~7;
}
