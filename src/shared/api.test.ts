import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { base64ToBytes, bytesToBase64, sha256Hex } from "./api";

describe("cloud save wire format", () => {
  it("round-trips a full 32 KiB SRAM through base64", () => {
    const sram = new Uint8Array(32 * 1024).map((_, i) => (i * 31) & 0xff);
    const encoded = bytesToBase64(sram);
    expect(encoded).toBe(Buffer.from(sram).toString("base64"));
    expect(base64ToBytes(encoded)).toEqual(sram);
  });

  it("handles empty and small buffers", () => {
    expect(base64ToBytes(bytesToBase64(new Uint8Array()))).toEqual(new Uint8Array());
    expect(bytesToBase64(new Uint8Array([0, 255]))).toBe("AP8=");
  });

  it("hashes like node:crypto", async () => {
    const data = new Uint8Array([1, 2, 3]);
    expect(await sha256Hex(data)).toBe(createHash("sha256").update(data).digest("hex"));
  });
});
