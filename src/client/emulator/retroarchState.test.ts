import { zlibSync } from "fflate";
import { describe, expect, it } from "vitest";
import { coreStateOf } from "./retroarchState";

const CORE = Uint8Array.from({ length: 1001 }, (_, i) => (i * 7) & 0xff);

function block(name: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(8 + ((data.length + 7) & ~7));
  out.set([...name].map((c) => c.charCodeAt(0)));
  new DataView(out.buffer).setUint32(4, data.length, true);
  out.set(data, 8);
  return out;
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/** RetroArch's own layout: header, a replay block before the snapshot, the snapshot, the end. */
const RASTATE = concat(
  Uint8Array.from([..."RASTATE"].map((c) => c.charCodeAt(0)).concat(1)),
  block("RPLY", new Uint8Array(13)),
  block("MEM ", CORE),
  block("END ", new Uint8Array(0)),
);

function rzip(data: Uint8Array, chunkSize: number): Uint8Array {
  const header = new Uint8Array(20);
  header.set([..."#RZIPv"].map((c) => c.charCodeAt(0)).concat(1, 0x23));
  const view = new DataView(header.buffer);
  view.setUint32(8, chunkSize, true);
  view.setBigUint64(12, BigInt(data.length), true);
  const chunks: Uint8Array[] = [];
  for (let at = 0; at < data.length; at += chunkSize) {
    const packed = zlibSync(data.subarray(at, at + chunkSize));
    const length = new Uint8Array(4);
    new DataView(length.buffer).setUint32(0, packed.length, true);
    chunks.push(length, packed);
  }
  return concat(header, ...chunks);
}

describe("coreStateOf", () => {
  it("takes the core's snapshot out of a RetroArch state file", () => {
    expect(coreStateOf(RASTATE)).toEqual(CORE);
  });

  it("unpacks a compressed one first, over several chunks", () => {
    expect(coreStateOf(rzip(RASTATE, 256))).toEqual(CORE);
  });

  it("leaves a bare core snapshot as it is", () => {
    expect(coreStateOf(CORE)).toEqual(CORE);
  });

  it("refuses a file with no snapshot in it, or cut short", () => {
    expect(() => coreStateOf(RASTATE.subarray(0, 8 + 21))).toThrow();
    expect(() => coreStateOf(rzip(RASTATE, 256).subarray(0, 100))).toThrow();
  });
});
