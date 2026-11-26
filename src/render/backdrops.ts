import type { Setting } from "../scene/vocab";
import { bayer, clamp, H, K, mix, pack, PW, scale, W, type FB, type RGB } from "./fb";
import { fbm1, hash1, hash2, noise2 } from "./noise";
import type { WorldParams } from "./palette";

export interface SceneCtx {
  fb: FB;
  p: WorldParams;
  t: number;
  energy: number;
  camX: number;
  camY: number;
  seed: number;
  // Distance travelled along a road; advances only while something on it is moving.
  travel: number;
}

export const HORIZON = 112;

// Vertical camera offset applied with parallax: distant layers move less when the camera tilts.
const Y = (c: SceneCtx, y: number, depth: number) => y + c.camY * depth;
const X = (c: SceneCtx, x: number, depth: number) => x + c.camX * depth;

function skyGradient(c: SceneCtx, top: RGB, bot: RGB, horizon: number, clip?: [number, number, number, number]): void {
  const { fb } = c;
  const [cx0, cy0, cx1, cy1] = (clip ?? [0, 0, W, H]).map((v) => Math.round(v * K));
  const steps = 14 * K;
  const off = c.camY * 0.5;
  for (let py = cy0; py < cy1; py++) {
    let f = (py / K - off) / Math.max(1, horizon);
    const above = f < 0 ? clamp(-f) : 0;
    f = clamp(f);
    const rowTop = above > 0 ? scale(top, 1 - above * 0.5) : top;
    // Each row only ever dithers between two neighbouring bands.
    const band = f * f * steps;
    const q0 = Math.floor(band);
    const frac = band - q0;
    const c0 = pack(mix(rowTop, bot, clamp(q0 / steps)));
    const c1 = pack(mix(rowTop, bot, clamp((q0 + 1) / steps)));
    const row = py * PW;
    for (let px = cx0; px < cx1; px++) fb.data[row + px] = frac + bayer(px, py) >= 1 ? c1 : c0;
  }
}

function stars(c: SceneCtx, amount: number, count = 110, maxY = HORIZON): void {
  if (amount <= 0.02) return;
  for (let i = 0; i < count; i++) {
    const x = Math.floor(((hash1(i * 3 + c.seed) * W - c.camX * 0.05) % W + W) % W);
    const y = Math.floor(Y(c, hash1(i * 7 + 1 + c.seed) * maxY, 0.5));
    const tw = 0.55 + 0.45 * Math.sin(c.t * (1 + hash1(i) * 3) + i);
    const b = hash1(i * 13) > 0.85 ? 255 : 190;
    c.fb.px(x, y, pack([b, b, Math.min(255, b + 20)]), amount * tw);
  }
}

function celestial(c: SceneCtx): void {
  const { p } = c;
  const x = X(c, p.celestialX * W, -0.08);
  const y = Y(c, p.celestialY * HORIZON, 0.5);
  if (p.sunAlpha > 0.02) {
    c.fb.glow(x, y, 40 + c.energy * 8, p.pal.sun, 0.4 * p.sunAlpha);
    c.fb.circle(x, y, 9, mix(p.pal.sun, [255, 255, 255], 0.25), p.sunAlpha > 0.3 ? 1 : 0);
  }
  if (p.moonAlpha > 0.02) {
    c.fb.glow(x, y, 28, p.pal.sun, 0.18 * p.moonAlpha);
    const a = p.moonAlpha > 0.3 ? 1 : 0;
    c.fb.circle(x, y, 6, [236, 236, 244], a);
    c.fb.circle(x + 3, y - 2, 5, mix(p.pal.skyTop, p.pal.skyBot, 0.2), a);
  }
}

function clouds(c: SceneCtx, amount: number, yMax = HORIZON - 10): void {
  if (amount <= 0.05) return;
  const n = Math.round(1 + amount * 12);
  const drift = c.t * (2 + c.p.wind * 10);
  for (let i = 0; i < n; i++) {
    const w = 30 + hash1(i * 5 + c.seed) * 50;
    const x = ((hash1(i + c.seed) * (W + 120) + drift * (0.5 + hash1(i * 2) * 0.5) - c.camX * 0.15) % (W + 120)) - 60;
    const y = Y(c, 8 + hash1(i * 9 + c.seed) * (yMax - 20), 0.5);
    const col = mix(c.p.pal.cloud, c.p.pal.skyBot, 0.25 + hash1(i * 4) * 0.3);
    const top = mix(c.p.pal.cloud, c.p.pal.light, 0.15);
    const a = 1;
    const flat = Y(c, 8 + hash1(i * 9 + c.seed) * (yMax - 20), 0.5) + 6;
    for (let k = 0; k < 5; k++) {
      const r = 4 + (2 - Math.abs(k - 2)) * 3 + hash1(i * 31 + k) * 2;
      const bx = x + (k - 2) * w * 0.16;
      const by = y + Math.abs(k - 2) * 1.5;
      c.fb.circle(bx, by, r + 1, col, a * 0.5);
      c.fb.circle(bx, by, r, col, a);
      c.fb.circle(bx - 1, by - 2, r * 0.6, top, a);
    }
    c.fb.rect(x - w * 0.42, flat - 2, w * 0.84, 3, col, a);
  }
}

function ridge(c: SceneCtx, base: number, amp: number, freq: number, depth: number, col: RGB, seedOff: number, alpha = 1): void {
  c.fb.fillBelow((x) => Y(c, base - fbm1((X(c, x, depth) + 1000) * freq, c.seed + seedOff) * amp, depth), col, alpha);
}

function snowCaps(c: SceneCtx, base: number, amp: number, freq: number, depth: number, seedOff: number): void {
  const snow = mix(c.p.pal.cloud, [255, 255, 255], 0.5);
  for (let x = 0; x < W; x++) {
    const h = fbm1((X(c, x, depth) + 1000) * freq, c.seed + seedOff);
    if (h < 0.62) continue;
    const top = Y(c, base - h * amp, depth);
    const depthPx = (h - 0.62) * amp * 0.9;
    for (let y = top; y < top + depthPx; y++) c.fb.px(x, y, pack(snow), 0.85);
  }
}

function water(c: SceneCtx, from: number, to: number, reflect: boolean): void {
  const { fb, p } = c;
  const top = Math.max(0, Math.floor(Y(c, from, 0.9) * K));
  const bottom = Math.min(fb.h, Math.floor(Y(c, to, 1) * K));
  const sunX = X(c, p.celestialX * W, -0.08);
  const glowA = Math.max(p.sunAlpha, p.moonAlpha);
  for (let py = top; py < bottom; py++) {
    const y = py / K;
    const d = (py - top) / Math.max(1, bottom - top);
    const base = mix(p.pal.water, p.pal.near, d * 0.6);
    const baseV = pack(base);
    const hiV = pack(mix(base, p.pal.skyBot, 0.45));
    const glint = pack(mix(base, p.pal.sun, 0.75 * glowA));
    const spread = 3 + d * 9;
    const row = py * PW;
    const wy = y * 0.6 + c.t * 0.3;
    let wave = 0;
    for (let px = 0; px < PW; px++) {
      const x = px / K;
      let v = baseV;
      // The wave field is low-frequency: sampling it once per logical column is indistinguishable and K times cheaper.
      if (px % K === 0) wave = noise2((X(c, x, 0.9) + c.t * 6) * 0.08, wy, c.seed);
      if (wave > 0.72 - c.energy * 0.08) v = hiV;
      if (reflect && glowA > 0.05 && Math.abs(x - sunX) < spread && wave > 0.45 && hash2(px + Math.floor(c.t * 6), py) > 0.35) v = glint;
      fb.data[row + px] = v;
    }
  }
}

function citySkyline(c: SceneCtx, base: number, depth: number, col: RGB, minH: number, maxH: number, winAlpha: number, seedOff: number): void {
  let x = -20 - ((c.camX * depth) % 20);
  let i = Math.floor((c.camX * depth) / 20);
  while (x < W + 20) {
    const r = hash1(i * 11 + c.seed + seedOff);
    const bw = 10 + Math.floor(r * 18);
    const bh = minH + Math.floor(hash1(i * 7 + seedOff) * (maxH - minH));
    const top = Y(c, base - bh, depth);
    c.fb.rect(x, top, bw - 1, H, col);
    if (winAlpha > 0.02) {
      for (let wy = top + 3; wy < Y(c, base, depth) - 2; wy += 4) {
        for (let wx = x + 2; wx < x + bw - 3; wx += 3) {
          const lit = hash2(Math.floor(wx) + i * 97, Math.floor(wy) + Math.floor(c.t * 0.2 + hash1(wx) * 3)) < 0.35 * winAlpha;
          if (lit) c.fb.px(wx, wy, pack(c.p.pal.light), 0.6 + winAlpha * 0.4);
        }
      }
    }
    x += bw;
    i++;
  }
}

function pines(c: SceneCtx, base: number, depth: number, col: RGB, size: number, spacing: number, seedOff: number, alpha = 1): void {
  const shift = (c.camX * depth) % spacing;
  const start = Math.floor((c.camX * depth) / spacing);
  for (let k = -1; k < W / spacing + 2; k++) {
    const i = start + k;
    const h = size * (0.6 + hash1(i * 13 + seedOff + c.seed) * 0.6);
    const x = k * spacing - shift + hash1(i * 5 + seedOff) * spacing * 0.6;
    const yb = Y(c, base + hash1(i * 3 + seedOff) * 4, depth);
    const sway = Math.sin(c.t * 1.5 + i) * c.p.wind * 1.5;
    for (let r = 0; r < h; r++) {
      const w = (r / h) * h * 0.38;
      c.fb.rect(x - w + sway * (1 - r / h), yb - h + r, w * 2 + 1, 1, col, alpha);
    }
    c.fb.rect(x, yb, 1, 3, col, alpha);
  }
}

function groundFill(c: SceneCtx, y: number, col: RGB, depth = 1): void {
  c.fb.rect(0, Y(c, y, depth), W, H, col);
}

function rays(c: SceneCtx): void {
  const { p } = c;
  if (p.sunAlpha < 0.3 || p.daylight > 0.9) return;
  const sx = X(c, p.celestialX * W, -0.08);
  const sy = Y(c, p.celestialY * HORIZON, 0.5);
  const col = mix(p.pal.sun, [255, 255, 255], 0.2);
  const strength = 0.07 * p.sunAlpha * (1 - p.cloud * 0.5) * (0.8 + c.energy * 0.4);
  for (let r = 0; r < 7; r++) {
    // Rays fan downward and breathe slowly, so the light feels alive without flickering.
    const ang = Math.PI / 2 + (r - 3) * 0.32 + Math.sin(c.t * 0.15 + r) * 0.04;
    const dx = Math.cos(ang);
    const dy = Math.sin(ang);
    for (let d = 12; d < 220; d += 1) {
      const w = 1 + d * 0.06;
      const fade = strength * (1 - d / 220);
      const cx = sx + dx * d;
      const cy = sy + dy * d;
      for (let k = -w; k <= w; k += 1) c.fb.blend(cx - dy * k, cy + dx * k, col, fade);
    }
  }
}

const SAND: RGB = [214, 172, 112];
const SNOW: RGB = [232, 238, 248];

type SettingDraw = (c: SceneCtx) => void;

const SETTINGS: Record<Setting, SettingDraw> = {
  mountains(c) {
    ridge(c, 100, 60, 0.012, 0.2, c.p.pal.far, 1);
    snowCaps(c, 100, 60, 0.012, 0.2, 1);
    ridge(c, 118, 40, 0.02, 0.45, c.p.pal.mid, 2);
    ridge(c, 150, 24, 0.03, 1, c.p.pal.near, 3);
  },
  lake(c) {
    ridge(c, 104, 50, 0.014, 0.2, c.p.pal.far, 1);
    snowCaps(c, 104, 50, 0.014, 0.2, 1);
    pines(c, 112, 0.45, c.p.pal.mid, 12, 7, 2);
    water(c, 112, 160, true);
    c.fb.fillBelow((x) => Y(c, 160 - fbm1(X(c, x, 1) * 0.04, c.seed + 4) * 10, 1), c.p.pal.near);
  },
  ocean(c) {
    water(c, 108, H + 40, true);
  },
  beach(c) {
    water(c, 104, 150, true);
    const sand = mix(SAND, c.p.pal.near, 1 - c.p.daylight * 0.75);
    c.fb.fillBelow((x) => Y(c, 146 + Math.sin(X(c, x, 1) * 0.03) * 3, 1), sand);
    const foam = mix(c.p.pal.cloud, [255, 255, 255], 0.4);
    const surf = Math.sin(c.t * 0.8) * 3;
    for (let x = 0; x < W; x++) {
      const y = Y(c, 146 + Math.sin(X(c, x, 1) * 0.03) * 3 - 2 + surf + noise2(x * 0.1, c.t, 9) * 2, 1);
      c.fb.px(x, y, pack(foam), 0.8);
    }
  },
  city(c) {
    const lit = c.p.lights;
    citySkyline(c, 128, 0.3, c.p.pal.far, 18, 60, lit * 0.5, 1);
    citySkyline(c, 150, 0.7, c.p.pal.mid, 14, 46, lit, 2);
    groundFill(c, 150, c.p.pal.near);
    for (let x = 0; x < W; x += 1) {
      const dash = Math.floor((X(c, x, 1) + 4000) / 10) % 2 === 0;
      if (dash) c.fb.px(x, Y(c, 163, 1), pack(mix(c.p.pal.near, c.p.pal.light, 0.25)));
    }
  },
  forest(c) {
    ridge(c, 108, 18, 0.02, 0.15, c.p.pal.far, 1);
    pines(c, 118, 0.3, mix(c.p.pal.far, c.p.pal.mid, 0.5), 18, 8, 2);
    pines(c, 136, 0.6, c.p.pal.mid, 30, 14, 3);
    groundFill(c, 148, c.p.pal.near);
    pines(c, 168, 1, scale(c.p.pal.near, 0.8), 70, 44, 4);
  },
  field(c) {
    ridge(c, 116, 16, 0.01, 0.2, c.p.pal.far, 1);
    ridge(c, 132, 18, 0.016, 0.5, c.p.pal.mid, 2);
    ridge(c, 152, 10, 0.02, 1, c.p.pal.near, 3);
    const grass = mix(c.p.pal.near, [90, 150, 70], 0.25 * c.p.daylight);
    for (let i = 0; i < 160; i++) {
      const x = (((hash1(i + c.seed) * W - c.camX) % W) + W) % W;
      const y = Y(c, 156 + hash1(i * 3) * 24, 1);
      const bend = Math.sin(c.t * 2 + i * 0.3) * (1 + c.p.wind * 2);
      c.fb.line(x, y, x + bend, y - 3 - hash1(i * 7) * 3, grass);
    }
  },
  desert(c) {
    const day = c.p.daylight;
    ridge(c, 116, 20, 0.008, 0.2, mix(mix(SAND, c.p.pal.far, 0.6), c.p.pal.far, 1 - day), 1);
    ridge(c, 136, 18, 0.012, 0.5, mix(mix(SAND, c.p.pal.mid, 0.4), c.p.pal.mid, 1 - day), 2);
    ridge(c, 158, 12, 0.016, 1, mix(mix(SAND, c.p.pal.near, 0.3), c.p.pal.near, 1 - day * 0.8), 3);
    const cx = X(c, 60, -1);
    const base = Y(c, 160, 1);
    const ink = scale(c.p.pal.near, 0.7);
    c.fb.rect(cx, base - 22, 3, 22, ink);
    c.fb.rect(cx - 5, base - 14, 5, 2, ink);
    c.fb.rect(cx - 5, base - 19, 2, 6, ink);
    c.fb.rect(cx + 3, base - 11, 4, 2, ink);
    c.fb.rect(cx + 5, base - 16, 2, 6, ink);
  },
  sky(c) {
    const col = mix(c.p.pal.cloud, c.p.pal.skyBot, 0.25);
    for (let layer = 0; layer < 3; layer++) {
      const base = 136 + layer * 16;
      const shade = mix(col, c.p.pal.mid, layer * 0.2);
      c.fb.fillBelow(
        (x) => Y(c, base - Math.abs(Math.sin((X(c, x, 0.3 + layer * 0.3) + c.t * (3 + layer * 2)) * (0.04 + layer * 0.01) + layer)) * 12, 0.4 + layer * 0.3),
        shade,
      );
    }
  },
  space(c) {
    const neb = c.p.pal.accent;
    for (let y = 0; y < H; y += 2) {
      for (let x = 0; x < W; x += 2) {
        const n = noise2((x + c.camX * 0.1) * 0.02, (y - c.camY * 0.5) * 0.03, c.seed);
        if (n > 0.62) c.fb.rect(x, y, 2, 2, mix(c.p.pal.skyTop, neb, (n - 0.62) * 1.6), 0.7);
      }
    }
    stars(c, 1, 260, H);
  },
  room(c) {
    const lights = c.p.lights;
    const wall = mix(scale(c.p.pal.near, 1.6), c.p.pal.light, 0.08 + 0.18 * lights);
    c.fb.rect(0, 0, W, H, wall);
    const wx = X(c, 190, 1), wy = Y(c, 34, 1), ww = 90, wh = 70;
    const clip: [number, number, number, number] = [
      Math.max(0, Math.floor(wx)), Math.max(0, Math.floor(wy)), Math.min(W, Math.floor(wx + ww)), Math.min(H, Math.floor(wy + wh)),
    ];
    if (clip[2] > clip[0] && clip[3] > clip[1]) {
      skyGradient(c, c.p.pal.skyTop, c.p.pal.skyBot, wy + wh - c.camY * 0.5, clip);
      for (let i = 0; i < 40 * c.p.stars; i++) {
        const sx = clip[0] + hash1(i + c.seed) * (clip[2] - clip[0]);
        const sy = clip[1] + hash1(i * 3 + c.seed) * (clip[3] - clip[1]) * 0.7;
        c.fb.px(sx, sy, pack([220, 220, 240]), 0.5 + 0.5 * Math.sin(c.t + i));
      }
      if (c.p.moonAlpha > 0.3) c.fb.circle(wx + 64, wy + 18, 5, [236, 236, 244]);
      if (c.p.sunAlpha > 0.1) c.fb.glow(wx + 64, wy + 30, 30, c.p.pal.sun, 0.5 * c.p.sunAlpha);
      citySkyline(c, wy + wh + 2, 0.2, c.p.pal.far, 6, 22, lights * 0.6, 7);
      c.fb.rect(0, 0, W, Math.max(0, wy), wall);
      c.fb.rect(0, wy + wh, W, H, wall);
      c.fb.rect(0, wy, Math.max(0, wx), wh, wall);
      c.fb.rect(wx + ww, wy, W, wh, wall);
    }
    const frame = scale(wall, 0.6);
    c.fb.rect(wx - 3, wy - 3, ww + 6, 3, frame);
    c.fb.rect(wx - 3, wy + wh, ww + 6, 4, frame);
    c.fb.rect(wx - 3, wy, 3, wh, frame);
    c.fb.rect(wx + ww, wy, 3, wh, frame);
    c.fb.rect(wx + ww / 2 - 1, wy, 2, wh, frame);
    groundFill(c, 150, scale(wall, 0.55));
    const ink = scale(c.p.pal.near, 0.6);
    c.fb.rect(X(c, 20, 1), Y(c, 128, 1), 80, 22, ink);
    c.fb.rect(X(c, 20, 1), Y(c, 118, 1), 8, 32, ink);
    const lx = X(c, 140, 1), ly = Y(c, 108, 1);
    c.fb.rect(lx, ly + 10, 2, 32, ink);
    c.fb.rect(lx - 5, ly, 12, 10, mix(ink, c.p.pal.light, lights * 0.8));
    c.fb.glow(lx + 1, ly + 8, 50, c.p.pal.light, 0.35 * lights);
  },
  road(c) {
    ridge(c, 108, 16, 0.012, 0.2, c.p.pal.far, 1);
    groundFill(c, 112, c.p.pal.mid, 1);
    const vy = Y(c, 112, 1);
    const span = H - vy + 1e-6;
    const roadCol = scale(c.p.pal.near, 0.9);
    const lineCol = mix(roadCol, c.p.pal.light, 0.7);
    // Each row slides with its own depth, so the road pivots on the vanishing point as the camera drifts.
    const centre = (d: number) => W / 2 - c.camX * d;
    for (let py = Math.max(0, Math.floor(vy * K)); py < c.fb.h; py++) {
      const y = py / K;
      const d = (y - vy) / span;
      const cx = centre(d);
      const half = 2 + d * 150;
      c.fb.rect(cx - half, y, half * 2, 1 / K, roadCol);
      const z = 1 / Math.max(0.02, d);
      const stripe = (((Math.floor(z * 2 - c.travel * 10) % 2) + 2) % 2) === 0;
      if (stripe && d > 0.02) c.fb.rect(cx - Math.max(0.5, d * 3), y, Math.max(1 / K, d * 6), 1 / K, lineCol);
    }
    const post = scale(c.p.pal.near, 0.6);
    for (let k = 0; k < 5; k++) {
      const z = (((k / 5 + c.travel * 0.25) % 1) + 1) % 1;
      const d = z * z;
      const y = vy + d * span;
      const off = 2 + d * 150 + 6 + d * 30;
      for (const side of [-1, 1]) c.fb.rect(centre(d) + side * off, y - d * 50, Math.max(1 / K, d * 4), d * 50, post);
    }
  },
  river(c) {
    ridge(c, 106, 22, 0.012, 0.2, c.p.pal.far, 1);
    pines(c, 114, 0.35, mix(c.p.pal.far, c.p.pal.mid, 0.5), 12, 9, 2);
    groundFill(c, 116, c.p.pal.mid, 1);
    const top = Math.max(0, Math.floor(Y(c, 116, 1) * K));
    const phase = (c.seed % 100) * 0.06;
    const ph = c.fb.h;
    for (let py = top; py < ph; py++) {
      const y = py / K;
      const d = (py - top) / Math.max(1, ph - top);
      // The bend dies out toward the viewer so the river always reaches the bottom-centre,
      // where "center" subjects (a boat, a swimmer) stand.
      const bend = Math.sin(d * 4 + phase) * 34 * (1 - d) - c.camX * d;
      const half = (2 + d * d * 95) * K;
      const cx = (W / 2 + bend) * K;
      const bank = mix(c.p.pal.mid, c.p.pal.near, d);
      const row = py * PW;
      c.fb.data.fill(pack(bank), row, row + PW);
      const water = mix(mix(c.p.pal.water, c.p.pal.skyTop, 0.6), c.p.pal.skyBot, 0.18 * (1 - d));
      const wv = pack(water);
      const edgeV = pack(mix(water, bank, 0.5));
      const hiV = pack(mix(water, c.p.pal.skyBot, 0.45));
      for (let px = Math.max(0, Math.floor(cx - half)); px < Math.min(PW, cx + half); px++) {
        // Stretched horizontally so highlights read as ripples, not gravel.
        const flow = noise2((px - cx) * (0.05 / K), y * 0.9 - c.t * (1.5 + c.energy * 2), c.seed);
        const edge = Math.abs(px - cx) > half - 1.5 * K;
        c.fb.data[row + px] = edge ? edgeV : flow > 0.72 ? hiV : wv;
      }
    }
    const reed = scale(c.p.pal.near, 0.7);
    for (let i = 0; i < 40; i++) {
      const x = hash1(i + c.seed) * W;
      const h = 6 + hash1(i * 3) * 12;
      const sway = Math.sin(c.t * 1.6 + i) * (1 + c.p.wind * 2);
      c.fb.line(x, H, x + sway, H - h, reed);
    }
  },
  flower_field(c) {
    ridge(c, 112, 18, 0.01, 0.2, c.p.pal.far, 1);
    ridge(c, 128, 14, 0.016, 0.5, c.p.pal.mid, 2);
    const ground = mix(c.p.pal.near, [70, 120, 60], 0.35 * c.p.daylight);
    c.fb.fillBelow((x) => Y(c, 140 + Math.sin(X(c, x, 1) * 0.02) * 4, 1), ground);
    const petals: RGB[] = [c.p.pal.accent, mix([246, 196, 40], c.p.pal.near, 0.35 * (1 - c.p.daylight)), mix([255, 255, 255], c.p.pal.skyBot, 0.3)];
    for (let i = 0; i < 520; i++) {
      const d = hash1(i * 7 + c.seed);
      const y = Y(c, 140 + d * d * 44, 1);
      const x = ((hash1(i + c.seed) * (W + 40) - c.camX * (0.4 + d) + Math.sin(c.t * 1.4 + i) * d * (1 + c.p.wind * 2)) % (W + 40) + W + 40) % (W + 40) - 20;
      const col = pack(petals[i % petals.length]);
      c.fb.px(x, y, col);
      if (d > 0.5) {
        c.fb.px(x + 1, y, col);
        c.fb.px(x, y - 1, col);
      }
      if (d > 0.8) {
        c.fb.px(x - 1, y, col);
        c.fb.px(x, y + 1, pack(scale(ground, 0.7)));
      }
    }
  },
  club(c) {
    const e = c.energy;
    const wall = mix([14, 8, 26], c.p.pal.accent, 0.08);
    for (let y = 0; y < H; y++) c.fb.rect(0, y, W, 1, scale(wall, 0.6 + (y / H) * 0.6));
    const beams: RGB[] = [c.p.pal.accent, [80, 200, 255], [255, 90, 200], [255, 220, 90]];
    for (let b = 0; b < 5; b++) {
      const ox = 40 + b * 60;
      const ang = Math.PI / 2 + Math.sin(c.t * (0.6 + b * 0.17) + b) * 0.6;
      const col = beams[b % beams.length];
      for (let d = 0; d < 200; d++) {
        const w = 1 + d * 0.12;
        const cx = ox + Math.cos(ang) * d;
        const cy = Math.sin(ang) * d;
        for (let k = -w; k <= w; k++) c.fb.blend(cx + k, cy, col, (0.05 + e * 0.07) * (1 - d / 200));
      }
      c.fb.circle(ox, 2, 3, col);
    }
    const floorTop = Math.floor(Y(c, 132, 1) * K);
    const dark = pack(scale(wall, 0.5));
    const ph = c.fb.h;
    for (let py = Math.max(0, floorTop); py < ph; py++) {
      const d = (py - floorTop) / (ph - floorTop);
      const rowTile = Math.floor(Math.log(1 + d * 9) * 4);
      for (let px = 0; px < PW; px++) {
        const colTile = Math.floor((px / K - W / 2) / (20 + d * 60) + 50);
        const lit = hash2(colTile + rowTile * 31, Math.floor(c.t * (1 + e * 3))) < 0.25 + e * 0.3;
        c.fb.data[py * PW + px] = lit ? pack(mix(beams[(colTile + rowTile) % beams.length], [0, 0, 0], 0.55 - d * 0.2)) : dark;
      }
    }
    const ball = Y(c, 22, 0.5);
    c.fb.line(W / 2, 0, W / 2, ball - 7, [90, 90, 100]);
    c.fb.circle(W / 2, ball, 7, [170, 170, 190]);
    for (let i = 0; i < 6; i++) c.fb.px(W / 2 - 5 + hash1(i + Math.floor(c.t * 4)) * 10, ball - 5 + hash1(i * 3 + Math.floor(c.t * 4)) * 10, pack([255, 255, 255]));
  },
  rooftop(c) {
    citySkyline(c, 132, 0.25, c.p.pal.far, 20, 70, c.p.lights * 0.6, 1);
    citySkyline(c, 150, 0.5, c.p.pal.mid, 10, 40, c.p.lights, 2);
    const roof = scale(c.p.pal.near, 0.9);
    groundFill(c, 156, roof);
    c.fb.rect(0, Y(c, 152, 1), W, 4, scale(roof, 1.25));
    const tx = X(c, 34, -1);
    const ty = Y(c, 152, 1);
    c.fb.rect(tx, ty - 34, 22, 20, roof);
    c.fb.rect(tx - 2, ty - 37, 26, 3, roof);
    for (const lx of [tx + 2, tx + 19]) c.fb.rect(lx, ty - 14, 1, 14, roof);
    const ax = X(c, 280, -1);
    c.fb.rect(ax, ty - 46, 1, 46, roof);
    if (Math.sin(c.t * 2.5) > 0) c.fb.px(ax, ty - 47, pack([255, 60, 60]));
  },
  snowfield(c) {
    const snowTone = (k: RGB, amt: number) => mix(k, mix(SNOW, c.p.pal.skyBot, 0.3), amt * (0.4 + c.p.daylight * 0.5));
    ridge(c, 108, 30, 0.012, 0.2, snowTone(c.p.pal.far, 0.7), 1);
    pines(c, 122, 0.4, c.p.pal.mid, 14, 16, 2);
    ridge(c, 136, 14, 0.016, 0.6, snowTone(c.p.pal.mid, 0.8), 3);
    ridge(c, 156, 8, 0.02, 1, snowTone(c.p.pal.near, 0.9), 4);
  },
};

export function drawBackdrop(c: SceneCtx, setting: Setting): void {
  if (setting === "space") {
    c.fb.clear(scale(c.p.pal.skyTop, 0.35));
  } else if (setting !== "room" && setting !== "club") {
    skyGradient(c, c.p.pal.skyTop, c.p.pal.skyBot, HORIZON);
    stars(c, c.p.stars);
    celestial(c);
    rays(c);
    clouds(c, c.p.cloud);
  }
  (SETTINGS[setting] ?? SETTINGS.field)(c);
}

// Settings drawn in perspective, running away from the viewer: movement there is along the
// depth axis (toward or away), never sideways across the screen.
export const DEPTH_SETTINGS = new Set<Setting>(["road", "river"]);

// Where ground-bound subjects stand, by position depth. `top` is where perspective ground starts.
export function groundY(setting: Setting): { near: number; far: number; floats: boolean; top?: number } {
  switch (setting) {
    case "sky":
    case "space":
      return { near: 128, far: 100, floats: true };
    case "ocean":
      return { near: 150, far: 108, floats: false };
    case "beach":
      return { near: 164, far: 104, floats: false };
    case "lake":
      return { near: 166, far: 112, floats: false };
    case "room":
      return { near: 160, far: 150, floats: false };
    case "road":
      return { near: 172, far: 116, floats: false, top: 112 };
    case "river":
      return { near: 170, far: 120, floats: false, top: 116 };
    case "club":
      return { near: 166, far: 136, floats: false };
    case "rooftop":
      return { near: 154, far: 132, floats: false };
    default:
      return { near: 164, far: 116, floats: false };
  }
}
