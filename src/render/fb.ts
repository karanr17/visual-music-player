// Scenes are authored in a 320x180 logical space; the framebuffer holds K physical pixels per
// logical pixel, so shapes, gradients and motion get K times finer without re-authoring art.
export const W = 320;
export const H = 180;
export const K = 2;
export const PW = W * K;
export const PH = H * K;

export type RGB = [number, number, number];

// ImageData is RGBA bytes; on little-endian hosts (every browser target) a Uint32 view reads them as ABGR.
export const pack = (c: RGB): number => (0xff000000 | (c[2] << 16) | (c[1] << 8) | c[0]) >>> 0;
export const unpack = (v: number): RGB => [v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff];

export const clamp = (v: number, lo = 0, hi = 1) => (v < lo ? lo : v > hi ? hi : v);
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
export const smooth = (t: number) => {
  const x = clamp(t);
  return x * x * (3 - 2 * x);
};
export const mix = (a: RGB, b: RGB, t: number): RGB => [
  Math.round(lerp(a[0], b[0], t)),
  Math.round(lerp(a[1], b[1], t)),
  Math.round(lerp(a[2], b[2], t)),
];
export const scale = (c: RGB, k: number): RGB => [
  Math.min(255, Math.round(c[0] * k)),
  Math.min(255, Math.round(c[1] * k)),
  Math.min(255, Math.round(c[2] * k)),
];

const B8 = [
  0, 32, 8, 40, 2, 34, 10, 42, 48, 16, 56, 24, 50, 18, 58, 26, 12, 44, 4, 36, 14, 46, 6, 38, 60, 28, 52, 20, 62, 30, 54, 22,
  3, 35, 11, 43, 1, 33, 9, 41, 51, 19, 59, 27, 49, 17, 57, 25, 15, 47, 7, 39, 13, 45, 5, 37, 63, 31, 55, 23, 61, 29, 53, 21,
];
const BAYER = Float32Array.from(B8, (v) => (v + 0.5) / 64);

export const bayer = (x: number, y: number): number => BAYER[((y & 7) << 3) | (x & 7)];

export class FB {
  readonly data: Uint32Array;
  readonly w = PW;
  readonly h = PH;
  constructor() {
    this.data = new Uint32Array(PW * PH);
  }

  clear(c: RGB): void {
    this.data.fill(pack(c));
  }

  copyFrom(o: FB): void {
    this.data.set(o.data);
  }

  // Physical-pixel write. Partial alpha is an ordered-dither threshold, not a blend.
  dot(px: number, py: number, v: number, alpha = 1): void {
    if (px < 0 || py < 0 || px >= PW || py >= PH) return;
    if (alpha < 1 && (alpha <= 0 || bayer(px, py) >= alpha)) return;
    this.data[py * PW + px] = v;
  }

  // One logical pixel, placed with physical (sub-logical) precision.
  px(x: number, y: number, c: number, alpha = 1): void {
    const x0 = Math.floor(x * K);
    const y0 = Math.floor(y * K);
    for (let dy = 0; dy < K; dy++) for (let dx = 0; dx < K; dx++) this.dot(x0 + dx, y0 + dy, c, alpha);
  }

  private mixAt(i: number, r: number, g: number, b: number, a: number): void {
    const v = this.data[i];
    const vr = v & 0xff;
    const vg = (v >> 8) & 0xff;
    const vb = (v >> 16) & 0xff;
    this.data[i] = (0xff000000 | (Math.round(vb + (b - vb) * a) << 16) | (Math.round(vg + (g - vg) * a) << 8) | Math.round(vr + (r - vr) * a)) >>> 0;
  }

  blend(x: number, y: number, c: RGB, a: number): void {
    if (a <= 0) return;
    a = Math.min(1, a);
    const x0 = Math.floor(x * K);
    const y0 = Math.floor(y * K);
    for (let dy = 0; dy < K; dy++) {
      const py = y0 + dy;
      if (py < 0 || py >= PH) continue;
      for (let dx = 0; dx < K; dx++) {
        const px = x0 + dx;
        if (px >= 0 && px < PW) this.mixAt(py * PW + px, c[0], c[1], c[2], a);
      }
    }
  }

  rect(x: number, y: number, w: number, h: number, c: RGB, alpha = 1): void {
    const v = pack(c);
    const x0 = Math.max(0, Math.floor(x * K));
    const y0 = Math.max(0, Math.floor(y * K));
    const x1 = Math.min(PW, Math.floor((x + w) * K));
    const y1 = Math.min(PH, Math.floor((y + h) * K));
    for (let yy = y0; yy < y1; yy++) {
      const row = yy * PW;
      for (let xx = x0; xx < x1; xx++) {
        if (alpha >= 1 || bayer(xx, yy) < alpha) this.data[row + xx] = v;
      }
    }
  }

  // Fills from a per-column top edge (logical y as a function of logical x) down to the bottom.
  fillBelow(top: (x: number) => number, c: RGB, alpha = 1): void {
    const v = pack(c);
    for (let px = 0; px < PW; px++) {
      const y0 = Math.max(0, Math.floor(top(px / K) * K));
      for (let py = y0; py < PH; py++) {
        if (alpha >= 1 || bayer(px, py) < alpha) this.data[py * PW + px] = v;
      }
    }
  }

  // A line `width` logical pixels thick, stamped at physical resolution (square brush when thin, round when thick).
  line(x0: number, y0: number, x1: number, y1: number, c: RGB, alpha = 1, width = 1): void {
    const v = pack(c);
    const bw = Math.max(1, Math.round(width * K));
    const r = bw / 2;
    const r2 = r * r;
    const lo = -((bw - 1) >> 1);
    const hi = lo + bw - 1;
    const ax = x0 * K;
    const ay = y0 * K;
    const steps = Math.max(1, Math.ceil(Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0)) * K));
    const sx = (x1 * K - ax) / steps;
    const sy = (y1 * K - ay) / steps;
    let lastX = NaN;
    let lastY = NaN;
    for (let n = 0; n <= Math.min(steps, 4000); n++) {
      const cx = Math.floor(ax + sx * n);
      const cy = Math.floor(ay + sy * n);
      if (cx === lastX && cy === lastY) continue;
      lastX = cx;
      lastY = cy;
      for (let dy = lo; dy <= hi; dy++) {
        for (let dx = lo; dx <= hi; dx++) {
          if (bw > 2) {
            const ex = dx + 0.5 - (bw & 1 ? 0.5 : 0);
            const ey = dy + 0.5 - (bw & 1 ? 0.5 : 0);
            if (ex * ex + ey * ey > r2) continue;
          }
          this.dot(cx + dx, cy + dy, v, alpha);
        }
      }
    }
  }

  circle(cx: number, cy: number, r: number, c: RGB, alpha = 1): void {
    const v = pack(c);
    const pcx = cx * K;
    const pcy = cy * K;
    const pr = (r + 0.5) * K;
    const r2 = pr * pr;
    for (let py = Math.floor(pcy - pr); py <= pcy + pr; py++) {
      const dy = py + 0.5 - pcy;
      for (let px = Math.floor(pcx - pr); px <= pcx + pr; px++) {
        const dx = px + 0.5 - pcx;
        if (dx * dx + dy * dy <= r2) this.dot(px, py, v, alpha);
      }
    }
  }

  // Filled polygon (logical coordinates), scanline-rasterised at physical resolution.
  poly(pts: [number, number][], c: RGB, alpha = 1): void {
    if (pts.length < 3) return;
    const v = pack(c);
    let minY = Infinity;
    let maxY = -Infinity;
    for (const [, y] of pts) {
      minY = Math.min(minY, y * K);
      maxY = Math.max(maxY, y * K);
    }
    const y0 = Math.max(0, Math.floor(minY));
    const y1 = Math.min(PH - 1, Math.ceil(maxY));
    const xs: number[] = [];
    for (let py = y0; py <= y1; py++) {
      const sy = py + 0.5;
      xs.length = 0;
      for (let i = 0; i < pts.length; i++) {
        const [ax, ay] = pts[i];
        const [bx, by] = pts[(i + 1) % pts.length];
        const pay = ay * K;
        const pby = by * K;
        if ((pay <= sy && pby > sy) || (pby <= sy && pay > sy)) xs.push((ax + ((sy - pay) / (pby - pay)) * (bx - ax)) * K);
      }
      xs.sort((a, b) => a - b);
      for (let i = 0; i + 1 < xs.length; i += 2) {
        const xa = Math.max(0, Math.round(xs[i]));
        const xb = Math.min(PW, Math.round(xs[i + 1]));
        for (let px = xa; px < xb; px++) if (alpha >= 1 || bayer(px, py) < alpha) this.data[py * PW + px] = v;
      }
    }
  }

  ellipse(cx: number, cy: number, rx: number, ry: number, c: RGB, alpha = 1): void {
    if (rx <= 0 || ry <= 0) return;
    const v = pack(c);
    const pcx = cx * K;
    const pcy = cy * K;
    const prx = rx * K;
    const pry = ry * K;
    for (let py = Math.max(0, Math.floor(pcy - pry)); py <= Math.min(PH - 1, pcy + pry); py++) {
      const dy = (py + 0.5 - pcy) / pry;
      const half = prx * Math.sqrt(Math.max(0, 1 - dy * dy));
      for (let px = Math.max(0, Math.round(pcx - half)); px < Math.min(PW, Math.round(pcx + half)); px++) {
        if (alpha >= 1 || bayer(px, py) < alpha) this.data[py * PW + px] = v;
      }
    }
  }

  // Darkening ellipse with a soft falloff: contact shadows that ground a subject.
  shadow(cx: number, cy: number, rx: number, ry: number, strength: number, tint: RGB = [0, 0, 0]): void {
    if (strength <= 0 || rx <= 0 || ry <= 0) return;
    const pcx = cx * K;
    const pcy = cy * K;
    const prx = rx * K;
    const pry = ry * K;
    for (let py = Math.max(0, Math.floor(pcy - pry)); py <= Math.min(PH - 1, pcy + pry); py++) {
      const dy = (py - pcy) / pry;
      for (let px = Math.max(0, Math.floor(pcx - prx)); px <= Math.min(PW - 1, pcx + prx); px++) {
        const dx = (px - pcx) / prx;
        const d = dx * dx + dy * dy;
        if (d < 1) this.mixAt(py * PW + px, tint[0], tint[1], tint[2], strength * (1 - d) * (1 - d));
      }
    }
  }

  // Soft radial glow using real blending; used sparingly (sun, lamps) because it reads pixels back.
  glow(cx: number, cy: number, r: number, c: RGB, strength: number): void {
    if (strength <= 0 || r <= 0) return;
    const pcx = cx * K;
    const pcy = cy * K;
    const pr = r * K;
    const y0 = Math.max(0, Math.floor(pcy - pr));
    const y1 = Math.min(PH - 1, Math.ceil(pcy + pr));
    const x0 = Math.max(0, Math.floor(pcx - pr));
    const x1 = Math.min(PW - 1, Math.ceil(pcx + pr));
    const inv = 1 / (pr * pr);
    for (let py = y0; py <= y1; py++) {
      const dy = py - pcy;
      for (let px = x0; px <= x1; px++) {
        const dx = px - pcx;
        const d2 = (dx * dx + dy * dy) * inv;
        if (d2 >= 1) continue;
        const d = 1 - Math.sqrt(d2);
        this.mixAt(py * PW + px, c[0], c[1], c[2], Math.min(1, d * d * strength));
      }
    }
  }
}
