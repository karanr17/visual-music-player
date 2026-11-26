import type { CastSpec } from "../scene/schema";
import type { SubjectKind } from "../scene/vocab";
import { clamp, K, mix, pack, scale, type FB, type RGB } from "./fb";
import { hexRgb, lit, type Light } from "./lighting";
import { hash1 } from "./noise";
import * as obj from "./objects";
import type { Palette } from "./palette";
import { ageScale, extraLook, person, type Facing, type Pose } from "./people";

export interface CustomSprite {
  w: number;
  h: number;
  px: (RGB | null)[];
  // Surface normal per pixel, estimated from the silhouette, so flat drawings shade like volumes.
  nx: Float32Array;
  ny: Float32Array;
}

export interface SpriteCtx {
  fb: FB;
  pal: Palette;
  t: number;
  energy: number;
  ink: RGB;
  lights: number;
  daylight: number;
  sprites: Map<string, CustomSprite>;
  // Seen from behind, heading into the distance (a road), rather than in side view.
  alongDepth: boolean;
  // Paint every pixel of the subject in this colour (used to stamp a rim behind it).
  solid?: RGB;
  light: Light;
  // Atmospheric perspective toward hazeCol for distant subjects (0 near).
  haze: number;
  hazeCol: RGB;
  cast: CastSpec;
}

function normals(w: number, h: number, opaque: (i: number) => boolean): { nx: Float32Array; ny: Float32Array } {
  const nx = new Float32Array(w * h);
  const ny = new Float32Array(w * h);
  const R = 2;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!opaque(y * w + x)) continue;
      let sx = 0;
      let sy = 0;
      for (let dy = -R; dy <= R; dy++) {
        for (let dx = -R; dx <= R; dx++) {
          const xx = x + dx;
          const yy = y + dy;
          const empty = xx < 0 || yy < 0 || xx >= w || yy >= h || !opaque(yy * w + xx);
          if (empty) {
            sx += dx;
            sy += dy;
          }
        }
      }
      const len = Math.hypot(sx, sy);
      if (len > 0) {
        const k = Math.min(1, len / 4);
        nx[y * w + x] = (sx / len) * k;
        ny[y * w + x] = (sy / len) * k;
      }
    }
  }
  return { nx, ny };
}

// Lit from the key side and from above; normals only exist near the silhouette's edge.
const shadeK = (c: SpriteCtx, nx: number, ny: number, flip: boolean) => clamp((flip ? -nx : nx) * c.light.dir * 0.8 - ny * 0.5, -1, 1);

export function compileSprite(palette: string[], rows: string[]): CustomSprite {
  const cols = palette.map(hexRgb);
  const w = Math.max(...rows.map((r) => r.length));
  const px: (RGB | null)[] = [];
  for (const r of rows) for (let i = 0; i < w; i++) px.push(cols[Number(r[i])] ?? null);
  return { w, h: rows.length, px, ...normals(w, rows.length, (i) => px[i] !== null) };
}

// Model-drawn sprites keep their own colours but take the scene's light, so they sit in the
// world (shaded, darker at night) instead of glowing like stickers.
function drawCustom(c: SpriteCtx, sp: CustomSprite, x: number, y: number, s: number, alpha: number, flip: boolean): void {
  const ox = snap(x - (sp.w * s) / 2);
  const oy = snap(y - sp.h * s);
  for (let r = 0; r < sp.h; r++) {
    for (let col = 0; col < sp.w; col++) {
      const i = r * sp.w + (flip ? sp.w - 1 - col : col);
      const rgb = sp.px[i];
      if (!rgb) continue;
      c.fb.rect(ox + col * s, oy + r * s, s, s, c.solid ?? lit(c.light, rgb, shadeK(c, sp.nx[i], sp.ny[i], flip), c.haze, c.hazeCol), alpha);
    }
  }
}

// Sprite origins snap to the physical grid, not the logical one, so slow motion glides
// in half-steps instead of jumping a whole art pixel at a time.
const snap = (v: number) => Math.round(v * K) / K;

// Legend: # ink (silhouette), + light, o accent, c cream, g stem green, w near-white, . transparent
type Art = string[];

function colorFor(ch: string, c: SpriteCtx): RGB | null {
  switch (ch) {
    case "#": return c.ink;
    case "+": return c.pal.light;
    case "o": return c.pal.accent;
    case "c": return mix(c.pal.light, [255, 255, 255], 0.5);
    case "g": return mix(c.ink, [70, 150, 80], 0.6);
    case "w": return [240, 240, 240];
    case "y": return mix([246, 196, 40], c.ink, (1 - c.daylight) * 0.3);
    case "b": return mix([110, 66, 30], c.ink, 0.2);
    case "r": return [235, 50, 45];
    case "v": return mix(c.ink, c.pal.skyBot, 0.45);
    default: return null;
  }
}

const artNormals = new Map<Art, { nx: Float32Array; ny: Float32Array }>();

// "+" (light) and "w" (flame white) glow on their own; "#" is the silhouette ink, already
// lit by the scene. Everything else is a material and takes the scene's light.
const EMISSIVE = new Set(["+", "w", "#"]);

function blit(c: SpriteCtx, art: Art, x: number, y: number, s: number, alpha: number, flip = false): void {
  const h = art.length;
  const w = art[0].length;
  let n = artNormals.get(art);
  if (!n) {
    n = normals(w, h, (i) => art[Math.floor(i / w)][i % w] !== ".");
    artNormals.set(art, n);
  }
  const ox = snap(x - (w * s) / 2);
  const oy = snap(y - h * s);
  for (let r = 0; r < h; r++) {
    const row = art[r];
    for (let col = 0; col < w; col++) {
      const sc = flip ? w - 1 - col : col;
      const ch = row[sc];
      const rgb = colorFor(ch, c);
      if (!rgb) continue;
      const i = r * w + sc;
      const out = c.solid ?? (EMISSIVE.has(ch) ? rgb : lit(c.light, rgb, shadeK(c, n.nx[i], n.ny[i], flip), c.haze, c.hazeCol));
      c.fb.rect(ox + col * s, oy + r * s, s, s, out, alpha);
    }
  }
}

function thick(c: SpriteCtx, x0: number, y0: number, x1: number, y1: number, w: number, col: RGB, a: number): void {
  c.fb.line(x0, y0, x1, y1, col, a, w);
}

const STAND: Pose = { armL: -0.32, armR: 0.32, legL: -0.16, legR: 0.16 };

// Side-view stride facing right: the swinging leg bends at the knee with its foot trailing,
// and the body rises as the legs pass each other.
function walkPose(ph: number): Pose {
  const s = Math.sin(ph);
  const c = Math.cos(ph);
  return {
    armL: s * 0.5,
    armR: -s * 0.5,
    legL: -s * 0.45,
    legR: s * 0.45,
    kneeL: -Math.max(0, -c) * 0.7,
    kneeR: -Math.max(0, c) * 0.7,
    bob: (1 - Math.abs(s)) * 0.6,
  };
}

function mirror(p: Pose): Pose {
  return {
    ...p,
    armL: -p.armR,
    armR: -p.armL,
    legL: -p.legR,
    legR: -p.legL,
    kneeL: -(p.kneeR ?? 0),
    kneeR: -(p.kneeL ?? 0),
    lean: -(p.lean ?? 0),
    liftL: p.liftR,
    liftR: p.liftL,
  };
}

// Ground covered by one full stride cycle (two steps), matched to the leg swing in walkPose.
export function strideLength(kind: SubjectKind, s: number): number {
  if (kind === "dog" || kind === "cat") return 14 * s;
  const h = 26 * s * (kind === "child" ? 0.6 : 1);
  return 2.6 * ((8 * h) / 18);
}

// Walking away from the viewer: no sideways stride, feet alternately lift and the body bobs.
function awayPose(ph: number): Pose {
  const s = Math.sin(ph);
  return { armL: -0.22 - s * 0.12, armR: 0.22 - s * 0.12, legL: -0.1, legR: 0.1, liftL: Math.max(0, s) * 0.45, liftR: Math.max(0, -s) * 0.45, bob: Math.abs(s) * 0.5 };
}

function dancePose(ph: number, e: number): Pose {
  const s = Math.sin(ph);
  const k = 0.6 + e * 0.8;
  return { armL: Math.PI - 0.6 + s * k, armR: -Math.PI + 0.6 + Math.cos(ph) * k, legL: -0.3 + s * 0.2, legR: 0.3 + s * 0.2, lean: s * 1.5 };
}

// --- ASCII sprites ---


const ART: Partial<Record<SubjectKind, Art | Art[]>> = {
  heart: [".oo.oo.", "oo+oooo", "ooooooo", ".ooooo.", "..ooo..", "...o..."],
  broken_heart: [".oo.oo.", "oo+.ooo", "oooo.oo", ".oo.oo.", "..o.o..", "...o..."],
  flower: [".o.o.", "ooooo", ".o+o.", "ooooo", ".o.o.", "..g..", ".gg..", "..gg.", "..g.."],
  wilted_flower: [".....", "..oo.", ".oo+.", "..oog", "....g", "...g.", "..g..", "..g..", "..g.."],
  rose: [".ooo.", "oo+oo", "ooooo", ".ooo.", "..g..", ".gg..", "..gg.", "..g..", "..g.."],
  candle: [".+.", "+w+", ".+.", ".#.", "ccc", "ccc", "ccc", "ccc", "ccc"],
  lantern: ["..#..", ".###.", "#+w+#", "#+++#", "#+++#", ".###."],
  car: [
    "....######......",
    "...#++#++##.....",
    ".##############.",
    "+##############+",
    "################",
    "..##........##..",
  ],
  boat: [
    "......#.......",
    "......##......",
    "......###.....",
    "......####....",
    "......#####...",
    "......#.......",
    "##############",
    ".############.",
    "..##########..",
  ],
  house: [
    "......#......",
    ".....###.....",
    "....#####....",
    "...#######...",
    "..#########..",
    ".###########.",
    "..#########..",
    "..#++###++#..",
    "..#++###++#..",
    "..#########..",
    "..####+####..",
    "..####+####..",
  ],
  window_light: ["######", "#++#+#", "#++#+#", "######", "#++#+#", "#++#+#", "######"],
  door: ["#######", "#+++++#", "#+###+#", "#+###+#", "#+###+#", "#+##o+#", "#+###+#", "#+###+#", "#+###+#", "#+###+#", "#+###+#", "#######"],
  bench: ["############", ".#........#.", "############", ".#........#.", ".#........#."],
  balloon: [".ooo.", "ooooo", "oo+oo", "ooooo", ".ooo.", "..o..", "..#..", "...#.", "..#..", ".#...", "..#.."],
  kite: ["...o...", "..ooo..", ".ooooo.", "ooo+ooo", ".ooooo.", "..ooo..", "...o...", "...#...", "....#..", "...#...", "..#....", "...#..."],
  key: [".ooo.....", "o...ooooo", "o...o.o.o", ".ooo....."],
  letter: ["ccccccccc", "c#ccccc#c", "cc#ccc#cc", "ccc#c#ccc", "cccc#cccc", "ccccccccc"],
  guitar: ["..#...", "..#...", ".###..", "..#...", "..#...", "..#...", "..#...", ".ooo..", "ooooo.", "oo#oo.", "ooooo.", ".ooo..", "ooooo.", "oooooo", "oooooo", ".oooo."],
  crown: ["+...+...+", "++.+++.++", "+++++++++", "+o+++o+++", "+++++++++"],
  mask: [".ccccccc.", "ccccccccc", "c..ccc..c", "ccccccccc", ".ccccccc.", "..ccccc..", "...ccc..."],
  cat: ["..#...#", "..##.##", "..#####", "...###.", "..####.", ".#####.", ".#####.", "######."],
  dog: [".........##", "........###", "#.......##.", "##########.", ".#########.", ".#.#...#.#.", ".#.#...#.#."],
  whale: [
    ".....................#.#",
    "......########......##..",
    "...##############..##...",
    ".##################.#...",
    "####################....",
    ".#################......",
    "...####.....####........",
  ],
  sunflower: [
    "...y.y.y...",
    ".y.yyyyy.y.",
    "..yybbbyy..",
    ".yybbbbbyy.",
    "yyybbbbbyyy",
    ".yybbbbbyy.",
    "..yybbbyy..",
    ".y.yyyyy.y.",
    "...y.g.y...",
    ".....g.....",
    "..gg.g.....",
    "...ggg.....",
    ".....g.gg..",
    ".....ggg...",
    ".....g.....",
    ".....g.....",
    ".....g.....",
  ],
  phone: ["#######", "#+++++#", "#+++++#", "#+++++#", "#+++++#", "#+++++#", "#+++++#", "###c###"],
  bird: [
    ["#...#", ".#.#.", "..#.."],
    [".....", "##.##", "..#.."],
  ],
  butterfly: [
    ["oo.oo", "ooooo", ".o#o.", "oo.oo"],
    [".o.o.", ".o#o.", ".o#o.", ".o.o."],
  ],
};

function art(kind: SubjectKind, t: number, rate: number): Art | null {
  const a = ART[kind];
  if (!a) return null;
  if (typeof a[0] === "string") return a as Art;
  const frames = a as Art[];
  return frames[Math.floor(t * rate) % frames.length];
}

// --- Procedural subjects ---

function campfire(c: SpriteCtx, x: number, y: number, s: number, a: number): void {
  obj.campfireLogs(c, x, y, s, a);
  c.fb.glow(x, y - 6 * s, 26 * s, c.pal.light, 0.35 * a * (0.8 + c.energy * 0.4));
  const fl = (k: number, col: RGB, hgt: number, wid: number) => {
    for (let i = 0; i < hgt; i++) {
      const fx = x + Math.sin(c.t * 9 + i * 0.7 + k) * (i / hgt) * 2 * s;
      const w = Math.max(0, wid * (1 - i / hgt)) * s;
      c.fb.rect(fx - w / 2, y - 2 * s - i, w, 1, col, a);
    }
  };
  fl(0, c.pal.accent, Math.round((12 + c.energy * 6) * s), 7);
  fl(2, c.pal.light, Math.round((8 + c.energy * 4) * s), 4);
}

function train(c: SpriteCtx, x: number, y: number, s: number, a: number): void {
  const cars = 4;
  const carW = 22 * s;
  const off = ((c.t * 18) % (carW * cars + 340)) - carW * cars;
  for (let k = 0; k < cars; k++) {
    const cx = x - 160 + off + k * (carW + 2 * s);
    c.fb.rect(cx, y - 10 * s, carW, 9 * s, c.ink, a);
    for (let wdx = 3 * s; wdx < carW - 3 * s; wdx += 5 * s) c.fb.rect(cx + wdx, y - 8 * s, 3 * s, 3 * s, c.pal.light, a * Math.max(0.3, c.lights));
  }
}

function clock(c: SpriteCtx, x: number, y: number, s: number, a: number): void {
  const r = 7 * s;
  const cy = y - r - 1;
  c.fb.circle(x, cy, r, c.ink, a);
  c.fb.circle(x, cy, r - 1, mix(c.pal.light, [255, 255, 255], 0.4), a);
  const m = c.t * 0.8;
  c.fb.line(x, cy, x + Math.sin(m) * (r - 2), cy - Math.cos(m) * (r - 2), c.ink, a);
  c.fb.line(x, cy, x + Math.sin(m / 12) * (r - 3), cy - Math.cos(m / 12) * (r - 3), c.ink, a);
}

function chains(c: SpriteCtx, x: number, y: number, s: number, a: number): void {
  for (let i = 0; i < 6; i++) {
    const ly = y - 60 * s + i * 7 * s + Math.sin(c.t * 2) * s;
    const lx = x + Math.sin(c.t * 1.5 + i * 0.4) * 2;
    const col = mix(c.ink, [160, 160, 170], 0.5);
    if (i % 2) c.fb.rect(lx - 1, ly, 2 * s, 7 * s, col, a);
    else {
      c.fb.rect(lx - 3 * s, ly, 6 * s, 1 * s, col, a);
      c.fb.rect(lx - 3 * s, ly + 6 * s, 6 * s, 1 * s, col, a);
      c.fb.rect(lx - 3 * s, ly, 1 * s, 7 * s, col, a);
      c.fb.rect(lx + 2 * s, ly, 1 * s, 7 * s, col, a);
    }
  }
}

function ladder(c: SpriteCtx, x: number, y: number, s: number, a: number): void {
  const h = 70 * s;
  thick(c, x - 4 * s, y, x - 4 * s, y - h, s, c.ink, a);
  thick(c, x + 4 * s, y, x + 4 * s, y - h, s, c.ink, a);
  for (let r = 4 * s; r < h; r += 6 * s) {
    const fade = 1 - r / h;
    c.fb.rect(x - 4 * s, y - r, 8 * s, s, c.ink, a * (0.4 + fade * 0.6));
  }
}

function bridge(c: SpriteCtx, x: number, y: number, s: number, a: number): void {
  const span = 90 * s;
  for (let i = -span / 2; i <= span / 2; i++) {
    const k = i / (span / 2);
    const archY = y - 18 * s * (1 - k * k);
    c.fb.rect(x + i, archY - 3 * s, 1, 3 * s, c.ink, a);
    if (Math.round(i) % (6 * s) === 0) c.fb.rect(x + i, archY - 3 * s, 1, y - archY + 3 * s, c.ink, a);
  }
}

function ship(c: SpriteCtx, x: number, y: number, s: number, a: number): void {
  const w = 70 * s;
  const left = x - w / 2;
  for (let i = 0; i < 8 * s; i++) {
    const inset = (i / (8 * s)) * 6 * s;
    c.fb.rect(left + inset, y - i, w - inset * 1.6, 1, c.ink, a);
  }
  c.fb.rect(left + 10 * s, y - 14 * s, w - 26 * s, 6 * s, c.ink, a);
  c.fb.rect(left + 18 * s, y - 19 * s, w - 42 * s, 5 * s, c.ink, a);
  c.fb.rect(left + 30 * s, y - 27 * s, 5 * s, 8 * s, c.ink, a);
  c.fb.rect(left + 30 * s, y - 27 * s, 5 * s, 2 * s, c.pal.accent, a);
  for (let px = left + 12 * s; px < left + w - 18 * s; px += 4 * s) {
    c.fb.rect(px, y - 12 * s, s, s, c.pal.light, a * Math.max(0.35, c.lights));
    c.fb.rect(px, y - 4 * s, s, s, c.pal.light, a * Math.max(0.35, c.lights));
  }
}

// --- Sky-scale subjects ---

function bigMoon(c: SpriteCtx, x: number, y: number, a: number): void {
  c.fb.glow(x, y, 46, c.pal.sun, 0.3 * a);
  const body = mix(c.pal.sun, [255, 255, 255], 0.3);
  c.fb.circle(x, y, 20, body, a);
  const crater = mix(body, c.pal.skyTop, 0.25);
  c.fb.circle(x - 6, y - 4, 4, crater, a);
  c.fb.circle(x + 7, y + 5, 3, crater, a);
  c.fb.circle(x + 2, y - 9, 2, crater, a);
}

function bigSun(c: SpriteCtx, x: number, y: number, a: number): void {
  c.fb.glow(x, y, 60, c.pal.sun, 0.45 * a * (0.85 + c.energy * 0.3));
  c.fb.circle(x, y, 22, mix(c.pal.sun, [255, 255, 255], 0.2), a);
}

function planet(c: SpriteCtx, x: number, y: number, a: number): void {
  const body = mix(c.pal.accent, c.pal.skyTop, 0.35);
  for (let yy = -16; yy <= 16; yy++) {
    for (let xx = -16; xx <= 16; xx++) {
      if (xx * xx + yy * yy > 256) continue;
      const shade = (xx + yy) / 32;
      c.fb.px(x + xx, y + yy, pack(scale(body, 1 - shade * 0.6)), a);
    }
  }
  for (let i = -30; i <= 30; i++) {
    const ry = y + i * 0.25;
    if (Math.abs(i) > 14 || ry > y) c.fb.px(x + i, ry, pack(c.pal.light), a);
  }
}

function rainbow(c: SpriteCtx, x: number, y: number, a: number): void {
  const bands: RGB[] = [[230, 60, 60], [240, 150, 50], [240, 220, 70], [80, 200, 90], [70, 130, 230], [140, 80, 200]];
  bands.forEach((col, i) => {
    const r = 90 - i * 3;
    for (let k = 0; k <= 180; k++) {
      const ang = Math.PI + (k / 180) * Math.PI;
      for (let th = 0; th < 3; th++) c.fb.px(x + Math.cos(ang) * (r - th), y + Math.sin(ang) * (r - th), pack(col), a * 0.7);
    }
  });
}

function umbrella(c: SpriteCtx, x: number, y: number, r: number, a: number): void {
  const canopy = c.pal.accent;
  const paint = (k: number) => c.solid ?? lit(c.light, canopy, k, c.haze, c.hazeCol);
  c.fb.line(x, y, x, y + r * 1.2, c.solid ?? lit(c.light, [60, 50, 46], 0), a, Math.max(0.5, r * 0.08));
  c.fb.poly([[x - r, y + r * 0.35], [x - r * 0.6, y - r * 0.15], [x, y - r * 0.35], [x + r * 0.6, y - r * 0.15], [x + r, y + r * 0.35]], paint(-0.3), a);
  c.fb.poly([[x, y - r * 0.35], [x + r * 0.6 * c.light.dir, y - r * 0.15], [x + r * c.light.dir, y + r * 0.35], [x, y + r * 0.2]], paint(0.5), a);
  for (let i = -2; i <= 2; i++) c.fb.circle(x + i * r * 0.5, y + r * 0.35, Math.max(0.5, r * 0.12), paint(-0.6), a);
}

// Symbolic objects carry meaning, so they draw at 2x to read at a glance.
const SYMBOLIC = new Set<SubjectKind>([
  "heart", "broken_heart", "flower", "wilted_flower", "rose", "candle", "lantern", "key", "letter", "crown", "mask", "balloon",
  "sunflower", "phone",
]);

export const FLYING = new Set<SubjectKind>(["bird", "bird_flock", "butterfly", "balloon", "kite"]);
export const CELESTIAL = new Set<SubjectKind>(["big_moon", "big_sun", "planet", "rainbow"]);

export function drawSubject(
  kind: SubjectKind,
  c: SpriteCtx,
  x: number,
  y: number,
  s: number,
  alpha: number,
  moving: boolean,
  flip: boolean,
  seed: number,
  custom = "",
  gait?: number,
): void {
  const ph = gait ?? c.t * (moving ? 7 : 2) + seed;
  const fh = 26 * s;
  const stride = (p: number) => (c.alongDepth ? awayPose(p) : flip ? mirror(walkPose(p)) : walkPose(p));
  const walkFacing: Facing = c.alongDepth ? "back" : flip ? -1 : 1;
  const lead = c.cast.lead;
  const kid = { ...c.cast.child, age: "child" as const };
  switch (kind) {
    case "custom": {
      const sp = c.sprites.get(custom);
      // Small drawings scale up so a 12px sprite reads like a 24px one.
      if (sp) drawCustom(c, sp, x, y, Math.max(1, Math.round(s * (Math.max(sp.w, sp.h) <= 16 ? 2 : 1))), alpha, flip);
      return;
    }
    case "ship":
      return ship(c, x, y, s, alpha);
    case "phone": {
      blit(c, art("phone", c.t, 1)!, x, y, Math.max(1, s * 2), alpha);
      c.fb.glow(x, y - 8 * s, 16 * s, c.pal.light, 0.35 * alpha);
      return;
    }
    case "lone_figure":
      return person(c, x, y, fh * ageScale(lead), STAND, lead, alpha, 0);
    case "walking_figure":
      return person(c, x, y, fh * ageScale(lead), moving ? stride(ph) : STAND, lead, alpha, moving ? walkFacing : 0);
    case "child":
      return person(c, x, y, fh * ageScale(kid), moving ? stride(ph) : STAND, kid, alpha, moving ? walkFacing : 0);
    case "car":
      if (c.alongDepth) return obj.carRear(c, x, y, s, alpha, seed);
      return obj.carSide(c, x, y, s, alpha, seed, flip, moving);
    case "dancer": {
      const who = Math.floor(seed) % 2 ? c.cast.partner : lead;
      return person(c, x, y, fh * ageScale(who), dancePose(c.t * (3 + c.energy * 4) + seed, c.energy), who, alpha, 0);
    }
    case "reaching_figure":
      return person(c, x, y, fh * ageScale(lead), { armL: Math.PI - 0.35 + Math.sin(c.t) * 0.1, armR: Math.PI + 0.3, legL: -0.1, legR: 0.1, lean: 0.3 }, lead, alpha, 0);
    case "sitting_figure":
      return person(c, x, y, fh * ageScale(lead), { armL: -0.5, armR: -0.3, elbowL: -0.6, elbowR: -0.6, legL: -1.4, legR: -1.3, kneeL: 1.5, kneeR: 1.4, sit: true }, lead, alpha, -1);
    case "figure_with_umbrella": {
      const h = fh * ageScale(lead);
      person(c, x, y, h, { armL: -0.25, armR: Math.PI - 0.2, elbowR: 0.1, legL: -0.12, legR: 0.12 }, lead, alpha, 0);
      umbrella(c, x + 2.5 * s, y - h * 1.12, 9 * s, alpha);
      return;
    }
    case "couple": {
      const p = c.cast.partner;
      const a = moving ? stride(ph) : STAND;
      const b = moving ? stride(ph + Math.PI * 0.2) : STAND;
      const f: Facing = moving ? walkFacing : 0;
      person(c, x - 5 * s, y, fh * ageScale(lead), { ...a, armR: moving ? a.armR : 0.75 }, lead, alpha, f);
      person(c, x + 5 * s, y, fh * ageScale(p), { ...b, armL: moving ? b.armL : -0.75 }, p, alpha, f);
      return;
    }
    case "embracing_couple": {
      const p = c.cast.partner;
      person(c, x - 2.4 * s, y, fh * ageScale(lead), { armL: 1.25, armR: 1.45, elbowL: -0.5, elbowR: -0.6, legL: -0.1, legR: 0.12, lean: 0.6 }, lead, alpha, 1);
      person(c, x + 2.4 * s, y, fh * ageScale(p), { armL: -1.25, armR: -1.45, elbowL: 0.5, elbowR: 0.6, legL: -0.12, legR: 0.1, lean: -0.6 }, p, alpha, -1);
      return;
    }
    case "crowd":
      for (let i = 0; i < 9; i++) {
        const hx = x - 40 * s + i * 10 * s + (hash1(seed + i) - 0.5) * 4;
        const hh = fh * (0.85 + hash1(seed + i * 3) * 0.2);
        const up = c.energy > 0.55 && hash1(i + Math.floor(c.t * 2)) > 0.5;
        const pose: Pose = up ? { armL: Math.PI - 0.4, armR: -Math.PI + 0.4, legL: -0.1, legR: 0.1 } : STAND;
        person(c, hx, y + (i % 2) * 2, hh, pose, extraLook(seed + i), alpha, 0);
      }
      return;
    case "tree":
      return obj.tree(c, x, y, s, alpha, seed);
    case "dead_tree":
      return obj.deadTree(c, x, y, s, alpha, seed);
    case "house":
      return obj.house(c, x, y, s, alpha, seed);
    case "bench":
      return obj.bench(c, x, y, s, alpha);
    case "boat":
      return obj.boat(c, x, y, s, alpha, flip);
    case "door":
      return obj.door(c, x, y, s, alpha);
    case "sunflower":
      return obj.sunflower(c, x, y, Math.max(1, s), alpha, seed);
    case "flower":
    case "rose":
    case "wilted_flower":
      return obj.flower(c, x, y, Math.max(1, s), alpha, kind, seed);
    case "dog":
      return obj.dog(c, x, y, s, alpha, seed, flip, moving, ph);
    case "cat":
      return obj.cat(c, x, y, s, alpha, seed, flip, moving, ph);
    case "campfire":
      return campfire(c, x, y, s, alpha);
    case "street_lamp":
      return obj.streetLamp(c, x, y, s, alpha);
    case "lighthouse":
      return obj.lighthouse(c, x, y, s, alpha);
    case "train":
      return train(c, x, y, s, alpha);
    case "clock":
      return clock(c, x, y, s, alpha);
    case "chains":
      return chains(c, x, y, s, alpha);
    case "ladder":
      return ladder(c, x, y, s, alpha);
    case "bridge":
      return bridge(c, x, y, s, alpha);
    case "big_moon":
      return bigMoon(c, x, y, alpha);
    case "big_sun":
      return bigSun(c, x, y, alpha);
    case "planet":
      return planet(c, x, y, alpha);
    case "rainbow":
      return rainbow(c, x, y, alpha);
    case "bird_flock":
      for (let i = 0; i < 9; i++) {
        const bx = x + (i - 4) * 9 * s + Math.sin(c.t + i) * 3;
        const by = y - Math.abs(i - 4) * 4 * s + Math.sin(c.t * 2 + i * 1.7) * 2;
        blit(c, art("bird", c.t + i * 0.13, 6)!, bx, by, s, alpha);
      }
      return;
    case "candle":
    case "lantern": {
      const a = art(kind, c.t, 1)!;
      const k = s >= 1 ? s * 2 : 1;
      blit(c, a, x, y, k, alpha);
      c.fb.glow(x, y - a.length * k + k, 14 * k, c.pal.light, 0.3 * alpha * (0.85 + Math.sin(c.t * 11 + seed) * 0.15));
      return;
    }
    default: {
      const a = art(kind, c.t, kind === "butterfly" ? 8 : 5);
      const k = SYMBOLIC.has(kind) && s >= 1 ? s * 2 : Math.max(1, Math.round(s));
      if (a) blit(c, a, x, y, k, alpha, flip);
    }
  }
}
