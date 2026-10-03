import { describe, expect, it } from "vitest";
import { nearest } from "./padNav";

/** A box `w` × `h` with its top left at x, y. */
const box = (x: number, y: number, w = 100, h = 40) => ({ left: x, top: y, right: x + w, bottom: y + h });

describe("padNav", () => {
  // Two rows of three tiles, and a wide button below them.
  const grid = [
    { item: "a1", box: box(0, 0) },
    { item: "a2", box: box(120, 0) },
    { item: "a3", box: box(240, 0) },
    { item: "b1", box: box(0, 60) },
    { item: "b2", box: box(120, 60) },
    { item: "b3", box: box(240, 60) },
    { item: "wide", box: box(0, 120, 340) },
  ];
  const from = (name: string) => grid.find((c) => c.item === name)!.box;
  const others = (name: string) => grid.filter((c) => c.item !== name);

  it("moves to the neighbour that way", () => {
    expect(nearest(from("a2"), "right", others("a2"))).toBe("a3");
    expect(nearest(from("a2"), "left", others("a2"))).toBe("a1");
    expect(nearest(from("a2"), "down", others("a2"))).toBe("b2");
    expect(nearest(from("b3"), "up", others("b3"))).toBe("a3");
  });

  it("prefers straight ahead to closer but off to the side", () => {
    expect(nearest(from("a1"), "down", others("a1"))).toBe("b1");
    expect(nearest(from("b3"), "down", others("b3"))).toBe("wide");
  });

  it("goes to the next row first, to its control nearest straight ahead", () => {
    // A close button top right, a row of tiles, then a switch lined up with the close button.
    const menu = [
      { item: "close", box: box(500, 0, 30, 30) },
      { item: "pause", box: box(0, 50, 80, 60) },
      { item: "games", box: box(400, 50, 80, 60) },
      { item: "switch", box: box(500, 140, 30, 20) },
    ];
    expect(nearest(menu[0]!.box, "down", menu.slice(1))).toBe("games");
    expect(nearest(menu[2]!.box, "down", [menu[3]!])).toBe("switch");
    expect(nearest(menu[3]!.box, "up", menu.slice(0, 3))).toBe("games");
  });

  it("keeps left and right in the row, even with a closer control in the next one", () => {
    // Menu tiles, and below them a wide slider whose right end is nearer than the next tile.
    const menu = [
      { item: "mute", box: box(0, 0, 80, 60) },
      { item: "fullscreen", box: box(200, 0, 80, 60) },
      { item: "slider", box: box(60, 80, 130, 20) },
    ];
    expect(nearest(menu[1]!.box, "left", [menu[0]!, menu[2]!])).toBe("mute");
    // Nothing more in the row: the next control that way.
    expect(nearest(menu[0]!.box, "right", [menu[2]!])).toBe("slider");
  });

  it("stays put at an edge", () => {
    expect(nearest(from("a3"), "right", others("a3"))).toBeNull();
    expect(nearest(from("a1"), "up", others("a1"))).toBeNull();
    expect(nearest(from("wide"), "down", others("wide"))).toBeNull();
  });
});
