import { z } from "zod";
import type { SceneScript } from "../scene/schema";
import { SETTINGS, type Setting } from "../scene/vocab";
import { DEPTH_SETTINGS, drawSky, HORIZON, type SceneCtx } from "./backdrops";
import { bayer, H, K, mix, pack, PH, PW, W, type RGB } from "./fb";
import type { WorldParams } from "./palette";

// Illustrated mode: per-section backdrop plates made offline by scripts/plates (FLUX.1-schnell),
// split into parallax layers there and quantised to the world's palette here, so the same plate
// follows a look or time-of-day change without being regenerated.

// Plates are authored at logical resolution with a margin round the 320x180 frame, so the camera
// can drift and tilt without showing an edge.
export const PLATE_W = 384;
export const PLATE_H = 216;
const OX = (PLATE_W - W) / 2;
// Plate row drawn at the top of the frame when the plate has no horizon (indoors): centred.
const OY = (PLATE_H - H) / 2;
// Keeps a badly measured horizon from leaving most of the frame empty or most of the plate unseen.
const OY_MIN = -70;
const OY_MAX = PLATE_H - H + 20;
// How far the camera may drift sideways over a plate before it would run out of picture.
export const PLATE_PAN = OX - 4;

// Road and river scroll toward the viewer as the song travels; a still picture can't, so they
// keep their procedural backdrop.
export const plateable = (s: Setting) => !DEPTH_SETTINGS.has(s);

const DataUrl = z.string().startsWith("data:image/png;base64,");

export const PlateSet = z.object({
  version: z.literal(1),
  trackKey: z.string(),
  model: z.string(),
  width: z.literal(PLATE_W),
  height: z.literal(PLATE_H),
  // Layers far to near; the farthest has the sky cut out (transparent) for outdoor settings.
  // horizon: the plate row where its ground meets the sky, lined up with the engine's horizon so
  // figures stand on the plate's ground; null indoors.
  plates: z.record(
    z.string(),
    z.object({ prompt: z.string(), seed: z.number(), horizon: z.number().nullable(), layers: z.array(DataUrl).min(1).max(4) }),
  ),
  // One entry per script section. prompt is the section's world.plate as the generator saw it
  // (empty for scripts without one), so a regenerated or edited script doesn't pick up stale art.
  sections: z.array(z.object({ setting: z.enum(SETTINGS), prompt: z.string(), plate: z.string().nullable() })),
});
export type PlateSet = z.infer<typeof PlateSet>;

// Decoded RGBA, far to near, each PLATE_W x PLATE_H.
export interface PlateImage {
  horizon: number | null;
  layers: Uint8ClampedArray[];
}

export interface DecodedPlates {
  set: PlateSet;
  images: Map<string, PlateImage>;
}

// Quantised layers: packed colours, 0 where transparent.
export interface PlateLayers {
  id: string;
  layers: Uint32Array[];
  // Plate row at the top of the frame before the camera moves.
  top: number;
  // Per layer and plate row: EMPTY (nothing to draw), SOLID (hides whatever is behind) or neither.
  rows: Uint8Array[];
}

// Which plate each section of `script` uses, or null where the set has none that fits.
export function matchPlates(set: PlateSet, script: SceneScript): (string | null)[] {
  if (set.trackKey !== script.trackKey) return script.sections.map(() => null);
  return script.sections.map((s, i) => {
    const e = set.sections[i];
    if (!e?.plate || !set.plates[e.plate] || !plateable(s.world.setting)) return null;
    return e.setting === s.world.setting && e.prompt === (s.world.plate ?? "") ? e.plate : null;
  });
}

const lum = (c: RGB) => 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2];
const dist2 = (a: RGB, r: number, g: number, b: number) => (a[0] - r) ** 2 + (a[1] - g) ** 2 + (a[2] - b) ** 2;

// The land's tones in this world, dark to light: the plate's brightness is spread over these, so
// a night world makes the same plate dark and a dusk world warms it.
function tones(p: WorldParams): RGB[] {
  const { pal } = p;
  const t = [mix(pal.near, [0, 0, 0], 0.45), pal.near, pal.mid, pal.far, mix(pal.far, pal.skyBot, 0.5), mix(pal.skyBot, pal.light, 0.35)];
  return t.sort((a, b) => lum(a) - lum(b));
}

// The gradient map: the tone at this colour's brightness.
function toneAt(t: RGB[], r: number, g: number, b: number): RGB {
  const pos = ((0.299 * r + 0.587 * g + 0.114 * b) / 255) * (t.length - 1);
  const j = Math.min(t.length - 2, Math.floor(pos));
  return mix(t[j], t[j + 1], pos - j);
}

// The plate's most used colours (popularity over a 4-bit-per-channel histogram), so its own hues
// (flowers, lit windows) survive the snap to the world's palette.
function dominant(img: PlateImage, n: number): RGB[] {
  const sum = new Float64Array(4096 * 4);
  for (const src of img.layers) {
    for (let i = 0; i < src.length; i += 4) {
      if (src[i + 3] < 128) continue;
      const k = ((src[i] >> 4) << 8) | ((src[i + 1] >> 4) << 4) | (src[i + 2] >> 4);
      sum[k * 4] += src[i];
      sum[k * 4 + 1] += src[i + 1];
      sum[k * 4 + 2] += src[i + 2];
      sum[k * 4 + 3]++;
    }
  }
  const keys = [...Array(4096).keys()].filter((k) => sum[k * 4 + 3] > 0).sort((a, b) => sum[b * 4 + 3] - sum[a * 4 + 3]);
  return keys.slice(0, n).map((k) => [0, 1, 2].map((c) => Math.round(sum[k * 4 + c] / sum[k * 4 + 3])) as RGB);
}

// What pixels snap to: the tones with a step between each pair, the world's accents, and the
// plate's own main colours pulled toward the tones as every pixel is.
function snapPalette(p: WorldParams, t: RGB[], own: RGB[]): RGB[] {
  const out: RGB[] = [];
  t.forEach((c, i) => {
    if (i) out.push(mix(t[i - 1], c, 0.5));
    out.push(c);
  });
  return [...out, p.pal.accent, p.pal.light, ...own.map((c) => mix(c, toneAt(t, ...c), TONE))];
}

// How much the farthest layer fades toward the sky colour (aerial perspective), so the plate's
// distance reads the way the procedural ridges do; nearer layers fade less, the nearest not at all.
const HAZE = 0.3;
// How far plate colours are pulled toward the palette ramp at their brightness before snapping
// to the nearest palette colour: 0 keeps FLUX's own hues, 1 is a pure gradient map.
const TONE = 0.35;
// How many of the plate's own colours join the palette.
const OWN = 12;

export function quantizePlate(id: string, img: PlateImage, p: WorldParams): PlateLayers {
  const ramp = tones(p);
  const pal = snapPalette(p, ramp, dominant(img, OWN));
  const hazeCol = mix(p.pal.skyBot, p.pal.far, 0.5);
  const n = img.layers.length;
  const layers = img.layers.map((src, li) => {
    const haze = n > 1 ? HAZE * (1 - li / (n - 1)) : 0;
    const out = new Uint32Array(PLATE_W * PLATE_H);
    for (let y = 0; y < PLATE_H; y++) {
      for (let x = 0; x < PLATE_W; x++) {
        const i = y * PLATE_W + x;
        if (src[i * 4 + 3] < 128) continue;
        let r = src[i * 4];
        let g = src[i * 4 + 1];
        let b = src[i * 4 + 2];
        const gm = toneAt(ramp, r, g, b);
        r += (gm[0] - r) * TONE + (hazeCol[0] - r) * haze;
        g += (gm[1] - g) * TONE + (hazeCol[1] - g) * haze;
        b += (gm[2] - b) * TONE + (hazeCol[2] - b) * haze;
        // Nearest two palette colours, ordered-dithered by how close the second one is.
        let a = 0;
        let c = 0;
        let da = Infinity;
        let dc = Infinity;
        for (let k = 0; k < pal.length; k++) {
          const d = dist2(pal[k], r, g, b);
          if (d < da) {
            c = a;
            dc = da;
            a = k;
            da = d;
          } else if (d < dc) {
            c = k;
            dc = d;
          }
        }
        const t = Math.sqrt(da) / (Math.sqrt(da) + Math.sqrt(dc) + 1e-6);
        out[i] = pack(pal[bayer(x, y) < t ? c : a]);
      }
    }
    return out;
  });
  const top = img.horizon === null ? OY : Math.round(Math.min(OY_MAX, Math.max(OY_MIN, img.horizon - HORIZON)));
  const rows = layers.map((l) => {
    const r = new Uint8Array(PLATE_H);
    for (let y = 0; y < PLATE_H; y++) {
      const row = l.subarray(y * PLATE_W, (y + 1) * PLATE_W);
      r[y] = row.every((v) => v !== 0) ? SOLID : row.every((v) => v === 0) ? EMPTY : 0;
    }
    return r;
  });
  return { id, layers, top, rows };
}

// How far each layer, far to near, slides with the camera; matches the procedural ridges.
const PARALLAX: Record<number, number[]> = { 1: [1], 2: [0.3, 1], 3: [0.2, 0.55, 1], 4: [0.15, 0.35, 0.65, 1] };

// Out-of-range columns mirror back into the plate: a pan transition that runs past the edge keeps
// showing landscape instead of a smeared edge column.
function mirror(v: number, n: number): number {
  const m = ((v % (2 * n)) + 2 * n) % (2 * n);
  return m < n ? m : 2 * n - 1 - m;
}

const cols = [new Int32Array(PW), new Int32Array(PW), new Int32Array(PW), new Int32Array(PW)];
const EMPTY = 1;
const SOLID = 2;
const srcRows = new Int32Array(4 * PH);
const rowFrom = new Int8Array(PH);

export function drawPlate(c: SceneCtx, plate: PlateLayers, setting: Setting): void {
  const { fb } = c;
  const data = fb.data;
  const n = plate.layers.length;
  const depths = PARALLAX[n] ?? PARALLAX[3];
  for (let li = 0; li < n; li++) {
    const d = depths[li];
    for (let px = 0; px < PW; px++) cols[li][px] = mirror(Math.floor(px / K - c.camX * d) + OX, PLATE_W);
  }
  // Per screen row, the nearest layer that covers it whole: the layers behind it, and the sky,
  // can't show there.
  const from = rowFrom;
  let covered = fb.h;
  for (let py = fb.h - 1; py >= 0; py--) {
    from[py] = -1;
    for (let li = 0; li < n; li++) {
      let sy = Math.floor(py / K - c.camY * depths[li] - c.tilt) + plate.top;
      // Above the plate is sky. Below it, the nearest layer's bottom row continues so the ground
      // never ends; the others stop and leave the layer in front to cover them.
      if (sy >= PLATE_H) sy = li === n - 1 ? PLATE_H - 1 : -1;
      const state = sy >= 0 ? plate.rows[li][sy] : EMPTY;
      srcRows[li * fb.h + py] = state === EMPTY ? -1 : sy;
      if (state === SOLID) from[py] = li;
    }
    if (from[py] >= 0 && covered === py + 1) covered = py;
  }
  drawSky(c, setting, Math.ceil(covered / K));
  for (let py = 0; py < fb.h; py++) {
    const row = py * PW;
    for (let li = Math.max(0, from[py]); li < n; li++) {
      const sy = srcRows[li * fb.h + py];
      if (sy < 0) continue;
      const layer = plate.layers[li];
      const src = sy * PLATE_W;
      const col = cols[li];
      for (let px = 0; px < PW; px++) {
        const v = layer[src + col[px]];
        if (v) data[row + px] = v;
      }
    }
  }
}
