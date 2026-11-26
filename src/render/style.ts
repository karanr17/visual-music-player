import type { Style } from "../scene/vocab";
import { bayer, K, PH, PW, type FB, type RGB } from "./fb";
import { hash1, noise2 } from "./noise";

// What the frame is finished with: one of the scene styles, or the listener's own reference artwork.
export type Look = Style | "reference";

// Looks that snap to a fixed palette. Soft glows turn into hard-edged discs there, so the
// renderer leaves out subject backlights for them.
export const PALETTE_LOOKS = new Set<Look>(["ukiyoe", "comic", "gameboy", "nes", "reference"]);

export interface Reference {
  palette: RGB[];
  // Average chroma of the artwork in YCbCr, and how saturated it is relative to a typical scene.
  cb: number;
  cr: number;
  chroma: number;
}

interface Grade {
  sat: number;
  contrast: number;
  lift: number;
  shadow?: [RGB, number];
  highlight?: [RGB, number];
  grain: number;
  scan: number;
  posterize: number;
}

const GRADES: Record<Look, Grade> = {
  natural: { sat: 1, contrast: 1, lift: 0, grain: 0, scan: 0, posterize: 0 },
  synthwave: { sat: 1.3, contrast: 1.1, lift: 0, shadow: [[50, 0, 100], 0.35], highlight: [[255, 70, 200], 0.18], grain: 0, scan: 0.14, posterize: 0 },
  lofi: { sat: 0.72, contrast: 0.9, lift: 20, highlight: [[255, 214, 160], 0.16], grain: 10, scan: 0, posterize: 0 },
  noir: { sat: 0, contrast: 1.35, lift: 0, highlight: [[205, 214, 235], 0.1], grain: 12, scan: 0, posterize: 0 },
  storybook: { sat: 1.25, contrast: 1.05, lift: 6, highlight: [[255, 240, 210], 0.1], grain: 0, scan: 0, posterize: 8 },
  metal: { sat: 0.6, contrast: 1.4, lift: 0, shadow: [[40, 0, 0], 0.45], highlight: [[255, 70, 40], 0.18], grain: 16, scan: 0, posterize: 0 },
  dream: { sat: 0.85, contrast: 0.85, lift: 30, highlight: [[255, 196, 236], 0.2], shadow: [[90, 60, 140], 0.2], grain: 0, scan: 0, posterize: 0 },
  ukiyoe: { sat: 0.8, contrast: 1.05, lift: 12, highlight: [[245, 230, 200], 0.15], grain: 0, scan: 0, posterize: 0 },
  impressionist: { sat: 1.3, contrast: 0.95, lift: 10, highlight: [[255, 236, 190], 0.1], grain: 0, scan: 0, posterize: 0 },
  watercolor: { sat: 0.9, contrast: 0.82, lift: 34, highlight: [[255, 250, 240], 0.15], grain: 0, scan: 0, posterize: 0 },
  gameboy: { sat: 0, contrast: 1.15, lift: 0, grain: 0, scan: 0, posterize: 0 },
  nes: { sat: 1.2, contrast: 1.1, lift: 0, grain: 0, scan: 0, posterize: 0 },
  comic: { sat: 1.35, contrast: 1.2, lift: 0, grain: 0, scan: 0, posterize: 0 },
  reference: { sat: 1, contrast: 1, lift: 0, grain: 0, scan: 0, posterize: 0 },
};

const VIGNETTE = (() => {
  const m = new Float32Array(PW * PH);
  for (let y = 0; y < PH; y++) {
    const vy = (y / PH - 0.5) * 2;
    for (let x = 0; x < PW; x++) {
      const vx = (x / PW - 0.5) * 2;
      m[y * PW + x] = Math.min(1, (vx * vx + vy * vy) * 0.6);
    }
  }
  return m;
})();

// ---------- palettes ----------

const GAMEBOY: RGB[] = [[15, 56, 15], [48, 98, 48], [139, 172, 15], [155, 188, 15]];
const NES: RGB[] = [
  [0, 0, 0], [84, 84, 84], [152, 150, 152], [236, 238, 236], [8, 16, 144], [48, 50, 236], [92, 148, 252], [168, 204, 236],
  [68, 4, 100], [160, 26, 204], [212, 136, 236], [136, 20, 0], [228, 92, 16], [252, 152, 56], [252, 228, 160],
  [32, 60, 0], [56, 135, 0], [128, 208, 16], [184, 248, 24], [0, 50, 60], [0, 136, 136], [76, 220, 72], [160, 0, 32],
  [228, 0, 88], [248, 120, 248], [120, 124, 0], [248, 184, 0],
];
const WOODBLOCK: RGB[] = [
  [38, 34, 40], [22, 28, 54], [42, 46, 84], [70, 64, 104], [32, 52, 88], [58, 94, 140], [120, 156, 176], [160, 196, 210], [200, 220, 222], [190, 60, 44],
  [214, 140, 80], [222, 184, 112], [232, 190, 64], [222, 150, 132], [118, 132, 84], [72, 96, 70], [44, 64, 52],
  [238, 226, 198], [200, 186, 160], [120, 84, 60],
];
const COMIC: RGB[] = [
  [20, 18, 24], [250, 246, 236], [230, 40, 50], [250, 200, 40], [40, 110, 210], [60, 170, 90], [240, 130, 40],
  [140, 70, 160], [120, 200, 230], [250, 170, 170], [110, 110, 120], [190, 190, 196], [30, 70, 50], [30, 40, 90],
  [110, 70, 40], [70, 60, 90],
];

// 32^3 nearest-colour lookup: palette mapping costs one table read per pixel.
function buildLut(palette: RGB[]): Uint32Array {
  const lut = new Uint32Array(32 * 32 * 32);
  const packed = palette.map((c) => (0xff000000 | (c[2] << 16) | (c[1] << 8) | c[0]) >>> 0);
  for (let r = 0; r < 32; r++) {
    for (let g = 0; g < 32; g++) {
      for (let b = 0; b < 32; b++) {
        const R = r * 8 + 4;
        const G = g * 8 + 4;
        const B = b * 8 + 4;
        let best = 0;
        let bd = Infinity;
        for (let i = 0; i < palette.length; i++) {
          const [pr, pg, pb] = palette[i];
          // "Redmean" weighting: cheap, and much closer to perceived difference than plain RGB distance.
          const rm = (R + pr) / 2;
          const dr = R - pr;
          const dg = G - pg;
          const db = B - pb;
          const d = (2 + rm / 256) * dr * dr + 4 * dg * dg + (2 + (255 - rm) / 256) * db * db;
          if (d < bd) {
            bd = d;
            best = i;
          }
        }
        lut[(r << 10) | (g << 5) | b] = packed[best];
      }
    }
  }
  return lut;
}

const lazy = <T,>(f: () => T) => {
  let v: T | undefined;
  return () => (v ??= f());
};

const LUTS = {
  nes: lazy(() => buildLut(NES)),
  ukiyoe: lazy(() => buildLut(WOODBLOCK)),
  comic: lazy(() => buildLut(COMIC)),
};

let reference: { ref: Reference; lut: Uint32Array } | null = null;

export function setReference(ref: Reference | null): void {
  reference = ref ? { ref, lut: buildLut(ref.palette) } : null;
}

// ---------- static textures (screen-space, built on first use) ----------

// Paper fibre / canvas weave as a brightness multiplier around 1.
const PAPER = lazy(() => {
  const m = new Float32Array(PW * PH);
  for (let y = 0; y < PH; y++) {
    for (let x = 0; x < PW; x++) {
      const fibre = noise2(x * 0.02, y * 0.2, 11) * 0.5 + noise2(x * 0.15, y * 0.015, 12) * 0.5;
      const grain = hash1(y * PW + x);
      m[y * PW + x] = 0.94 + fibre * 0.08 + (grain - 0.5) * 0.04;
    }
  }
  return m;
});

// Brushstrokes: every pixel takes its colour from the centre of a short oriented dab, and the
// dab orientation follows a slow flow field, so flat areas break into directional strokes.
const STROKES = lazy(() => {
  const src = new Int32Array(PW * PH);
  const shade = new Float32Array(PW * PH);
  const len = 5 * K;
  const wid = 1.6 * K;
  for (let y = 0; y < PH; y++) {
    for (let x = 0; x < PW; x++) {
      const a = noise2(x / (60 * K), y / (60 * K), 21) * Math.PI * 2;
      const ca = Math.cos(a);
      const sa = Math.sin(a);
      const u = x * ca + y * sa;
      const v = -x * sa + y * ca;
      const cu = (Math.floor(u / len) + 0.5) * len;
      // Alternate rows of dabs are offset so strokes interlock like real brushwork.
      const row = Math.floor(v / wid);
      const cuo = cu + (row & 1 ? len / 2 : 0);
      const cv = (row + 0.5) * wid;
      const sx = Math.round(cuo * ca - cv * sa);
      const sy = Math.round(cuo * sa + cv * ca);
      src[y * PW + x] = Math.min(PH - 1, Math.max(0, sy)) * PW + Math.min(PW - 1, Math.max(0, sx));
      const across = (v / wid - row) * 2 - 1;
      shade[y * PW + x] = 1 + 0.06 * (hash1(row * 7919 + Math.floor(u / len)) - 0.5) * 2 - 0.05 * across * across;
    }
  }
  return { src, shade };
});

// Watercolour bleed: a small wobbling displacement, so edges look soaked rather than cut.
const BLEED = lazy(() => {
  const src = new Int32Array(PW * PH);
  for (let y = 0; y < PH; y++) {
    for (let x = 0; x < PW; x++) {
      const dx = (noise2(x * 0.05, y * 0.05, 31) - 0.5) * 5 * K;
      const dy = (noise2(x * 0.05, y * 0.05, 32) - 0.5) * 5 * K;
      const sx = Math.min(PW - 1, Math.max(0, Math.round(x + dx)));
      const sy = Math.min(PH - 1, Math.max(0, Math.round(y + dy)));
      src[y * PW + x] = sy * PW + sx;
    }
  }
  return src;
});

let scratch: Uint32Array | null = null;
let lum: Uint8Array | null = null;

const lumOf = (v: number) => (77 * (v & 0xff) + 150 * ((v >> 8) & 0xff) + 29 * ((v >> 16) & 0xff)) >> 8;
const rgb = (r: number, g: number, b: number) => {
  r = r < 0 ? 0 : r > 255 ? 255 : r | 0;
  g = g < 0 ? 0 : g > 255 ? 255 : g | 0;
  b = b < 0 ? 0 : b > 255 ? 255 : b | 0;
  return (0xff000000 | (b << 16) | (g << 8) | r) >>> 0;
};
const scaleV = (v: number, k: number) => rgb((v & 0xff) * k, ((v >> 8) & 0xff) * k, ((v >> 16) & 0xff) * k);
const lutAt = (lut: Uint32Array, r: number, g: number, b: number) => {
  r = r < 0 ? 0 : r > 255 ? 255 : r;
  g = g < 0 ? 0 : g > 255 ? 255 : g;
  b = b < 0 ? 0 : b > 255 ? 255 : b;
  return lut[((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3)];
};

// Snap to the look's palette, but where the palette has nothing near (a hue it lacks), flatten
// the original colour instead of swapping it for a wrong hue: a night sky must not turn green.
function snapOrPosterize(lut: Uint32Array, v: number): number {
  const r = v & 0xff;
  const g = (v >> 8) & 0xff;
  const b = (v >> 16) & 0xff;
  const p = lutAt(lut, r, g, b);
  const dr = r - (p & 0xff);
  const dg = g - ((p >> 8) & 0xff);
  const db = b - ((p >> 16) & 0xff);
  if (dr * dr + dg * dg + db * db < 48 * 48) return p;
  const q = (c: number) => Math.round(c / 51) * 51;
  return rgb(q(r), q(g), q(b));
}

function computeLum(d: Uint32Array): Uint8Array {
  lum ??= new Uint8Array(PW * PH);
  for (let i = 0; i < d.length; i++) lum[i] = lumOf(d[i]);
  return lum;
}

let edges: Uint8Array | null = null;

// Ink lines where luminance steps sharply: what turns flat shapes into a print or a comic panel.
// An edge pixel only survives if the edge continues on both sides of it, so the outline traces
// shapes and skips specks (petals, stars, rain) that would otherwise read as dirt.
function outlines(d: Uint32Array, L: Uint8Array, ink: number, threshold: number): void {
  const step = K;
  edges ??= new Uint8Array(PW * PH);
  const E = edges;
  E.fill(0);
  for (let y = 0; y < PH - step; y++) {
    const row = y * PW;
    for (let x = 0; x < PW - step; x++) {
      const i = row + x;
      const l = L[i];
      if (Math.abs(l - L[i + step]) > threshold || Math.abs(l - L[i + step * PW]) > threshold) E[i] = 1;
    }
  }
  const r = 2 * K;
  const rv = r * PW;
  for (let y = r; y < PH - r; y++) {
    const row = y * PW;
    for (let x = r; x < PW - r; x++) {
      const i = row + x;
      if (!E[i]) continue;
      if ((E[i - r] && E[i + r]) || (E[i - rv] && E[i + rv]) || (E[i - rv - r] && E[i + rv + r]) || (E[i - rv + r] && E[i + rv - r])) d[i] = ink;
    }
  }
}

// Coarse looks (handheld, 8-bit) render at the logical resolution: one colour per K×K block.
function blocky(d: Uint32Array, map: (v: number, x: number, y: number) => number): void {
  for (let y = 0; y < PH; y += K) {
    for (let x = 0; x < PW; x += K) {
      const v = map(d[y * PW + x], x / K, y / K);
      for (let dy = 0; dy < K; dy++) d.fill(v, (y + dy) * PW + x, (y + dy) * PW + x + K);
    }
  }
}

function artPass(fb: FB, look: Look): void {
  const d = fb.data;
  switch (look) {
    case "gameboy": {
      const shades = GAMEBOY.map(([r, g, b]) => rgb(r, g, b));
      blocky(d, (v, x, y) => shades[Math.min(3, Math.floor((lumOf(v) / 256) * 4 + bayer(x, y) - 0.5))]);
      return;
    }
    case "nes": {
      const lut = LUTS.nes();
      blocky(d, (v, x, y) => {
        const o = (bayer(x, y) - 0.5) * 40;
        return lutAt(lut, (v & 0xff) + o, ((v >> 8) & 0xff) + o, ((v >> 16) & 0xff) + o);
      });
      return;
    }
    case "ukiyoe": {
      const L = computeLum(d);
      const lut = LUTS.ukiyoe();
      const paper = PAPER();
      for (let i = 0; i < d.length; i++) d[i] = scaleV(snapOrPosterize(lut, d[i]), paper[i]);
      outlines(d, L, rgb(34, 30, 40), 14);
      return;
    }
    case "comic": {
      const L = computeLum(d);
      const lut = LUTS.comic();
      const dot = 3 * K;
      for (let y = 0; y < PH; y++) {
        for (let x = 0; x < PW; x++) {
          const i = y * PW + x;
          const v = d[i];
          let c = snapOrPosterize(lut, v);
          // Halftone: darker areas get bigger dots on a 45° grid.
          const dark = 1 - L[i] / 255;
          if (dark > 0.35) {
            const u = ((x + y) % dot) - dot / 2 + 0.5;
            const w = ((x - y + PH * 4) % dot) - dot / 2 + 0.5;
            const r = (dark - 0.35) * dot * 0.9;
            if (u * u + w * w < r * r) c = scaleV(c, 0.5);
          }
          d[i] = c;
        }
      }
      outlines(d, L, rgb(16, 14, 20), 16);
      return;
    }
    case "impressionist": {
      const { src, shade } = STROKES();
      scratch ??= new Uint32Array(PW * PH);
      scratch.set(d);
      const paper = PAPER();
      for (let i = 0; i < d.length; i++) d[i] = scaleV(scratch[src[i]], shade[i] * (0.5 + paper[i] * 0.5));
      return;
    }
    case "watercolor": {
      const bleed = BLEED();
      scratch ??= new Uint32Array(PW * PH);
      scratch.set(d);
      const L = computeLum(scratch);
      const paper = PAPER();
      for (let y = 0; y < PH; y++) {
        for (let x = 0; x < PW; x++) {
          const i = y * PW + x;
          const s = bleed[i];
          // Pigment pools at the edge of a wash, so boundaries come out darker than the fill.
          const edge = x + K < PW && y + K < PH ? Math.max(Math.abs(L[s] - L[Math.min(s + K, L.length - 1)]), Math.abs(L[s] - L[Math.min(s + K * PW, L.length - 1)])) : 0;
          const k = (1 - Math.min(0.25, edge / 400)) * (0.92 + (paper[i] - 0.94) * 2.2);
          d[i] = scaleV(scratch[s], k);
        }
      }
      return;
    }
    case "reference": {
      if (!reference) return;
      const { ref, lut } = reference;
      for (let y = 0; y < PH; y++) {
        for (let x = 0; x < PW; x++) {
          const i = y * PW + x;
          const v = d[i];
          const r = v & 0xff;
          const g = (v >> 8) & 0xff;
          const b = (v >> 16) & 0xff;
          // Pull chroma toward the artwork's overall cast before snapping to its palette,
          // keeping the scene's own light and dark so night still reads as night.
          const Y = 0.299 * r + 0.587 * g + 0.114 * b;
          const cb = (b - Y) * ref.chroma * 0.65 + ref.cb * 0.35;
          const cr = (r - Y) * ref.chroma * 0.65 + ref.cr * 0.35;
          const o = (bayer(x, y) - 0.5) * 18;
          d[i] = lutAt(lut, (Y + cr + o) | 0, (Y - 0.194 * cb - 0.509 * cr + o) | 0, (Y + cb + o) | 0);
        }
      }
      return;
    }
    default:
      return;
  }
}

export interface Overlay {
  brightness: number;
  flash: number;
  vignette: number;
}

// Colour grade for the look, the look's art treatment, then event overlays.
export function postProcess(fb: FB, look: Look, frame: number, o: Overlay): void {
  const g = GRADES[look] ?? GRADES.natural;
  const d = fb.data;
  const levels = g.posterize - 1;
  let seed = (frame * 2654435761) >>> 0;
  const graded = g.sat !== 1 || g.contrast !== 1 || g.shadow || g.highlight || g.lift || g.grain || levels > 0;
  if (graded) {
    for (let y = 0; y < PH; y++) {
      for (let x = 0; x < PW; x++) {
        const i = y * PW + x;
        const v = d[i];
        let r = v & 0xff;
        let gg = (v >> 8) & 0xff;
        let b = (v >> 16) & 0xff;
        const l = 0.299 * r + 0.587 * gg + 0.114 * b;
        if (g.sat !== 1) {
          r = l + (r - l) * g.sat;
          gg = l + (gg - l) * g.sat;
          b = l + (b - l) * g.sat;
        }
        if (g.contrast !== 1) {
          r = (r - 128) * g.contrast + 128;
          gg = (gg - 128) * g.contrast + 128;
          b = (b - 128) * g.contrast + 128;
        }
        const ln = l / 255;
        if (g.shadow) {
          const k = (1 - ln) * g.shadow[1];
          r += (g.shadow[0][0] - r) * k;
          gg += (g.shadow[0][1] - gg) * k;
          b += (g.shadow[0][2] - b) * k;
        }
        if (g.highlight) {
          const k = ln * g.highlight[1];
          r += (g.highlight[0][0] - r) * k;
          gg += (g.highlight[0][1] - gg) * k;
          b += (g.highlight[0][2] - b) * k;
        }
        if (g.lift) {
          const k = 1 - g.lift / 255;
          r = g.lift + r * k;
          gg = g.lift + gg * k;
          b = g.lift + b * k;
        }
        if (g.grain) {
          seed = (Math.imul(seed ^ (seed >>> 15), 2246822519) + i) >>> 0;
          const n = ((seed & 0xff) / 255 - 0.5) * g.grain;
          r += n;
          gg += n;
          b += n;
        }
        if (levels > 0) {
          // A light dither only: full-strength ordered dither at few levels turns flat skies into a checkerboard.
          const th = (bayer(x, y) - 0.5) * 0.3;
          r = Math.round((r / 255) * levels + th) * (255 / levels);
          gg = Math.round((gg / 255) * levels + th) * (255 / levels);
          b = Math.round((b / 255) * levels + th) * (255 / levels);
        }
        d[i] = rgb(r, gg, b);
      }
    }
  }

  artPass(fb, look);

  // Overlays come last so a flash or a darkening event still lands on a fixed-palette look;
  // the console looks skip the vignette, which would smear their few colours.
  const vignette = look === "gameboy" || look === "nes" ? 0 : o.vignette;
  for (let y = 0; y < PH; y++) {
    const scan = g.scan && y & 1 ? 1 - g.scan : 1;
    for (let x = 0; x < PW; x++) {
      const i = y * PW + x;
      const m = o.brightness * scan * (1 - vignette * VIGNETTE[i]);
      if (m === 1 && o.flash <= 0) continue;
      const v = d[i];
      let r = (v & 0xff) * m;
      let gg = ((v >> 8) & 0xff) * m;
      let b = ((v >> 16) & 0xff) * m;
      if (o.flash > 0) {
        r += (255 - r) * o.flash;
        gg += (255 - gg) * o.flash;
        b += (255 - b) * o.flash;
      }
      d[i] = rgb(r, gg, b);
    }
  }
}
