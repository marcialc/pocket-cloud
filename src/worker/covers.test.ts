import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

const API = "https://example.com/api";

describe("box art", () => {
  it("turns away names and consoles it won't look up, without signing in", async () => {
    for (const path of ["nes/Tetris%20(World).png", "gb/..%2Fsecret.png", "gb/a%0Ab.png", "gb/%E0%A4%A.png"]) {
      const res = await SELF.fetch(`${API}/covers/${path}`);
      expect(res.status, path).toBe(400);
    }
    expect((await SELF.fetch(`${API}/covers/gb/Tetris.jpg`)).status).toBe(404);
    expect((await SELF.fetch(`${API}/covers/gb/Tetris.png`, { method: "POST" })).status).toBe(405);
  });
});
