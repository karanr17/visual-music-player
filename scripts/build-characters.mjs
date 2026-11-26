#!/usr/bin/env node
// Builds the character atlas (src/render/chars/) from a checkout of the Universal LPC
// Spritesheet Character Generator. The output is committed, so this only needs to run when
// the layer list below changes:
//
//   git clone --depth 1 https://github.com/LiberatedPixelCup/Universal-LPC-Spritesheet-Character-Generator lpc
//   node scripts/build-characters.mjs lpc
//
// Every layer here is offered under OGA-BY 3.0, CC-BY 3.0+ or CC0 (most are multi-licensed
// and we take the OGA-BY option). The script refuses a layer whose CREDITS.csv entry offers
// none of those, and writes the matching rows to src/render/chars/CREDITS.csv.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { PNG } from "pngjs";

const lpc = process.argv[2];
if (!lpc || !existsSync(join(lpc, "CREDITS.csv"))) {
  console.error("usage: node scripts/build-characters.mjs <path to LPC generator checkout>");
  process.exit(1);
}
const SHEETS = join(lpc, "spritesheets");
const OUT = new URL("../src/render/chars/", import.meta.url).pathname;

// Source frames are 64x64; rows are facing up, left, down, right.
const SRC = 64;
const UP = 0;
const DOWN = 2;
const RIGHT = 3;

// [name, source animation file, row, first frame, frame count]
const CLIPS = [
  ["walkSide", "walk", RIGHT, 1, 8],
  ["walkBack", "walk", UP, 1, 8],
  ["standFront", "walk", DOWN, 0, 1],
  ["standSide", "walk", RIGHT, 0, 1],
  ["idleFront", "idle", DOWN, 0, 2],
  ["idleSide", "idle", RIGHT, 0, 2],
  ["sitFront", "sit", DOWN, 0, 3],
  ["sitSide", "sit", RIGHT, 0, 3],
  ["emoteFront", "emote", DOWN, 0, 3],
  ["castFront", "spellcast", DOWN, 0, 7],
  ["castSide", "spellcast", RIGHT, 0, 7],
];

// Material decides which cast colour a layer is recoloured with at runtime.
// [layer id, material, z, directory under spritesheets/ (a "<anim>.png" or "<anim>/white.png" lives in it)]
const LAYERS = [
  ["body_male", "skin", 10, "body/bodies/male"],
  ["body_female", "skin", 10, "body/bodies/female"],
  ["body_child", "skin", 10, "body/bodies/child"],
  ["head_male", "skin", 100, "head/heads/human/male"],
  ["head_female", "skin", 100, "head/heads/human/female"],
  ["head_male_elder", "skin", 100, "head/heads/human/male_elderly"],
  ["head_female_elder", "skin", 100, "head/heads/human/female_elderly"],
  ["head_child", "skin", 100, "head/heads/human/child"],
  ["hair_short", "hair", 120, "hair/plain/adult"],
  ["hair_long", "hair", 120, "hair/long_straight/adult"],
  ["hair_ponytail_bg", "hair", 9, "hair/high_ponytail/adult/bg"],
  ["hair_ponytail", "hair", 120, "hair/high_ponytail/adult/fg"],
  ["hair_curly", "hair", 120, "hair/curly_short/adult"],
  ["hair_bun", "hair", 120, "hair/bangs_bun/adult"],
  ["hair_bald", "hair", 120, "hair/balding/adult"],
  ["hair_child_short", "hair", 120, "hair/relm_short/child"],
  ["hair_child_curly", "hair", 120, "hair/jewfro/child"],
  ["hair_child_long", "hair", 120, "hair/wavy/child"],
  ["hair_child_bun", "hair", 120, "hair/parted_side_bangs/child"],
  ["hair_child_bun_fg", "hair", 145, "hair/extensions/ponytails/topknot_short/child"],
  ["top_long_male", "top", 35, "torso/clothes/longsleeve/longsleeve2/male"],
  ["top_long_female", "top", 35, "torso/clothes/longsleeve/longsleeve2/female"],
  ["top_short_male", "top", 35, "torso/clothes/shortsleeve/tshirt/male"],
  ["top_short_female", "top", 35, "torso/clothes/shortsleeve/tshirt/female"],
  ["top_child", "top", 35, "torso/clothes/shirt/child"],
  ["pants_male", "bottom", 20, "legs/pants/male"],
  ["pants_female", "bottom", 20, "legs/pants/thin"],
  ["shorts_male", "bottom", 20, "legs/shorts/shorts/male"],
  ["shorts_female", "bottom", 20, "legs/shorts/shorts/thin"],
  ["skirt_male", "bottom", 20, "legs/skirts/plain/male"],
  ["skirt_female", "bottom", 20, "legs/skirts/plain/thin"],
  ["pants_child", "bottom", 20, "legs/pants/child"],
  ["skirt_child", "bottom", 20, "legs/skirts/child"],
  ["shoes_male", "shoe", 15, "feet/shoes/basic/male"],
  ["shoes_female", "shoe", 15, "feet/shoes/basic/thin"],
];

// The colour ramps the source art is drawn in (palette_definitions/*: body "light", hair
// "orange", cloth "white"), darkest first. Index 0 is the outline.
const RAMPS = {
  skin: ["#271920", "#99423c", "#cc8665", "#E4A47C", "#F9D5BA", "#FAECE7"],
  hair: ["#260D14", "#6A1108", "#A42600", "#BF4000", "#E55600", "#FF8A00"],
  cloth: ["#281820", "#4D4A5D", "#958080", "#C4B59F", "#E5E6C7", "#FFFFFF"],
};
const rampOf = (m) => (m === "skin" ? RAMPS.skin : m === "hair" ? RAMPS.hair : RAMPS.cloth);
const rgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));

const ACCEPT = /^(OGA-BY|CC-BY 3\.0|CC-BY 4\.0|CC0)/;

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') q = false;
      else cell += ch;
    } else if (ch === '"') q = true;
    else if (ch === ",") {
      row.push(cell.trim());
      cell = "";
    } else if (ch === "\n") {
      row.push(cell.trim());
      rows.push(row);
      row = [];
      cell = "";
    } else if (ch !== "\r") cell += ch;
  }
  if (cell || row.length) rows.push([...row, cell.trim()]);
  return rows;
}

const credits = parseCsv(readFileSync(join(lpc, "CREDITS.csv"), "utf8"));
const header = credits[0];

const credited = new Set(credits.slice(1).map((r) => r[0]));

// A sheet with no CREDITS.csv row has unknown provenance, so it is left out (the clip stays
// empty and the renderer falls back to another clip for that figure).
function load(dir, anim) {
  for (const f of [join(SHEETS, dir, `${anim}.png`), join(SHEETS, dir, anim, "white.png")]) {
    if (!existsSync(f)) continue;
    if (!credited.has(`${dir}/${anim}.png`)) {
      console.warn(`skipping uncredited ${dir}/${anim}`);
      return null;
    }
    return { png: PNG.sync.read(readFileSync(f)), rel: f.slice(SHEETS.length + 1) };
  }
  return null;
}

// First pass: union bounding box of every frame we use, so all cells share one crop.
let x0 = SRC, y0 = SRC, x1 = 0, y1 = 0;
const sources = new Map();
for (const [, , , dir] of LAYERS) {
  for (const [, anim] of CLIPS) {
    const key = `${dir}|${anim}`;
    if (sources.has(key)) continue;
    const s = load(dir, anim);
    sources.set(key, s);
    if (!s) continue;
    for (const [, a, row, first, count] of CLIPS.filter((c) => c[1] === anim)) {
      void a;
      for (let f = first; f < first + count; f++) {
        for (let y = 0; y < SRC; y++) {
          for (let x = 0; x < SRC; x++) {
            const px = f * SRC + x;
            const py = row * SRC + y;
            if (px >= s.png.width || py >= s.png.height) continue;
            if (s.png.data[(py * s.png.width + px) * 4 + 3] < 128) continue;
            x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x + 1); y1 = Math.max(y1, y + 1);
          }
        }
      }
    }
  }
}
const FW = x1 - x0;
const FH = y1 - y0;
const frames = CLIPS.reduce((n, c) => n + c[4], 0);
console.log(`cell ${FW}x${FH} (crop x ${x0}-${x1}, y ${y0}-${y1}), ${frames} frames x ${LAYERS.length} layers`);

const atlas = new PNG({ width: FW * frames, height: FH * LAYERS.length });
atlas.data.fill(0);
const used = new Set();
const report = [];

LAYERS.forEach(([id, material, , dir], li) => {
  const ramp = rampOf(material).map(rgb);
  let col = 0;
  let mapped = 0;
  let fixed = 0;
  for (const [, anim, row, first, count] of CLIPS) {
    const s = sources.get(`${dir}|${anim}`);
    if (s) used.add(s.rel);
    for (let f = first; f < first + count; f++, col++) {
      if (!s) continue;
      for (let y = 0; y < FH; y++) {
        for (let x = 0; x < FW; x++) {
          const px = f * SRC + x0 + x;
          const py = row * SRC + y0 + y;
          if (px >= s.png.width || py >= s.png.height) continue;
          const i = (py * s.png.width + px) * 4;
          if (s.png.data[i + 3] < 128) continue;
          const c = [s.png.data[i], s.png.data[i + 1], s.png.data[i + 2]];
          let best = -1;
          let bestD = Infinity;
          ramp.forEach((r, k) => {
            const d = (r[0] - c[0]) ** 2 + (r[1] - c[1]) ** 2 + (r[2] - c[2]) ** 2;
            if (d < bestD) { bestD = d; best = k; }
          });
          const o = ((li * FH + y) * atlas.width + col * FW + x) * 4;
          // Alpha 254 marks a ramp pixel (R = ramp index * 40); 255 keeps the source colour
          // (eyes, the odd accent) as drawn.
          // Child clothes only ship pre-coloured, so they map onto the ramp by brightness.
          if (bestD > 12 * 12 && material !== "skin") {
            const lum = (v) => v[0] * 0.3 + v[1] * 0.59 + v[2] * 0.11;
            const lc = lum(c);
            bestD = 0;
            best = ramp.reduce((b, r, k) => (Math.abs(lum(r) - lc) < Math.abs(lum(ramp[b]) - lc) ? k : b), 0);
          }
          if (bestD <= 12 * 12) {
            atlas.data[o] = atlas.data[o + 1] = atlas.data[o + 2] = best * 40;
            atlas.data[o + 3] = 254;
            mapped++;
          } else {
            atlas.data.set([...c, 255], o);
            fixed++;
          }
        }
      }
    }
  }
  report.push(`${id.padEnd(24)} ramp ${mapped} fixed ${fixed}`);
});
console.log(report.join("\n"));

// Feet-planting calibration: how far the planted foot slides back per walk frame.
{
  const s = sources.get("body/bodies/male|walk");
  const feet = [];
  for (let f = 1; f <= 8; f++) {
    let lowY = -1;
    const xs = [];
    for (let y = SRC - 1; y >= 0 && lowY < 0; y--) {
      for (let x = 0; x < SRC; x++) if (s.png.data[((RIGHT * SRC + y) * s.png.width + f * SRC + x) * 4 + 3] >= 128) xs.push(x), (lowY = y);
    }
    feet.push(`${f}:y${lowY} x${Math.min(...xs)}-${Math.max(...xs)}`);
  }
  console.log("lowest foot row per walkSide frame:", feet.join("  "));
}

let sole = 0;
{
  const s = sources.get("body/bodies/male|walk");
  for (let y = 0; y < SRC; y++) for (let x = 0; x < SRC; x++) if (s.png.data[((DOWN * SRC + y) * s.png.width + x) * 4 + 3] >= 128) sole = y;
}

mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, "atlas.png"), PNG.sync.write(atlas, { colorType: 6 }));

let start = 0;
const clips = Object.fromEntries(CLIPS.map(([name, , , , count]) => {
  const v = [start, count];
  start += count;
  return [name, v];
}));
const layers = Object.fromEntries(LAYERS.map(([id, material, z], i) => [id, { row: i, material, z }]));
writeFileSync(
  join(OUT, "atlas.ts"),
  `// Generated by scripts/build-characters.mjs. Do not edit by hand.\n` +
    `export const CELL_W = ${FW};\nexport const CELL_H = ${FH};\n` +
    `// Rows between the soles of a standing figure and the cell's bottom edge.\nexport const FOOT_PAD = ${y1 - 1 - sole};\n` +
    `export const CLIPS = ${JSON.stringify(clips)} as const;\n` +
    `export const LAYERS = ${JSON.stringify(layers)} as const;\n`,
);

// Credits: every CREDITS.csv row for a file we read.
// Pre-coloured sheets ("walk/white.png") are credited under the animation ("walk.png").
const creditKey = (u) => u.replace(/\/([a-z_]+)\/[a-z_]+\.png$/, (m, anim) => (CLIPS.some((c) => c[1] === anim) ? `/${anim}.png` : m));
const keys = new Set([...used].map(creditKey));
const rows = credits.slice(1).filter((r) => keys.has(r[0]));
const missing = [...keys].filter((u) => !rows.some((r) => r[0] === u));
if (missing.length) {
  console.error("no CREDITS.csv entry for:", missing);
  process.exit(1);
}
const bad = rows.filter((r) => !r[3].split(",").some((l) => ACCEPT.test(l.trim())));
if (bad.length) {
  console.error("licence not OGA-BY / CC-BY / CC0:", bad.map((r) => `${r[0]} (${r[3]})`));
  process.exit(1);
}
const esc = (v) => `"${v.replace(/"/g, '""')}"`;
writeFileSync(join(OUT, "CREDITS.csv"), [header, ...rows].map((r) => r.map(esc).join(",")).join("\n") + "\n");
console.log(`atlas ${atlas.width}x${atlas.height}, ${rows.length} credited files`);
