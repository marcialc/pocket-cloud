import { describe, expect, it } from "vitest";
import { formatCode, normalizeCode, normalizeEmail } from "./auth";

describe("normalizeEmail", () => {
  it("trims and lowercases", () => {
    expect(normalizeEmail("  Ash@Pallet.Town ")).toBe("ash@pallet.town");
  });

  it("rejects things that can't be emails", () => {
    for (const bad of ["", "ash", "ash@", "@town.co", "ash@town", "a b@c.co", 42, null, `${"a".repeat(250)}@b.co`]) {
      expect(normalizeEmail(bad)).toBeNull();
    }
  });
});

describe("normalizeCode", () => {
  it("accepts dashes, spaces and lowercase", () => {
    expect(normalizeCode("k7qm-4xrp")).toBe("K7QM4XRP");
    expect(normalizeCode(" K7QM 4XRP ")).toBe("K7QM4XRP");
  });

  it("rejects wrong lengths and look-alike characters", () => {
    for (const bad of ["K7QM4XR", "K7QM4XRPP", "K7QM4XR0", "K7QM4XRO", "K7QM4XR1", "K7QM4XRI", "K7QM4XRL", 12345678]) {
      expect(normalizeCode(bad)).toBeNull();
    }
  });

  it("formats for display", () => {
    expect(formatCode("K7QM4XRP")).toBe("K7QM-4XRP");
  });
});
