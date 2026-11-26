import type { Particles } from "../scene/vocab";
import { H, K, mix, pack, PW, scale, W, type FB, type RGB } from "./fb";
import { hash1, noise2 } from "./noise";
import type { WorldParams } from "./palette";

// Particles are stateless: position is a pure function of (index, time), so seeking
// or scrubbing lands on the right frame with no simulation to replay.

const wrap = (v: number, m: number) => ((v % m) + m) % m;

export function drawWeather(fb: FB, p: WorldParams, t: number, energy: number, clip?: [number, number, number, number]): number {
  const [x0, y0, x1, y1] = clip ?? [0, 0, W, H];
  const cw = x1 - x0;
  const ch = y1 - y0;
  const inClip = (x: number, y: number) => x >= x0 && x < x1 && y >= y0 && y < y1;
  const speed = 0.7 + energy * 0.6;

  if (p.fog > 0.02 && !clip) {
    // Real alpha blend: dithered fog at low density reads as noise, not haze.
    const [fr, fg, fbb] = p.pal.fog;
    const d = fb.data;
    for (let py = 50 * K; py < fb.h; py++) {
      const y = py / K;
      const band = Math.min(1, (y - 50) / 60) * p.fog;
      // Fog is very low-frequency, so one sample per 4 pixels is enough.
      for (let px = 0; px < PW; px += 4) {
        const a = band * (noise2((px / K) * 0.018 + t * 0.06, y * 0.06, 3) * 0.9 + 0.1);
        for (let k = 0; k < 4; k++) {
          const i = py * PW + px + k;
          const v = d[i];
          const r = (v & 0xff) + (fr - (v & 0xff)) * a;
          const g = ((v >> 8) & 0xff) + (fg - ((v >> 8) & 0xff)) * a;
          const b = ((v >> 16) & 0xff) + (fbb - ((v >> 16) & 0xff)) * a;
          d[i] = (0xff000000 | (b << 16) | (g << 8) | r) >>> 0;
        }
      }
    }
  }

  if (p.rain > 0.02) {
    const n = Math.round(p.rain * (clip ? 60 : 220) * (1 + p.storm * 0.5));
    const col = mix(p.pal.skyBot, [220, 230, 255], 0.5);
    const slant = p.wind * 0.45 + 0.08;
    for (let i = 0; i < n; i++) {
      const fall = (160 + hash1(i * 3) * 80) * speed;
      const y = y0 + wrap(hash1(i * 7) * ch + t * fall, ch);
      const x = x0 + wrap(hash1(i) * cw + t * fall * slant, cw);
      const len = 3 + Math.round(hash1(i * 11) * 3);
      for (let k = 0; k < len; k++) {
        const px = x - k * slant;
        const py = y - k;
        if (inClip(px, py)) fb.px(px, py, pack(col), 0.75);
      }
    }
  }

  if (p.snow > 0.02) {
    const n = Math.round(p.snow * (clip ? 50 : 170));
    for (let i = 0; i < n; i++) {
      const fall = (12 + hash1(i * 3) * 20) * speed;
      const y = y0 + wrap(hash1(i * 7) * ch + t * fall, ch);
      const x = x0 + wrap(hash1(i) * cw + Math.sin(t * 1.3 + i) * 6 + t * p.wind * 20, cw);
      if (inClip(x, y)) fb.px(x, y, pack([240, 244, 255]), 0.9);
      if (hash1(i * 13) > 0.7 && inClip(x + 1, y)) fb.px(x + 1, y, pack([240, 244, 255]), 0.9);
    }
  }

  if (p.wind > 0.4 && !clip) {
    const n = Math.round((p.wind - 0.4) * 30);
    const col = mix(p.pal.skyBot, [255, 255, 255], 0.4);
    for (let i = 0; i < n; i++) {
      const x = wrap(hash1(i * 5) * W * 2 + t * 260 * speed, W * 2) - W / 2;
      const y = 30 + hash1(i * 9) * 120 + Math.sin(t * 2 + i) * 4;
      fb.line(x, y, x + 14 + hash1(i) * 20, y + 1, col, 0.35);
    }
  }

  // Storm lightning: deterministic per 2 s window so it replays identically after a seek.
  if (p.storm > 0.1 && !clip) {
    const epoch = Math.floor(t / 2);
    if (hash1(epoch * 31) < p.storm * 0.4) {
      const at = epoch * 2 + hash1(epoch * 17) * 1.6;
      const dt = t - at;
      if (dt >= 0 && dt < 0.35) {
        drawBolt(fb, 40 + hash1(epoch) * 240, epoch, 1 - dt / 0.35);
        return (1 - dt / 0.35) * 0.6;
      }
    }
  }
  return 0;
}

export function drawBolt(fb: FB, x: number, seed: number, a: number): void {
  let y = 0;
  let cx = x;
  const col: RGB = [250, 250, 255];
  while (y < 110) {
    const nx = cx + (hash1(seed * 7 + y) - 0.5) * 14;
    const ny = y + 6 + hash1(seed + y) * 8;
    fb.line(cx, y, nx, ny, col, a);
    fb.line(cx + 1, y, nx + 1, ny, col, a * 0.6);
    cx = nx;
    y = ny;
  }
}

export function drawParticles(fb: FB, kind: Particles, amount: number, p: WorldParams, t: number, energy: number): void {
  if (kind === "none" || amount <= 0.01) return;
  const dens = amount * (0.6 + energy * 0.8);
  switch (kind) {
    case "fireflies": {
      const n = Math.round(36 * dens);
      for (let i = 0; i < n; i++) {
        const x = wrap(hash1(i) * W + (noise2(i, t * 0.15, 1) - 0.5) * 80, W);
        const y = 70 + hash1(i * 3) * 100 + (noise2(i, t * 0.15 + 9, 2) - 0.5) * 40;
        const blink = Math.max(0, Math.sin(t * (1.5 + hash1(i * 5)) + i * 2));
        if (blink > 0.1) {
          fb.px(x, y, pack(mix(p.pal.light, [220, 255, 140], 0.4)), amount);
          fb.glow(x, y, 4, p.pal.light, 0.35 * blink * amount);
        }
      }
      return;
    }
    case "petals":
    case "leaves":
    case "confetti":
    case "ash": {
      const n = Math.round((kind === "ash" ? 80 : 50) * dens);
      const cols: RGB[] =
        kind === "petals" ? [mix(p.pal.accent, [255, 220, 230], 0.5), [255, 190, 210]]
        : kind === "leaves" ? [[200, 110, 40], [170, 70, 30], [210, 160, 50]]
        : kind === "ash" ? [scale(p.pal.fog, 0.8), [140, 140, 140]]
        : [[240, 80, 90], [80, 200, 240], [250, 220, 80], [140, 240, 120], [220, 120, 240]];
      const fall = kind === "ash" ? 10 : kind === "confetti" ? 34 : 22;
      for (let i = 0; i < n; i++) {
        const sp = fall * (0.7 + hash1(i * 3) * 0.6);
        const y = wrap(hash1(i * 7) * (H + 20) + t * sp, H + 20) - 10;
        const x = wrap(hash1(i) * W + t * sp * 0.6 + Math.sin(t * 1.7 + i) * 8, W);
        const flip = Math.sin(t * 5 + i) > 0;
        const col = pack(cols[i % cols.length]);
        fb.px(x, y, col, amount);
        if (kind !== "ash") fb.px(flip ? x + 1 : x, flip ? y : y + 1, col, amount);
      }
      return;
    }
    case "embers": {
      const n = Math.round(50 * dens);
      for (let i = 0; i < n; i++) {
        const sp = 18 + hash1(i * 3) * 26;
        const y = H - wrap(hash1(i * 7) * H + t * sp, H);
        const x = wrap(hash1(i) * W + Math.sin(t * 2 + i) * 6, W);
        const heat = 1 - (H - y) / H;
        fb.px(x, y, pack(mix([255, 90, 30], [255, 220, 120], hash1(i * 9))), amount * (0.4 + heat * 0.6));
      }
      return;
    }
    case "sparkles": {
      const n = Math.round(40 * dens);
      const col = pack(mix(p.pal.light, [255, 255, 255], 0.6));
      for (let i = 0; i < n; i++) {
        const cycle = 0.8 + hash1(i * 5) * 0.8;
        const k = Math.floor((t + hash1(i) * cycle) / cycle);
        const ph = ((t + hash1(i) * cycle) % cycle) / cycle;
        const x = hash1(i * 7 + k * 131) * W;
        const y = hash1(i * 11 + k * 71) * 150;
        const s = Math.sin(ph * Math.PI);
        fb.px(x, y, col, amount);
        if (s > 0.6) {
          fb.px(x - 1, y, col, amount * s);
          fb.px(x + 1, y, col, amount * s);
          fb.px(x, y - 1, col, amount * s);
          fb.px(x, y + 1, col, amount * s);
        }
      }
      return;
    }
    case "bubbles": {
      const n = Math.round(30 * dens);
      const col = mix(p.pal.skyBot, [255, 255, 255], 0.6);
      for (let i = 0; i < n; i++) {
        const sp = 14 + hash1(i * 3) * 18;
        const y = H - wrap(hash1(i * 7) * H + t * sp, H);
        const x = wrap(hash1(i) * W + Math.sin(t * 1.5 + i) * 5, W);
        const r = 1 + Math.floor(hash1(i * 13) * 3);
        for (let a = 0; a < 12; a++) fb.px(x + Math.cos(a * 0.52) * r, y + Math.sin(a * 0.52) * r, pack(col), amount * 0.8);
      }
      return;
    }
    case "fireworks": {
      const cols: RGB[] = [p.pal.accent, [255, 220, 90], [120, 220, 255], [255, 120, 200], [180, 255, 140]];
      for (let i = 0; i < 4; i++) {
        const period = 2.2 + hash1(i) * 1.6;
        const local = (t + hash1(i * 3) * period) % period;
        const k = Math.floor((t + hash1(i * 3) * period) / period);
        const cx = 40 + hash1(i * 7 + k) * (W - 80);
        const cy = 25 + hash1(i * 11 + k) * 55;
        const col = pack(cols[(i + k) % cols.length]);
        if (local < 0.5) {
          // The shell climbing to its burst point.
          const yy = H - (H - cy) * (local / 0.5);
          fb.px(cx, yy, col, amount);
          continue;
        }
        const age = (local - 0.5) / (period - 0.5);
        const r = 4 + age * (18 + energy * 10);
        const fade = amount * (1 - age);
        for (let s = 0; s < 18; s++) {
          const a = (s / 18) * Math.PI * 2;
          fb.px(cx + Math.cos(a) * r, cy + Math.sin(a) * r + age * age * 10, col, fade);
        }
        if (age < 0.15) fb.glow(cx, cy, 14, cols[(i + k) % cols.length], 0.4 * amount);
      }
      return;
    }
    case "hearts": {
      const n = Math.round(16 * dens);
      const shape = [[0, 0], [2, 0], [-1, 1], [0, 1], [1, 1], [2, 1], [3, 1], [0, 2], [1, 2], [2, 2], [1, 3]];
      const col = pack(mix(p.pal.accent, [255, 120, 160], 0.4));
      for (let i = 0; i < n; i++) {
        const sp = 10 + hash1(i * 3) * 14;
        const y = H - wrap(hash1(i * 7) * H + t * sp, H);
        const x = wrap(hash1(i) * W + Math.sin(t * 1.2 + i) * 8, W);
        for (const [dx, dy] of shape) fb.px(x + dx, y + dy, col, amount * (0.5 + (y / H) * 0.5));
      }
      return;
    }
    case "stars_falling": {
      for (let i = 0; i < 6; i++) {
        const period = 2.5 + hash1(i) * 2;
        const ph = ((t + hash1(i * 3) * period) % period) / period;
        if (ph > 0.4) continue;
        const k = Math.floor((t + hash1(i * 3) * period) / period);
        const sx = hash1(i * 7 + k) * W;
        const sy = hash1(i * 11 + k) * 50;
        const d = ph / 0.4;
        drawStreak(fb, sx + d * 90, sy + d * 40, amount * (1 - d));
      }
      return;
    }
  }
}

export function drawStreak(fb: FB, x: number, y: number, a: number): void {
  for (let k = 0; k < 14; k++) fb.px(x - k * 2, y - k, pack([255, 255, 240]), a * (1 - k / 14));
}
