import type { AppearanceSpec } from "../scene/schema";
import atlasUrl from "./chars/atlas.png";
import { CELL_H, CELL_W, CLIPS, FOOT_PAD, LAYERS } from "./chars/atlas";
import { K, mix, pack, type RGB } from "./fb";
import { hexRgb, lit } from "./lighting";
import { hash1 } from "./noise";
import type { SpriteCtx } from "./sprites";

// Sprite-sheet people: LPC character layers (see CREDITS.md), recoloured at draw time from the
// song's cast. The atlas stores, per pixel, an index into a 6-step shading ramp (outline to
// highlight) instead of a colour, so one sheet serves every skin, hair and clothing colour.

export type Clip = keyof typeof CLIPS;
type LayerId = keyof typeof LAYERS;
type Material = (typeof LAYERS)[LayerId]["material"];

// Source pixels the planted foot slides back per walkSide frame, measured from the sheet by
// scripts/build-characters.mjs. Advancing one frame per this much ground keeps feet planted.
export const STEP_PX = 2.9;
export const WALK_FRAMES = CLIPS.walkSide[1];

// Per layer and atlas frame: opaque pixels as (x, y, code); code < 8 is a ramp index, otherwise
// code - 8 indexes FIXED (colours kept as drawn, such as eyes).
type Cell = Int16Array;
let cells: (Cell | null)[][] | null = null;
const FIXED: RGB[] = [];

export const charactersReady = () => cells !== null;

export async function loadCharacters(): Promise<void> {
  if (cells) return;
  const blob = await (await fetch(atlasUrl)).blob();
  const bmp = await createImageBitmap(blob, { colorSpaceConversion: "none", premultiplyAlpha: "none" });
  const cv = document.createElement("canvas");
  cv.width = bmp.width;
  cv.height = bmp.height;
  const g = cv.getContext("2d", { willReadFrequently: true })!;
  g.drawImage(bmp, 0, 0);
  const { data, width } = g.getImageData(0, 0, bmp.width, bmp.height);
  const fixedIdx = new Map<number, number>();
  const frames = bmp.width / CELL_W;
  const out: (Cell | null)[][] = [];
  for (const id of Object.keys(LAYERS) as LayerId[]) {
    const row = LAYERS[id].row;
    const layer: (Cell | null)[] = [];
    for (let f = 0; f < frames; f++) {
      const px: number[] = [];
      for (let y = 0; y < CELL_H; y++) {
        for (let x = 0; x < CELL_W; x++) {
          const i = ((row * CELL_H + y) * width + f * CELL_W + x) * 4;
          const a = data[i + 3];
          if (a < 128) continue;
          let code: number;
          // Alpha 254 marks a ramp pixel; the canvas round trip can nudge its grey by one step.
          if (a < 255) code = Math.min(5, Math.round(data[i] / 40));
          else {
            const key = (data[i] << 16) | (data[i + 1] << 8) | data[i + 2];
            let k = fixedIdx.get(key);
            if (k === undefined) {
              k = FIXED.length;
              FIXED.push([data[i], data[i + 1], data[i + 2]]);
              fixedIdx.set(key, k);
            }
            code = 8 + k;
          }
          px.push(x, y, code);
        }
      }
      layer.push(px.length ? Int16Array.from(px) : null);
    }
    out.push(layer);
  }
  cells = out;
}

// Hue-shifted ramp around the cast colour: shadows cool toward violet, highlights warm toward
// cream, the way pixel artists ramp rather than plain darken/lighten.
function ramp(base: RGB): RGB[] {
  const shade: RGB = [Math.round(base[0] * 0.42), Math.round(base[1] * 0.38), Math.round(base[2] * 0.5 + 18)];
  const hi: RGB = [255, 246, 226];
  return [
    mix(base, [22, 14, 26], 0.84),
    mix(base, shade, 0.85),
    mix(base, shade, 0.45),
    base,
    mix(base, hi, 0.3),
    mix(base, hi, 0.55),
  ];
}

const rampCache = new Map<string, RGB[]>();
function rampFor(hex: string): RGB[] {
  let r = rampCache.get(hex);
  if (!r) {
    r = ramp(hexRgb(hex));
    rampCache.set(hex, r);
  }
  return r;
}

const SHOE = "#3a2e2c";

interface Look {
  layers: LayerId[];
  child: boolean;
}

const lookCache = new Map<string, Look>();

function lookFor(ap: AppearanceSpec): Look {
  const key = `${ap.gender}|${ap.age}|${ap.hairStyle}|${ap.outfit}`;
  let l = lookCache.get(key);
  if (l) return l;
  const child = ap.age === "child";
  const fem = ap.gender !== "male";
  const bt = fem ? "female" : "male";
  const layers: LayerId[] = [];
  if (child) {
    layers.push("body_child", "head_child", "top_child", ap.outfit === "skirt" || ap.outfit === "dress" ? "skirt_child" : "pants_child");
    const hair: Partial<Record<AppearanceSpec["hairStyle"], LayerId[]>> = {
      long: ["hair_child_long"],
      curly: ["hair_child_curly"],
      ponytail: ["hair_child_bun", "hair_child_bun_fg"],
      bun: ["hair_child_bun", "hair_child_bun_fg"],
    };
    layers.push(...(hair[ap.hairStyle] ?? ["hair_child_short"]));
  } else {
    layers.push(`body_${bt}`);
    const elder = ap.age === "elder";
    // Neutral figures pair the slimmer body with the plainer head.
    const head = ap.gender === "female" ? "female" : "male";
    layers.push(elder ? `head_${head}_elder` : `head_${head}`);
    layers.push(ap.outfit === "pants" ? `top_long_${bt}` : `top_short_${bt}`);
    layers.push(ap.outfit === "pants" ? `pants_${bt}` : ap.outfit === "shorts" ? `shorts_${bt}` : `skirt_${bt}`);
    layers.push(`shoes_${bt}`);
    const hair: Record<AppearanceSpec["hairStyle"], LayerId[]> = {
      short: ["hair_short"],
      long: ["hair_long"],
      ponytail: ["hair_ponytail_bg", "hair_ponytail"],
      curly: ["hair_curly"],
      bun: ["hair_bun"],
      bald: ["hair_bald"],
    };
    layers.push(...hair[ap.hairStyle]);
  }
  layers.sort((a, b) => LAYERS[a].z - LAYERS[b].z);
  l = { layers, child };
  lookCache.set(key, l);
  return l;
}

// Child clothes only exist for the walk, so a child's other clips fall back to standing.
const CHILD_CLIP: Partial<Record<Clip, Clip>> = {
  idleFront: "standFront",
  idleSide: "standSide",
  sitFront: "standFront",
  sitSide: "standSide",
  emoteFront: "standFront",
  castFront: "standFront",
  castSide: "standSide",
};

export function clipLength(clip: Clip): number {
  return CLIPS[clip][1];
}

// Source pixels from the cell's top edge to the soles; scale by the draw scale for on-screen height.
export const FIGURE_H = CELL_H - FOOT_PAD;

export interface CharDraw {
  clip: Clip;
  frame: number;
  // Mirror horizontally: side clips face right as drawn.
  flip: boolean;
  // Extra lift in source pixels (a dance bounce).
  lift?: number;
}

// Draws a figure with its soles at (x, y). `s` is physical pixels per source pixel: whole
// numbers stay crisp; below 1 the figure is point-sampled down.
export function drawCharacter(c: SpriteCtx, x: number, y: number, s: number, ap: AppearanceSpec, d: CharDraw, alpha: number): void {
  if (!cells || alpha <= 0.01) return;
  const look = lookFor(ap);
  const clip = look.child ? (CHILD_CLIP[d.clip] ?? d.clip) : d.clip;
  const [start, count] = CLIPS[clip];
  const frame = start + (((Math.floor(d.frame) % count) + count) % count);
  const step = s >= 1 ? 1 : Math.round(1 / s);
  const size = s >= 1 ? Math.round(s) : 1;

  const colours: Record<Material, RGB[]> = {
    skin: rampFor(ap.skin),
    hair: rampFor(ap.hair),
    top: rampFor(ap.top),
    bottom: rampFor(ap.outfit === "dress" ? ap.top : ap.bottom),
    shoe: rampFor(SHOE),
  };
  // Key light from the sprite's lit side; the ramp already carries the form shading.
  const k = 0.2;
  const shaded = new Map<RGB, number>();
  const solidV = c.solid ? pack(c.solid) : 0;
  const colourOf = (base: RGB) => {
    let v = shaded.get(base);
    if (v === undefined) {
      v = pack(lit(c.light, base, k, c.haze, c.hazeCol));
      shaded.set(base, v);
    }
    return v;
  };

  const fb = c.fb;
  const pxW = (CELL_W / step) * size;
  // Physical-pixel origin of the cell, snapped so the figure doesn't shimmer between frames.
  const ox = Math.round(x * K - pxW / 2);
  const oy = Math.round(y * K) - Math.round(((CELL_H - FOOT_PAD + (d.lift ?? 0)) / step) * size);
  for (const id of look.layers) {
    const cell = cells[LAYERS[id].row][frame];
    if (!cell) continue;
    const pal = colours[LAYERS[id].material];
    for (let i = 0; i < cell.length; i += 3) {
      const sx = cell[i];
      const sy = cell[i + 1];
      if (step > 1 && (sx % step || sy % step)) continue;
      const col = d.flip ? CELL_W - 1 - sx : sx;
      const code = cell[i + 2];
      const v = c.solid ? solidV : colourOf(code < 8 ? pal[code] : FIXED[code - 8]);
      fb.block(ox + Math.floor(col / step) * size, oy + Math.floor(sy / step) * size, size, v, alpha);
    }
  }
}

const SKINS = ["#8d5524", "#c68642", "#e0ac69", "#f1c27d", "#ffdbac", "#a8714f"];
const HAIRS = ["#1c1410", "#3b2416", "#6b4226", "#a87b4f", "#d8b26a", "#7a7a80"];
const CLOTH = ["#3f6f9f", "#9f3f4f", "#4f8f5f", "#d9a441", "#6a4f8f", "#2d2d38", "#c8c2b4", "#b4553a"];

// Crowds and extras get a stable random look, so a crowd isn't a row of clones.
export function extraLook(seed: number): AppearanceSpec {
  const r = (k: number) => hash1(Math.floor(seed * 1000) + k * 7919);
  const female = r(1) > 0.5;
  const pickOf = (a: string[], k: number) => a[Math.floor(r(k) * a.length)];
  return {
    gender: female ? "female" : "male",
    age: "adult",
    skin: pickOf(SKINS, 2),
    hair: pickOf(HAIRS, 3),
    hairStyle: female ? (r(4) > 0.5 ? "long" : "ponytail") : r(4) > 0.85 ? "bald" : r(4) > 0.6 ? "curly" : "short",
    top: pickOf(CLOTH, 5),
    bottom: pickOf(CLOTH, 6),
    outfit: female && r(7) > 0.6 ? (r(8) > 0.5 ? "dress" : "skirt") : "pants",
  };
}
