#!/usr/bin/env node
// Rebuild public/covers.json, the lookup the library uses to find box art:
// ROM SHA-1 (first 12 hex digits) -> [platform, No-Intro name], from the
// libretro-database No-Intro DATs. The names are what thumbnails.libretro.com
// files the art under (see shared/covers.ts).
//
//   node scripts/update-covers.mjs
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const DATS = {
  gb: "Nintendo - Game Boy",
  gbc: "Nintendo - Game Boy Color",
  gba: "Nintendo - Game Boy Advance",
};
const BASE = "https://raw.githubusercontent.com/libretro/libretro-database/master/metadat/no-intro/";
const OUT = fileURLToPath(new URL("../public/covers.json", import.meta.url));

const games = {};
let count = 0;
for (const [platform, dat] of Object.entries(DATS)) {
  const res = await fetch(BASE + encodeURIComponent(dat) + ".dat");
  if (!res.ok) throw new Error(`${dat}: HTTP ${res.status}`);
  const text = await res.text();
  // game ( name "..." ... rom ( ... sha1 ABC... ) )
  for (const [, name, body] of text.matchAll(/^game \(\n\tname "((?:[^"\\]|\\.)*)"\n([\s\S]*?)^\)/gm)) {
    for (const [, sha1] of body.matchAll(/\bsha1 ([0-9A-Fa-f]{40})\b/g)) {
      games[sha1.slice(0, 12).toLowerCase()] = [platform, name];
      count++;
    }
  }
}
await writeFile(OUT, JSON.stringify({ games }) + "\n");
console.log(`wrote ${Object.keys(games).length} games (${count} ROMs) to public/covers.json`);
