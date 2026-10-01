import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("sitemap.xml", () => {
  it("lists only pages that exist in public/", () => {
    const xml = readFileSync("public/sitemap.xml", "utf8");
    const locs = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]!);
    expect(locs.length).toBeGreaterThan(0);
    for (const loc of locs) {
      const { pathname } = new URL(loc);
      if (pathname === "/") continue;
      expect(existsSync(`public${pathname}.html`), `${loc} -> public${pathname}.html`).toBe(true);
    }
  });
});
