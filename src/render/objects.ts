import { mix, type RGB } from "./fb";
import { lit } from "./lighting";
import { hash1 } from "./noise";
import type { SpriteCtx } from "./sprites";

// Real-world objects drawn from materials (bark, leaves, brick, paint, glass) under the scene's
// light, instead of flat silhouettes. Each takes the ground point (x, y) and a scale s.

const paintOf = (c: SpriteCtx) => (base: RGB, k: number): RGB => c.solid ?? lit(c.light, base, k, c.haze, c.hazeCol);
const pickOf = <T,>(a: T[], seed: number, k = 0): T => a[Math.floor(hash1(Math.floor(seed * 977) + k * 131) * a.length)];

const BARK: RGB = [104, 74, 52];
const LEAF: RGB = [76, 128, 64];

export function tree(c: SpriteCtx, x: number, y: number, s: number, a: number, seed: number): void {
  const p = paintOf(c);
  const { fb } = c;
  const h = 30 * s;
  const tw = 2.2 * s;
  fb.poly([[x - tw, y], [x + tw, y], [x + tw * 0.5, y - h * 0.62], [x - tw * 0.5, y - h * 0.62]], p(BARK, -0.4), a);
  fb.poly([[x + c.light.dir * tw * 0.1, y], [x + c.light.dir * tw, y], [x + c.light.dir * tw * 0.5, y - h * 0.62], [x, y - h * 0.62]], p(BARK, 0.4), a);
  fb.line(x, y - h * 0.45, x - 5 * s, y - h * 0.68, p(BARK, -0.2), a, s * 1.2);
  fb.line(x, y - h * 0.5, x + 4.5 * s, y - h * 0.72, p(BARK, -0.2), a, s * 1.1);
  // Foliage as overlapping leaf clusters: shadow pass, body pass toward the light, then glints.
  const cy = y - h * 0.74;
  const leaf = mix(LEAF, c.pal.near, 0.15);
  const sway = Math.sin(c.t * 1.2 + seed) * (0.6 + c.energy * 0.8) * s * 0.4;
  const clusters: [number, number, number][] = [];
  for (let i = 0; i < 16; i++) {
    const ang = hash1(seed * 31 + i) * Math.PI * 2;
    const rad = Math.sqrt(hash1(seed * 17 + i * 3));
    clusters.push([x + Math.cos(ang) * rad * 10 * s, cy + Math.sin(ang) * rad * 7.5 * s, (3.6 + hash1(i * 7 + seed) * 2.4) * s]);
  }
  clusters.sort((m, n) => m[1] - n[1]);
  for (const [cx, cy2, r] of clusters) fb.circle(cx + sway * (cy - cy2 + 8 * s) / (16 * s), cy2 + r * 0.25, r, p(leaf, -0.75), a);
  for (const [cx, cy2, r] of clusters) fb.circle(cx + sway * (cy - cy2 + 8 * s) / (16 * s) + c.light.dir * r * 0.22, cy2 - r * 0.18, r * 0.74, p(leaf, 0.1), a);
  for (const [cx, cy2, r] of clusters) fb.circle(cx + sway * (cy - cy2 + 8 * s) / (16 * s) + c.light.dir * r * 0.4, cy2 - r * 0.42, r * 0.32, p(mix(leaf, [190, 220, 120], 0.25), 0.9), a);
}

export function deadTree(c: SpriteCtx, x: number, y: number, s: number, a: number, seed: number): void {
  const p = paintOf(c);
  const wood: RGB = [112, 98, 90];
  const branch = (bx: number, by: number, ang: number, len: number, w: number, depth: number) => {
    if (depth === 0 || len < 1) return;
    const ex = bx + Math.sin(ang) * len;
    const ey = by - Math.cos(ang) * len;
    c.fb.line(bx, by, ex, ey, p(wood, -0.35), a, w);
    if (w > 1.2) c.fb.line(bx + c.light.dir * w * 0.25, by, ex + c.light.dir * w * 0.25, ey, p(wood, 0.6), a, w * 0.35);
    const j = (hash1(seed * 13 + depth * 7 + Math.round(len)) - 0.5) * 0.3;
    branch(ex, ey, ang - 0.5 + j, len * 0.72, w * 0.62, depth - 1);
    branch(ex, ey, ang + 0.42 + j, len * 0.66, w * 0.58, depth - 1);
  };
  branch(x, y, 0.04, 14 * s, 3.2 * s, 5);
}

const WALLS: RGB[] = [[222, 206, 170], [176, 92, 68], [150, 164, 176], [232, 226, 214], [196, 168, 120]];
const ROOFS: RGB[] = [[122, 54, 46], [72, 76, 94], [92, 62, 48], [56, 84, 86]];

export function house(c: SpriteCtx, x: number, y: number, s: number, a: number, seed: number): void {
  const p = paintOf(c);
  const { fb } = c;
  const w = 28 * s;
  const wh = 17 * s;
  const rh = 12 * s;
  const wall = pickOf(WALLS, seed, 1);
  const roof = pickOf(ROOFS, seed, 2);
  const l = x - w / 2;
  const top = y - wh;
  fb.rect(l, top, w, wh, p(wall, -0.1), a);
  // The wall darkens toward the side away from the light.
  fb.rect(c.light.dir > 0 ? l : l + w * 0.8, top, w * 0.2, wh, p(wall, -0.55), a);
  fb.rect(l, y - 1.2 * s, w, 1.2 * s, p(wall, -0.8), a);
  // Chimney, then the roof over it.
  const chx = x + (hash1(seed * 5) > 0.5 ? 1 : -1) * w * 0.25;
  fb.rect(chx - 1.8 * s, top - rh * 0.95, 3.6 * s, rh * 0.8, p([150, 80, 64], -0.2), a);
  fb.poly([[l - 2.5 * s, top], [x, top - rh], [l + w + 2.5 * s, top]], p(roof, -0.45), a);
  const litX = c.light.dir < 0 ? l - 2.5 * s : l + w + 2.5 * s;
  fb.poly([[x, top - rh], [litX, top], [x + (litX - x) * 0.05, top]], p(roof, 0.45), a);
  fb.line(l - 2.5 * s, top, l + w + 2.5 * s, top, p(roof, -0.9), a, 1.2 * s);
  for (let k = 1; k < 4; k++) {
    const yy = top - rh + (rh * k) / 4;
    const half = ((w / 2 + 2.5 * s) * k) / 4;
    fb.line(x - half, yy, x + half, yy, p(roof, -0.7), a * 0.6, 0.5 * s);
  }
  // Windows: glass reflects the sky by day and glows warm when the lights are on.
  const on = c.lights > 0.3 && hash1(seed * 3 + 1) < 0.85;
  const glass = (gx: number, gy: number, gw: number, gh: number) => {
    fb.rect(gx - 0.8 * s, gy - 0.8 * s, gw + 1.6 * s, gh + 1.6 * s, p([236, 232, 222], 0), a);
    if (on) {
      fb.rect(gx, gy, gw, gh, mix(c.pal.light, [255, 236, 180], 0.4), a);
      fb.glow(gx + gw / 2, gy + gh / 2, gw * 1.6, c.pal.light, 0.25 * c.lights * a);
    } else {
      fb.rect(gx, gy, gw, gh, p(mix(c.pal.skyBot, c.pal.skyTop, 0.4), 0.2), a);
      fb.line(gx + gw * 0.2, gy + gh * 0.9, gx + gw * 0.7, gy + gh * 0.1, p([255, 255, 255], 0.4), a * 0.5, 0.6 * s);
    }
    fb.rect(gx + gw / 2 - 0.3 * s, gy, 0.6 * s, gh, p([236, 232, 222], -0.2), a);
  };
  glass(l + 3.5 * s, top + 4 * s, 6 * s, 5.5 * s);
  glass(l + w - 9.5 * s, top + 4 * s, 6 * s, 5.5 * s);
  const door: RGB = [110, 70, 44];
  fb.rect(x - 2.8 * s, y - 9.5 * s, 5.6 * s, 9.5 * s, p(door, -0.3), a);
  fb.rect(x - 2.2 * s, y - 8.8 * s, 2 * s, 3.6 * s, p(door, 0.2), a);
  fb.rect(x + 0.2 * s, y - 8.8 * s, 2 * s, 3.6 * s, p(door, 0.2), a);
  fb.circle(x + 1.8 * s, y - 4.5 * s, 0.5 * s, p([220, 190, 90], 0.6), a);
  if (c.lights > 0.4 || c.daylight < 0.3) {
    // Chimney smoke drifts up and thins out.
    for (let i = 0; i < 6; i++) {
      const ph = (c.t * 0.25 + i / 6) % 1;
      fb.circle(chx + Math.sin(ph * 6 + seed) * 2 * s + ph * 6 * s, top - rh - ph * 18 * s, (1 + ph * 2.5) * s, mix(c.pal.fog, c.pal.skyBot, 0.4), a * (1 - ph) * 0.5);
    }
  }
}

const PAINTS: RGB[] = [[178, 40, 44], [40, 82, 150], [228, 228, 222], [36, 38, 44], [214, 170, 60], [70, 120, 90]];

function wheel(c: SpriteCtx, x: number, y: number, r: number, a: number, spin: number): void {
  const p = paintOf(c);
  c.fb.circle(x, y, r, p([28, 28, 32], 0), a);
  c.fb.circle(x, y, r * 0.55, p([170, 172, 178], 0.2), a);
  for (let i = 0; i < 3; i++) {
    const ang = spin + (i * Math.PI * 2) / 3;
    c.fb.line(x, y, x + Math.cos(ang) * r * 0.5, y + Math.sin(ang) * r * 0.5, p([90, 92, 98], 0), a, Math.max(0.5, r * 0.18));
  }
  c.fb.circle(x - r * 0.15, y - r * 0.2, r * 0.18, p([240, 240, 244], 0.9), a);
}

export function carSide(c: SpriteCtx, x: number, y: number, s: number, a: number, seed: number, flip: boolean, moving: boolean): void {
  const p = paintOf(c);
  const { fb } = c;
  const d = flip ? -1 : 1;
  const body = pickOf(PAINTS, seed, 3);
  const X = (o: number) => x + o * s * d;
  const wr = 2.8 * s;
  const base = y - wr * 0.85;
  fb.poly([[X(-17), base], [X(17), base], [X(17.5), base - 5 * s], [X(13), base - 7.5 * s], [X(-15), base - 7.5 * s], [X(-17.5), base - 5 * s]], p(body, -0.15), a);
  fb.poly([[X(-10), base - 7.5 * s], [X(7), base - 7.5 * s], [X(3), base - 13 * s], [X(-7), base - 13 * s]], p(body, -0.25), a);
  // Glass shows a sliver of sky.
  const glass = p(mix(c.pal.skyBot, c.pal.skyTop, 0.5), 0.3);
  fb.poly([[X(-8.8), base - 8 * s], [X(-1.8), base - 8 * s], [X(-1.8), base - 12.2 * s], [X(-6.3), base - 12.2 * s]], glass, a);
  fb.poly([[X(-0.6), base - 8 * s], [X(5.7), base - 8 * s], [X(2.4), base - 12.2 * s], [X(-0.6), base - 12.2 * s]], glass, a);
  fb.line(X(-7), base - 12.5 * s, X(3), base - 12.5 * s, p(body, 0.9), a, 0.6 * s);
  fb.line(X(-16), base - 6.8 * s, X(13), base - 6.8 * s, p(body, 0.85), a, 0.7 * s);
  fb.line(X(-17), base - 0.4 * s, X(17), base - 0.4 * s, p(body, -0.85), a, 0.9 * s);
  fb.line(X(-1.2), base - 7 * s, X(-1.2), base - 1 * s, p(body, -0.7), a, 0.4 * s);
  const head = mix([255, 240, 190], c.pal.light, 0.3);
  fb.rect(Math.min(X(16.2), X(17.5)), base - 5 * s, 1.3 * s, 1.6 * s, head, a);
  fb.rect(Math.min(X(-17.6), X(-16.4)), base - 5 * s, 1.2 * s, 1.6 * s, [220, 40, 40], a);
  if (c.lights > 0.4) fb.glow(X(18.5), base - 4 * s, 10 * s, head, 0.35 * a * c.lights);
  const spin = moving ? c.t * 9 * d : 0;
  wheel(c, X(-10.5), y - wr, wr, a, spin);
  wheel(c, X(10.5), y - wr, wr, a, spin);
}

export function carRear(c: SpriteCtx, x: number, y: number, s: number, a: number, seed: number): void {
  const p = paintOf(c);
  const { fb } = c;
  const body = pickOf(PAINTS, seed, 3);
  const by = y - Math.abs(Math.sin(c.t * 9 + seed)) * 0.3 * s;
  fb.rect(x - 10 * s, by - 3 * s, 3.4 * s, 3 * s, p([28, 28, 32], 0), a);
  fb.rect(x + 6.6 * s, by - 3 * s, 3.4 * s, 3 * s, p([28, 28, 32], 0), a);
  fb.poly([[x - 11 * s, by - 2.5 * s], [x + 11 * s, by - 2.5 * s], [x + 11 * s, by - 9 * s], [x - 11 * s, by - 9 * s]], p(body, -0.2), a);
  fb.poly([[x - 8.5 * s, by - 9 * s], [x + 8.5 * s, by - 9 * s], [x + 6.5 * s, by - 15 * s], [x - 6.5 * s, by - 15 * s]], p(body, -0.3), a);
  fb.poly([[x - 7.4 * s, by - 9.6 * s], [x + 7.4 * s, by - 9.6 * s], [x + 5.8 * s, by - 14.2 * s], [x - 5.8 * s, by - 14.2 * s]], p(mix(c.pal.skyBot, [20, 24, 34], 0.6), 0.2), a);
  fb.line(x - 11 * s, by - 8.6 * s, x + 11 * s, by - 8.6 * s, p(body, 0.85), a, 0.6 * s);
  fb.rect(x - 11 * s, by - 3.4 * s, 22 * s, 1.4 * s, p([40, 40, 46], -0.2), a);
  fb.rect(x - 2.6 * s, by - 6.4 * s, 5.2 * s, 2 * s, p([232, 232, 220], 0.2), a);
  const tail: RGB = [235, 44, 40];
  fb.rect(x - 10.6 * s, by - 7.6 * s, 3.6 * s, 1.8 * s, tail, a);
  fb.rect(x + 7 * s, by - 7.6 * s, 3.6 * s, 1.8 * s, tail, a);
  if (c.daylight < 0.7) for (const sd of [-1, 1]) fb.glow(x + sd * 8.8 * s, by - 6.7 * s, 7 * s, tail, 0.4 * a * (1 - c.daylight));
}

export function streetLamp(c: SpriteCtx, x: number, y: number, s: number, a: number): void {
  const p = paintOf(c);
  const { fb } = c;
  const metal: RGB = [54, 66, 62];
  const top = y - 32 * s;
  fb.rect(x - 1.6 * s, y - 2.5 * s, 3.2 * s, 2.5 * s, p(metal, -0.3), a);
  fb.line(x, y - 2, x, top, p(metal, -0.3), a, 1.3 * s);
  fb.line(x + c.light.dir * 0.35 * s, y - 2, x + c.light.dir * 0.35 * s, top, p(metal, 0.7), a, 0.4 * s);
  fb.line(x, top, x + 2 * s, top - 1.5 * s, p(metal, -0.2), a, 0.9 * s);
  fb.line(x + 2 * s, top - 1.5 * s, x + 5 * s, top - 0.5 * s, p(metal, -0.2), a, 0.9 * s);
  fb.poly([[x + 3 * s, top], [x + 7 * s, top], [x + 6 * s, top - 1.6 * s], [x + 4 * s, top - 1.6 * s]], p(metal, 0), a);
  fb.rect(x + 3.4 * s, top, 3.2 * s, 2.2 * s, mix(c.pal.light, [255, 240, 200], 0.4), a);
  if (c.lights > 0.2) {
    fb.glow(x + 5 * s, top + 2 * s, 18 * s, c.pal.light, 0.4 * a * c.lights);
    for (let i = 0; i < 28 * s; i++) {
      const w = i * 0.6;
      fb.rect(x + 5 * s - w, top + 2 * s + i, w * 2, 1, c.pal.light, 0.07 * a * c.lights);
    }
  }
}

export function bench(c: SpriteCtx, x: number, y: number, s: number, a: number): void {
  const p = paintOf(c);
  const { fb } = c;
  const wood: RGB = [146, 98, 60];
  const iron: RGB = [44, 44, 50];
  for (const lx of [-8, 7]) {
    fb.line(x + lx * s, y, x + lx * s, y - 5 * s, p(iron, -0.2), a, 0.9 * s);
    fb.line(x + lx * s, y - 5 * s, x + (lx + 0.6) * s, y - 11 * s, p(iron, -0.2), a, 0.8 * s);
  }
  for (let k = 0; k < 2; k++) fb.rect(x - 10 * s, y - 5.4 * s - k * 1.1 * s, 20 * s, 0.9 * s, p(wood, k ? 0.5 : 0), a);
  for (let k = 0; k < 3; k++) fb.rect(x - 9.6 * s, y - 8 * s - k * 1.4 * s, 19.6 * s, 1 * s, p(wood, 0.2 - k * 0.15), a);
}

export function boat(c: SpriteCtx, x: number, y: number, s: number, a: number, flip: boolean): void {
  const p = paintOf(c);
  const { fb } = c;
  const d = flip ? -1 : 1;
  const wood: RGB = [128, 82, 48];
  const bob = Math.sin(c.t * 1.6) * 0.6 * s;
  const by = y + bob;
  fb.poly([[x - 13 * s * d, by - 4 * s], [x + 13 * s * d, by - 4 * s], [x + 9 * s * d, by], [x - 10 * s * d, by]], p(wood, -0.2), a);
  fb.line(x - 12 * s * d, by - 2.6 * s, x + 11.5 * s * d, by - 2.6 * s, p(wood, -0.6), a, 0.4 * s);
  fb.line(x - 13 * s * d, by - 4 * s, x + 13 * s * d, by - 4 * s, p(wood, 0.7), a, 0.6 * s);
  fb.line(x, by - 4 * s, x, by - 22 * s, p(wood, -0.1), a, 0.8 * s);
  const cloth: RGB = [236, 230, 214];
  fb.poly([[x + 0.6 * s * d, by - 21 * s], [x + 0.6 * s * d, by - 5.5 * s], [x + 10 * s * d, by - 5.5 * s]], p(cloth, d === c.light.dir ? 0.5 : -0.2), a);
  fb.poly([[x - 0.6 * s * d, by - 18 * s], [x - 0.6 * s * d, by - 5.5 * s], [x - 7 * s * d, by - 5.5 * s]], p(cloth, d === c.light.dir ? -0.3 : 0.5), a);
  // A dark reflection under the hull settles it on the water.
  fb.shadow(x, by + 0.8 * s, 13 * s, 1.6 * s, 0.35 * a);
}

export function sunflower(c: SpriteCtx, x: number, y: number, s: number, a: number, seed: number): void {
  const p = paintOf(c);
  const { fb } = c;
  const stem: RGB = [72, 128, 60];
  const sway = Math.sin(c.t * 1.3 + seed) * 0.8 * s;
  const hx = x + sway;
  const hy = y - 26 * s;
  fb.line(x, y, hx, hy + 3 * s, p(stem, -0.2), a, 1.1 * s);
  for (const [ly, dir] of [[0.45, -1], [0.62, 1]] as const) {
    const sx = x + (hx - x) * ly;
    const sy = y - 26 * s * ly;
    fb.poly([[sx, sy], [sx + dir * 6 * s, sy - 3 * s], [sx + dir * 8 * s, sy - 0.5 * s], [sx + dir * 3 * s, sy + 1 * s]], p(stem, dir === c.light.dir ? 0.4 : -0.3), a);
  }
  const petal: RGB = [246, 196, 40];
  for (let i = 0; i < 16; i++) {
    const ang = (i / 16) * Math.PI * 2 + seed;
    const r = 5.6 * s;
    fb.ellipse(hx + Math.cos(ang) * r, hy + Math.sin(ang) * r * 0.92, 2.3 * s, 2.3 * s, p(petal, Math.cos(ang) * c.light.dir * 0.8 - 0.1 + (i % 2) * 0.2), a);
  }
  fb.circle(hx, hy, 4.3 * s, p([92, 54, 28], -0.3), a);
  for (let i = 0; i < 18; i++) {
    const ang = i * 2.4;
    const r = Math.sqrt(i / 18) * 3.6 * s;
    fb.circle(hx + Math.cos(ang) * r, hy + Math.sin(ang) * r, 0.45 * s, p([140, 92, 44], 0.3), a);
  }
}

export function flower(c: SpriteCtx, x: number, y: number, s: number, a: number, kind: "flower" | "rose" | "wilted_flower", seed: number): void {
  const p = paintOf(c);
  const { fb } = c;
  const stem: RGB = kind === "wilted_flower" ? [110, 112, 70] : [72, 128, 60];
  const bloom: RGB = kind === "rose" ? [196, 30, 50] : kind === "wilted_flower" ? [150, 110, 120] : mix(c.pal.accent, [240, 120, 170], 0.4);
  const h = 13 * s;
  const droop = kind === "wilted_flower";
  const hx = x + (droop ? 3.5 * s : Math.sin(c.t * 1.4 + seed) * 0.5 * s);
  const hy = y - (droop ? h * 0.75 : h);
  fb.line(x, y, x + (droop ? 1.5 * s : 0), y - h * 0.8, p(stem, -0.2), a, 0.8 * s);
  if (droop) fb.line(x + 1.5 * s, y - h * 0.8, hx, hy, p(stem, -0.2), a, 0.7 * s);
  fb.poly([[x, y - h * 0.35], [x + 3.5 * s, y - h * 0.55], [x + 1 * s, y - h * 0.3]], p(stem, 0.3), a);
  if (kind === "rose") {
    fb.circle(hx, hy, 2.6 * s, p(bloom, -0.4), a);
    fb.circle(hx + c.light.dir * 0.5 * s, hy - 0.5 * s, 1.8 * s, p(bloom, 0.2), a);
    fb.line(hx - 1 * s, hy, hx + 1 * s, hy - 0.8 * s, p(bloom, -0.8), a, 0.4 * s);
    fb.circle(hx + c.light.dir * 0.8 * s, hy - 1 * s, 0.6 * s, p(bloom, 0.9), a);
  } else {
    for (let i = 0; i < 5; i++) {
      const ang = (i / 5) * Math.PI * 2 + (droop ? 1.2 : -Math.PI / 2);
      fb.circle(hx + Math.cos(ang) * 1.9 * s, hy + Math.sin(ang) * 1.9 * s, 1.5 * s, p(bloom, Math.cos(ang) * c.light.dir * 0.7), a);
    }
    fb.circle(hx, hy, 1 * s, p([240, 200, 70], 0.4), a);
  }
}

export function door(c: SpriteCtx, x: number, y: number, s: number, a: number): void {
  const p = paintOf(c);
  const { fb } = c;
  const frame: RGB = [214, 208, 196];
  const wood: RGB = [116, 74, 46];
  fb.rect(x - 6 * s, y - 24 * s, 12 * s, 24 * s, p(frame, 0), a);
  fb.rect(x - 4.6 * s, y - 22.6 * s, 9.2 * s, 22.6 * s, p(wood, -0.3), a);
  for (const [px, py, ph] of [[-3.8, -21.6, 9], [0.4, -21.6, 9], [-3.8, -10.4, 9], [0.4, -10.4, 9]]) fb.rect(x + px * s, y + py * s, 3.4 * s, ph * s, p(wood, 0.25), a);
  fb.circle(x + 3.2 * s, y - 11 * s, 0.6 * s, p([226, 196, 96], 0.7), a);
  if (c.lights > 0.4) fb.rect(x - 4.6 * s, y - 0.8 * s, 9.2 * s, 0.8 * s, mix(c.pal.light, [255, 240, 200], 0.4), a);
}

const FURS: RGB[] = [[196, 148, 82], [110, 72, 44], [40, 36, 36], [214, 206, 190]];

export function dog(c: SpriteCtx, x: number, y: number, s: number, a: number, seed: number, flip: boolean, moving: boolean, ph: number): void {
  const p = paintOf(c);
  const { fb } = c;
  const d = flip ? -1 : 1;
  const fur = pickOf(FURS, seed, 4);
  const bob = moving ? Math.abs(Math.sin(ph)) * 0.6 * s : 0;
  const by = y - 6 * s - bob;
  const legs = [[-4.2, 0], [-2.6, Math.PI], [3, Math.PI], [4.6, 0]] as const;
  legs.forEach(([lx, o], i) => {
    const sw = moving ? Math.sin(ph + o) * 0.45 : 0;
    fb.line(x + lx * s * d, by + 1.5 * s, x + lx * s * d + Math.sin(sw) * 3 * s * d, y, p(fur, i % 2 ? -0.6 : -0.1), a, 1.2 * s);
  });
  fb.ellipse(x, by, 6.6 * s, 3 * s, p(fur, -0.3), a);
  fb.ellipse(x + c.light.dir * 0.8 * s, by - 0.8 * s, 5.4 * s, 1.8 * s, p(fur, 0.35), a);
  const wag = Math.sin(c.t * (moving ? 12 : 6) + seed) * 0.5;
  fb.line(x - 6 * s * d, by - 1 * s, x - (8.5 + wag) * s * d, by - 4.5 * s, p(fur, -0.1), a, 1 * s);
  const hx = x + 6.8 * s * d;
  const hy = by - 3.5 * s;
  fb.circle(hx, hy, 2.8 * s, p(fur, -0.1), a);
  fb.ellipse(hx + 2.6 * s * d, hy + 0.9 * s, 1.8 * s, 1.2 * s, p(fur, 0.1), a);
  fb.circle(hx + 4.2 * s * d, hy + 0.5 * s, 0.6 * s, p([30, 26, 26], 0), a);
  fb.ellipse(hx - 1.2 * s * d, hy - 0.6 * s, 1 * s, 2.2 * s, p(fur, -0.7), a);
  if (s >= 1) fb.circle(hx + 1 * s * d, hy - 0.6 * s, 0.4 * s, p([20, 18, 18], 0), a);
}

export function cat(c: SpriteCtx, x: number, y: number, s: number, a: number, seed: number, flip: boolean, moving: boolean, ph: number): void {
  const p = paintOf(c);
  const { fb } = c;
  const d = flip ? -1 : 1;
  const fur = pickOf([[110, 110, 118], [214, 140, 70], [36, 32, 36], [226, 220, 210]] as RGB[], seed, 5);
  const by = y - 4.6 * s;
  for (const [lx, o] of [[-3.4, 0], [-2.2, Math.PI], [2.4, Math.PI], [3.6, 0]] as const) {
    const sw = moving ? Math.sin(ph + o) * 0.4 : 0;
    fb.line(x + lx * s * d, by + 1 * s, x + lx * s * d + Math.sin(sw) * 2.4 * s * d, y, p(fur, -0.3), a, 0.9 * s);
  }
  fb.ellipse(x, by, 5 * s, 2.2 * s, p(fur, -0.3), a);
  fb.ellipse(x + c.light.dir * 0.6 * s, by - 0.6 * s, 4 * s, 1.2 * s, p(fur, 0.35), a);
  const curl = Math.sin(c.t * 2 + seed) * 1.2 * s;
  fb.line(x - 4.8 * s * d, by, x - 7 * s * d, by - 4 * s, p(fur, -0.2), a, 0.8 * s);
  fb.line(x - 7 * s * d, by - 4 * s, x - 6 * s * d + curl * d, by - 7 * s, p(fur, -0.2), a, 0.8 * s);
  const hx = x + 5 * s * d;
  const hy = by - 2.6 * s;
  fb.circle(hx, hy, 2.3 * s, p(fur, 0), a);
  fb.poly([[hx - 1.9 * s, hy - 1 * s], [hx - 1.2 * s, hy - 3.6 * s], [hx - 0.2 * s, hy - 1.8 * s]], p(fur, -0.2), a);
  fb.poly([[hx + 1.9 * s, hy - 1 * s], [hx + 1.2 * s, hy - 3.6 * s], [hx + 0.2 * s, hy - 1.8 * s]], p(fur, -0.2), a);
  if (s >= 1) {
    const eye = mix([150, 200, 90], c.pal.light, 0.2);
    fb.circle(hx + 0.6 * s * d, hy - 0.2 * s, 0.45 * s, c.solid ?? eye, a);
  }
}

export function campfireLogs(c: SpriteCtx, x: number, y: number, s: number, a: number): void {
  const p = paintOf(c);
  const wood: RGB = [96, 62, 40];
  for (const [x0, y0, x1, y1] of [[-7, 0, 6, -2.5], [-6, -2.5, 7, 0], [-3, -0.5, 3, -3.5]]) {
    c.fb.line(x + x0 * s, y + y0 * s, x + x1 * s, y + y1 * s, p(wood, -0.3), a, 2 * s);
    c.fb.line(x + x0 * s, y + y0 * s - 0.6 * s, x + x1 * s, y + y1 * s - 0.6 * s, p(wood, 0.5), a, 0.6 * s);
  }
  for (let i = 0; i < 7; i++) {
    const ang = (i / 7) * Math.PI * 2;
    c.fb.ellipse(x + Math.cos(ang) * 8 * s, y + Math.sin(ang) * 1.6 * s, 1.6 * s, 1 * s, p([120, 116, 112], Math.cos(ang) * c.light.dir * 0.6), a);
  }
}

export function lighthouse(c: SpriteCtx, x: number, y: number, s: number, a: number): void {
  const p = paintOf(c);
  const { fb } = c;
  const h = 44 * s;
  for (let i = 0; i < h; i += 0.5) {
    const w = (6.4 - (i / h) * 2.6) * s;
    const band = Math.floor(i / (6 * s)) % 2 === 0;
    const base: RGB = band ? [236, 232, 224] : [190, 52, 46];
    fb.rect(x - w / 2, y - i, w * 0.35, 0.5, p(base, c.light.dir < 0 ? 0.5 : -0.5), a);
    fb.rect(x - w / 2 + w * 0.35, y - i, w * 0.3, 0.5, p(base, 0), a);
    fb.rect(x - w / 2 + w * 0.65, y - i, w * 0.35, 0.5, p(base, c.light.dir < 0 ? -0.5 : 0.5), a);
  }
  const lampY = y - h - 3.5 * s;
  fb.rect(x - 4 * s, y - h, 8 * s, 1 * s, p([40, 40, 44], 0), a);
  fb.rect(x - 2.4 * s, lampY, 4.8 * s, 3.5 * s, mix(c.pal.light, [255, 250, 210], 0.5), a);
  fb.poly([[x - 3.2 * s, lampY], [x + 3.2 * s, lampY], [x, lampY - 3 * s]], p([180, 50, 44], 0), a);
  const ang = c.t * 1.2;
  const dir = Math.cos(ang);
  const reach = 160 * Math.abs(dir);
  for (let i = 4; i < reach; i += 1) {
    const spread = i * 0.12;
    fb.rect(x + Math.sign(dir) * i, lampY + 1.5 * s - spread / 2, 1, spread, c.pal.light, 0.22 * a * (1 - i / 170));
  }
}
