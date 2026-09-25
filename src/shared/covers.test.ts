import { describe, expect, it } from "vitest";
import { coverUrl, isCoverName, isCoverPlatform, thumbnailName } from "./covers";

describe("box art names", () => {
  it("files names the way libretro does", () => {
    expect(thumbnailName("Mario & Luigi: Superstar Saga (USA)")).toBe("Mario _ Luigi_ Superstar Saga (USA)");
    expect(coverUrl("gbc", "Pokemon - Crystal Version (USA, Europe)")).toBe(
      "/api/covers/gbc/Pokemon%20-%20Crystal%20Version%20(USA%2C%20Europe).png",
    );
  });

  it("accepts only names that stay inside the thumbnail folder", () => {
    expect(isCoverName("Tetris (World) (Rev 1)")).toBe(true);
    expect(isCoverName("")).toBe(false);
    expect(isCoverName("..")).toBe(false);
    expect(isCoverName("a/b")).toBe(false);
    expect(isCoverName("a\\b")).toBe(false);
    expect(isCoverName("a\nb")).toBe(false);
    expect(isCoverName("x".repeat(201))).toBe(false);
  });

  it("knows the consoles with box art", () => {
    expect(isCoverPlatform("gba")).toBe(true);
    expect(isCoverPlatform("nes")).toBe(false);
    expect(isCoverPlatform("toString")).toBe(false);
  });
});
