import { describe, expect, it } from "vitest";
import {
  EMPTY_SHELF,
  MAX_GROUPS,
  MAX_SHELF_BYTES,
  addGroup,
  forgetGame,
  isShelf,
  removeGroup,
  renameGroup,
  sanitizeShelf,
  setGameGroups,
  shelfBytes,
  toggleFavorite,
  type Shelf,
} from "./shelf";

const A = "a".repeat(64);
const B = "b".repeat(64);
const hash = (i: number) => i.toString(16).padStart(64, "0");

describe("library shelf", () => {
  it("toggles favorites", () => {
    const on = toggleFavorite(EMPTY_SHELF, A);
    expect(on.favorites).toEqual([A]);
    expect(toggleFavorite(on, A).favorites).toEqual([]);
  });

  it("adds, renames and removes groups", () => {
    let shelf = addGroup(EMPTY_SHELF, "  RPGs   to  play ", "g1");
    expect(shelf.groups).toEqual([{ id: "g1", name: "RPGs to play", roms: [] }]);
    expect(addGroup(shelf, "   ", "g2")).toBe(shelf);
    shelf = renameGroup(shelf, "g1", "RPGs");
    expect(shelf.groups[0]!.name).toBe("RPGs");
    expect(renameGroup(shelf, "g1", " ")).toBe(shelf);
    expect(removeGroup(shelf, "g1").groups).toEqual([]);
  });

  it("caps the number of groups", () => {
    let shelf = EMPTY_SHELF;
    for (let i = 0; i < MAX_GROUPS + 3; i++) shelf = addGroup(shelf, `G${i}`, `g${i}`);
    expect(shelf.groups).toHaveLength(MAX_GROUPS);
  });

  it("puts a game in exactly the chosen groups", () => {
    let shelf = addGroup(addGroup(EMPTY_SHELF, "One", "g1", [A]), "Two", "g2");
    shelf = setGameGroups(shelf, A, new Set(["g2"]));
    expect(shelf.groups.map((g) => g.roms)).toEqual([[], [A]]);
    shelf = setGameGroups(shelf, B, new Set(["g1", "g2"]));
    expect(shelf.groups.map((g) => g.roms)).toEqual([[B], [A, B]]);
  });

  it("forgets a game everywhere, and leaves the shelf alone if it wasn't there", () => {
    const shelf = addGroup(toggleFavorite(EMPTY_SHELF, A), "One", "g1", [A, B]);
    expect(forgetGame(shelf, A)).toEqual({ favorites: [], groups: [{ id: "g1", name: "One", roms: [B] }] });
    const other = toggleFavorite(EMPTY_SHELF, B);
    expect(forgetGame(other, A)).toBe(other);
  });

  it("validates stored shelves", () => {
    expect(isShelf({ favorites: [A], groups: [{ id: "g1", name: "One", roms: [B] }] })).toBe(true);
    for (const bad of [
      null,
      [],
      { favorites: [] },
      { favorites: ["nope"], groups: [] },
      { favorites: [], groups: [{ id: "G!", name: "x", roms: [] }] },
      { favorites: [], groups: [{ id: "g1", name: " ", roms: [] }] },
      { favorites: [], groups: [{ id: "g1", name: "x".repeat(41), roms: [] }] },
      { favorites: [], groups: [{ id: "g1", name: "x", roms: [42] }] },
    ]) {
      expect(isShelf(bad)).toBe(false);
    }
    expect(sanitizeShelf("junk")).toEqual(EMPTY_SHELF);
  });

  it("refuses changes that would outgrow what the server stores", () => {
    // Fill two groups one game at a time until the next one would go over the size limit
    // (a group holds at most 500 games, so the first fills up before the bytes run out).
    let shelf: Shelf = addGroup(addGroup(EMPTY_SHELF, "G0", "g0"), "G1", "g1");
    let i = 0;
    for (const id of ["g0", "g1"]) {
      for (;;) {
        const next = setGameGroups(shelf, hash(i), new Set([id]));
        if (next === shelf) break;
        shelf = next;
        i++;
      }
    }
    expect(shelf.groups[0]!.roms).toHaveLength(500);
    expect(shelfBytes(shelf)).toBeLessThanOrEqual(MAX_SHELF_BYTES);
    expect(shelfBytes(shelf)).toBeGreaterThan(MAX_SHELF_BYTES - 70);
    expect(isShelf(shelf)).toBe(true);
    expect(toggleFavorite(shelf, hash(i))).toBe(shelf);
    // Taking games out still works.
    expect(setGameGroups(shelf, hash(0), new Set())).not.toBe(shelf);
    expect(toggleFavorite(toggleFavorite(EMPTY_SHELF, A), A).favorites).toEqual([]);
  });

  it("rejects duplicates and ids the start screen uses for its own filters", () => {
    expect(isShelf({ favorites: [A, A], groups: [] })).toBe(false);
    expect(isShelf({ favorites: [], groups: [{ id: "g1", name: "x", roms: [B, B] }] })).toBe(false);
    expect(
      isShelf({
        favorites: [],
        groups: [
          { id: "g1", name: "x", roms: [] },
          { id: "g1", name: "y", roms: [] },
        ],
      }),
    ).toBe(false);
    for (const id of ["all", "favorites"]) expect(isShelf({ favorites: [], groups: [{ id, name: "x", roms: [] }] })).toBe(false);
    expect(addGroup(EMPTY_SHELF, "Faves", "favorites")).toBe(EMPTY_SHELF);
  });
});
