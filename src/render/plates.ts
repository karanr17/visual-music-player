import { z } from "zod";
import type { SceneScript } from "../scene/schema";
import { SETTINGS, type Setting } from "../scene/vocab";
import { DEPTH_SETTINGS, drawSky, type SceneCtx } from "./backdrops";
import { bayer, H, K, mix, pack, PW, W, type RGB } from "./fb";
import type { WorldParams } from "./palette";

// Illustrated mode: per-section backdrop plates made offline by scripts/plates (FLUX.1-schnell),
// split into parallax layers there and quantised to the world's palette here, so the same plate
// follows a look or time-of-day change without being regenerated.

// Plates are authored at logical resolution with a margin round the 320x180 frame, so the camera
// can drift and tilt without showing an edge.
export const PLATE_W = 384;
export const PLATE_H = 216;
const OX = (PLATE_W - W) / 2;
const OY = (PLATE_H - H) / 2;
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
  plates: z.record(z.string(), z.object({ prompt: z.string(), seed: z.number(), layers: z.array(DataUrl).min(1).max(4) })),
  // One entry per script section. prompt is the section's world.plate as the generator saw it
  // (empty for scripts without one), so a regenerated or edited script doesn't pick up stale art.
  sections: z.array(z.object({ setting: z.enum(SETTINGS), prompt: z.string(), plate: z.string().nullable() })),
});
export type PlateSet = z.infer<typeof PlateSet>;

// Decoded RGBA, far to near, each PLATE_W x PLATE_H.
export interface PlateImage {
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

// What pixels snap to: the tones with a step between each pair, plus the world's accents.
function snapPalette(p: WorldParams, t: RGB[]): RGB[] {
  const out: RGB[] = [];
  t.forEach((c, i) => {
    if (i) out.push(mix(t[i - 1], c, 0.5));
    out.push(c);
  });
  return [...out, p.pal.accent, p.pal.water, p.pal.cloud, p.pal.light];
}

// How much the farthest layer fades toward the sky colour (aerial perspective), so the plate's
// distance reads the way the procedural ridges do; nearer layers fade less, the nearest not at all.
const HAZE = 0.4;
// How far plate colours are pulled toward the palette ramp at their brightness before snapping
// to the nearest palette colour: 0 keeps FLUX's own hues, 1 is a pure gradient map.
const TONE = 0.55;

export function quantizePlate(id: string, img: PlateImage, p: WorldParams): PlateLayers {
  const ramp = tones(p);
  const pal = snapPalette(p, ramp);
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
        // Gradient map: the tone at this pixel's brightness.
        const pos = ((0.299 * r + 0.587 * g + 0.114 * b) / 255) * (ramp.length - 1);
        const j = Math.min(ramp.length - 2, Math.floor(pos));
        const gm = mix(ramp[j], ramp[j + 1], pos - j);
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
  return { id, layers };
}

// How far each layer, far to near, slides with the camera; matches the procedural ridges.
const PARALLAX: Record<number, number[]> = { 1: [1], 2: [0.3, 1], 3: [0.2, 0.55, 1], 4: [0.15, 0.35, 0.65, 1] };

// Out-of-range columns mirror back into the plate: a pan transition that runs past the edge keeps
// showing landscape instead of a smeared edge column.
function mirror(v: number, n: number): number {
  const m = ((v % (2 * n)) + 2 * n) % (2 * n);
  return m < n ? m : 2 * n - 1 - m;
}

const cols = new Int32Array(PW);

export function drawPlate(c: SceneCtx, plate: PlateLayers, setting: Setting): void {
  drawSky(c, setting);
  const { fb } = c;
  const data = fb.data;
  const depths = PARALLAX[plate.layers.length] ?? PARALLAX[3];
  plate.layers.forEach((layer, li) => {
    const d = depths[li];
    const near = li === plate.layers.length - 1;
    for (let px = 0; px < PW; px++) cols[px] = mirror(Math.floor(px / K - c.camX * d) + OX, PLATE_W);
    for (let py = 0; py < fb.h; py++) {
      let sy = Math.floor(py / K - c.camY * d - c.tilt) + OY;
      // Above the plate is sky. Below it, the nearest layer's bottom row continues so the ground
      // never ends; the others stop and leave the layer in front to cover them.
      if (sy < 0) continue;
      if (sy >= PLATE_H) {
        if (!near) continue;
        sy = PLATE_H - 1;
      }
      const src = sy * PLATE_W;
      const row = py * PW;
      for (let px = 0; px < PW; px++) {
        const v = layer[src + cols[px]];
        if (v) data[row + px] = v;
      }
    }
  });
}
