import { clamp, mix, type RGB } from "./fb";
import type { WorldParams } from "./palette";

// One light model for every subject: an ambient fill tinted by the sky, plus a key light from
// the sun or moon's side. Night keeps subjects readable but cool and dim instead of black.
export interface Light {
  amb: [number, number, number];
  key: [number, number, number];
  // -1: the key light comes from the left, 1: from the right.
  dir: number;
}

const hue = (c: RGB): [number, number, number] => {
  const m = Math.max(1, c[0], c[1], c[2]);
  return [c[0] / m, c[1] / m, c[2] / m];
};

export function sceneLight(p: WorldParams): Light {
  const day = clamp(p.daylight);
  const sky = hue(mix(p.pal.skyTop, p.pal.skyBot, 0.6));
  const level = 0.3 + 0.36 * day;
  const tintK = 0.5 - 0.25 * day;
  const warm = p.lights * (1 - day) * 0.1;
  const amb: [number, number, number] = [
    level * (1 - tintK + tintK * sky[0]) + warm,
    level * (1 - tintK + tintK * sky[1]) + warm * 0.75,
    level * (1 - tintK + tintK * sky[2]) + warm * 0.4,
  ];
  const sun = hue(mix(p.pal.sun, [255, 255, 255], 0.45));
  const strength = Math.max(p.sunAlpha * 0.72, p.moonAlpha * 0.32, 0.14);
  return { amb, key: [sun[0] * strength, sun[1] * strength, sun[2] * strength], dir: p.celestialX < 0.5 ? -1 : 1 };
}

// k from -1 (turned away from the key light) to 1 (facing it). haze pulls distant subjects
// toward the far-layer colour, so a figure on the horizon sits in the air instead of on it.
export function lit(L: Light, base: RGB, k: number, haze = 0, hazeCol: RGB = [0, 0, 0]): RGB {
  const f = clamp(0.5 + 0.5 * k);
  let r = base[0] * (L.amb[0] + L.key[0] * f);
  let g = base[1] * (L.amb[1] + L.key[1] * f);
  let b = base[2] * (L.amb[2] + L.key[2] * f);
  if (haze > 0) {
    r += (hazeCol[0] - r) * haze;
    g += (hazeCol[1] - g) * haze;
    b += (hazeCol[2] - b) * haze;
  }
  return [Math.min(255, Math.round(r)), Math.min(255, Math.round(g)), Math.min(255, Math.round(b))];
}

export const hexRgb = (h: string): RGB => {
  const x = h.replace("#", "");
  const f = x.length === 3 ? x.split("").map((c) => c + c).join("") : x;
  const v: RGB = [parseInt(f.slice(0, 2), 16), parseInt(f.slice(2, 4), 16), parseInt(f.slice(4, 6), 16)];
  return v.some(Number.isNaN) ? [128, 128, 128] : v;
};
