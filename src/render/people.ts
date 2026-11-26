import type { AppearanceSpec } from "../scene/schema";
import type { RGB } from "./fb";
import { hash1 } from "./noise";
import { hexRgb, lit } from "./lighting";
import type { SpriteCtx } from "./sprites";

export interface Pose {
  armL: number;
  armR: number;
  legL: number;
  legR: number;
  kneeL?: number;
  kneeR?: number;
  elbowL?: number;
  elbowR?: number;
  lean?: number;
  sit?: boolean;
  // Fraction of each leg hidden by a raised foot, for a stride seen from behind.
  liftL?: number;
  liftR?: number;
  bob?: number;
}

// 0: facing the viewer, 1/-1: side view facing right/left, "back": walking away.
export type Facing = 0 | 1 | -1 | "back";

interface Colours {
  skin: RGB;
  hair: RGB;
  top: RGB;
  bottom: RGB;
  shoe: RGB;
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

export const ageScale = (a: AppearanceSpec) => (a.age === "child" ? 0.62 : a.age === "teen" ? 0.9 : a.age === "elder" ? 0.95 : 1);

export function person(c: SpriteCtx, x: number, y: number, h: number, pose: Pose, ap: AppearanceSpec, alpha: number, facing: Facing): void {
  const { fb } = c;
  const L = c.light;
  const col: Colours = {
    skin: hexRgb(ap.skin),
    hair: hexRgb(ap.hair),
    top: hexRgb(ap.top),
    bottom: ap.outfit === "dress" ? hexRgb(ap.top) : hexRgb(ap.bottom),
    shoe: [44, 36, 34],
  };
  const paint = (base: RGB, k: number): RGB => c.solid ?? lit(L, base, k, c.haze, c.hazeCol);
  const child = ap.age === "child";
  const female = ap.gender === "female";
  const side = facing === 1 || facing === -1;
  const back = facing === "back";
  const fdir = side ? (facing as number) : 0;

  const u = h / 18;
  y -= (pose.bob ?? 0) * u;
  const legLen = 8 * u;
  const hipY = pose.sit ? y - legLen * 0.45 : y - legLen;
  const lean = ((pose.lean ?? 0) + (ap.age === "elder" ? 0.6 * (fdir || 1) : 0)) * u;
  const shoulderY = hipY - 6 * u;
  const headR = u * (child ? 1.95 : 1.5);
  const hx = x + lean;
  const hy = shoulderY - 0.5 * u - headR * 0.92;
  const sw = (female ? 1.2 : child ? 1.15 : 1.55) * u * (side ? 0.55 : 1);
  const hw = (female ? 1.3 : 1.1) * u * (side ? 0.6 : 1);
  const armW = Math.max(1, 0.95 * u);
  const legW = Math.max(1, 1.25 * u);

  // A limb as a shaded capsule: base, a lit stripe toward the key light, a shadow stripe away.
  const limb = (x0: number, y0: number, x1: number, y1: number, w: number, base: RGB, far: boolean) => {
    const dx = x1 - x0;
    const dy = y1 - y0;
    const len = Math.hypot(dx, dy) || 1;
    let px = -dy / len;
    let py = dx / len;
    if (px * L.dir < 0 || (Math.abs(px) < 0.2 && py > 0)) {
      px = -px;
      py = -py;
    }
    const k0 = far ? -0.55 : 0;
    fb.line(x0, y0, x1, y1, paint(base, k0 - 0.35), alpha, w);
    if (w * 2 >= 2.5) {
      fb.line(x0 + px * w * 0.18, y0 + py * w * 0.18, x1 + px * w * 0.18, y1 + py * w * 0.18, paint(base, k0 + 0.25), alpha, w * 0.6);
      fb.line(x0 + px * w * 0.3, y0 + py * w * 0.3, x1 + px * w * 0.3, y1 + py * w * 0.3, paint(base, k0 + 0.85), alpha, w * 0.28);
    }
  };

  const shortSleeves = ap.outfit !== "pants" || child;
  const legColours = (upper: boolean): RGB =>
    ap.outfit === "pants" ? col.bottom : ap.outfit === "shorts" ? (upper ? col.bottom : col.skin) : col.skin;

  const leg = (ang: number, knee: number | undefined, lift: number | undefined, ox: number, far: boolean) => {
    const sx = x + ox;
    const kx = sx + Math.sin(ang) * legLen * 0.5;
    const ky = hipY + Math.cos(ang) * legLen * 0.5;
    const a2 = ang + (knee ?? 0);
    const low = legLen * 0.5 * (1 - (lift ?? 0));
    const fx = kx + Math.sin(a2) * low;
    const fy = ky + Math.cos(a2) * low;
    limb(sx, hipY, kx, ky, legW, legColours(true), far);
    limb(kx, ky, fx, fy, legW * 0.88, legColours(false), far);
    // Shoes point the way the figure faces.
    const toe = side ? fdir : 0;
    fb.ellipse(fx + toe * legW * 0.35, fy - legW * 0.15, legW * (side ? 0.75 : 0.55), legW * 0.42, paint(col.shoe, far ? -0.6 : 0), alpha);
  };

  const arm = (ang: number, elbow: number | undefined, ox: number, far: boolean) => {
    const sx = hx + ox;
    const sy = shoulderY + 0.5 * u;
    const ex = sx + Math.sin(ang) * 3 * u;
    const ey = sy + Math.cos(ang) * 3 * u;
    const a2 = ang + (elbow ?? 0.12 * (fdir || Math.sign(ox) || 1));
    const hx2 = ex + Math.sin(a2) * 2.8 * u;
    const hy2 = ey + Math.cos(a2) * 2.8 * u;
    limb(sx, sy, ex, ey, armW, col.top, far);
    limb(ex, ey, hx2, hy2, armW * 0.85, shortSleeves ? col.skin : col.top, far);
    fb.circle(hx2, hy2, Math.max(0.5, armW * 0.5), paint(col.skin, far ? -0.5 : 0.1), alpha);
  };

  const legOx = side ? 0 : hw * 0.5;
  const armOx = side ? 0 : sw;

  // Long hair falls behind the shoulders (drawn before the body), or over the back when the
  // figure walks away from us (drawn after it).
  const longHair = () => {
    const bx = hx - fdir * headR * 0.35;
    const bottom = shoulderY + 2.8 * u;
    fb.poly(
      [[bx - headR * 1.02, hy], [bx + headR * 1.02, hy], [bx + headR * (side ? 0.8 : 1.1), bottom], [bx - headR * (side ? 0.8 : 1.1), bottom]],
      paint(col.hair, -0.4),
      alpha,
    );
    fb.poly([[bx + L.dir * headR * 0.2, hy], [bx + L.dir * headR * 0.8, hy], [bx + L.dir * headR * 0.85, bottom - u], [bx + L.dir * headR * 0.35, bottom - u]], paint(col.hair, 0.2), alpha);
  };
  if (ap.hairStyle === "long" && !back) longHair();

  // Far limbs first, then the body, then near limbs: side views get depth from that order.
  if (side) {
    leg(pose.legL, pose.kneeL, pose.liftL, 0, true);
    arm(pose.armL, pose.elbowL, 0, true);
  } else {
    leg(pose.legL, pose.kneeL, pose.liftL, -legOx, false);
    leg(pose.legR, pose.kneeR, pose.liftR, legOx, false);
  }

  // Skirts and dresses flare from the waist.
  if (ap.outfit === "skirt" || ap.outfit === "dress") {
    const hem = hipY + legLen * (ap.outfit === "dress" ? 0.55 : 0.42);
    const flare = hw * (side ? 1.6 : 1.75) + Math.abs(Math.sin(pose.legL - pose.legR)) * u;
    const waist = hipY - (ap.outfit === "dress" ? 0 : 0.6 * u);
    fb.poly([[x - hw * 1.05, waist], [x + hw * 1.05, waist], [x + flare, hem], [x - flare, hem]], paint(col.bottom, -0.35), alpha);
    fb.poly([[x - hw * 0.4 + L.dir * hw * 0.4, waist], [x + hw * 1.0 * L.dir, waist], [x + flare * L.dir, hem], [x + flare * 0.2 * L.dir, hem]].map(([px, py]) => [px, py] as [number, number]), paint(col.bottom, 0.45), alpha);
  }

  // Torso: shadowed base, a lit panel toward the key light, a rim along the lit edge.
  const torso = (inset: number, shift: number): [number, number][] => [
    [hx - sw * inset + shift, shoulderY],
    [hx + sw * inset + shift, shoulderY],
    [x + hw * inset + shift, hipY + 0.3 * u],
    [x - hw * inset + shift, hipY + 0.3 * u],
  ];
  fb.poly(torso(1, 0), paint(col.top, -0.5), alpha);
  fb.poly(torso(0.78, L.dir * sw * 0.22), paint(col.top, 0.3), alpha);
  fb.poly([[hx + L.dir * sw * 0.72, shoulderY + 0.3 * u], [hx + L.dir * sw * 0.98, shoulderY + 0.3 * u], [x + L.dir * hw * 0.98, hipY], [x + L.dir * hw * 0.72, hipY]], paint(col.top, 0.95), alpha);
  if (ap.outfit === "pants" || ap.outfit === "shorts") fb.rect(x - hw, hipY - 0.25 * u, hw * 2, Math.max(0.5, 0.35 * u), paint(col.bottom, -0.7), alpha);

  // Neck.
  fb.line(hx, shoulderY + 0.3 * u, hx, hy + headR * 0.6, paint(col.skin, -0.3), alpha, Math.max(1, 0.8 * u));

  if (side) {
    leg(pose.legR, pose.kneeR, pose.liftR, 0, false);
    arm(pose.armR, pose.elbowR, 0, false);
  } else {
    arm(pose.armL, pose.elbowL, -armOx, false);
    arm(pose.armR, pose.elbowR, armOx, false);
  }

  if (ap.hairStyle === "long" && back) longHair();
  head(c, hx, hy, headR, col, ap, alpha, facing, paint);
}

function head(
  c: SpriteCtx,
  x: number,
  y: number,
  r: number,
  col: Colours,
  ap: AppearanceSpec,
  alpha: number,
  facing: Facing,
  paint: (b: RGB, k: number) => RGB,
): void {
  const { fb } = c;
  const L = c.light;
  const side = facing === 1 || facing === -1;
  const fdir = side ? (facing as number) : 0;
  const back = facing === "back";

  // Skin with a shadowed far side.
  fb.circle(x, y, r, paint(col.skin, -0.5), alpha);
  fb.circle(x + L.dir * r * 0.2, y - r * 0.05, r * 0.8, paint(col.skin, 0.35), alpha);

  const hairK = (k: number) => paint(col.hair, k);
  const style = ap.hairStyle;
  if (back) {
    fb.circle(x, y, r * 1.04, hairK(-0.3), alpha);
    fb.circle(x + L.dir * r * 0.3, y - r * 0.3, r * 0.45, hairK(0.6), alpha);
  } else if (style !== "bald") {
    // Hair cap over the top of the head, set back in profile so the face shows.
    // The cap ends at the brow line, leaving the eyes clear.
    const cx = x - fdir * r * 0.22;
    fb.ellipse(cx, y - r * 0.5, r * 1.07, r * 0.58, hairK(-0.2), alpha);
    if (side) fb.ellipse(x - fdir * r * 0.55, y - r * 0.1, r * 0.55, r * 0.7, hairK(-0.3), alpha);
    fb.ellipse(cx + L.dir * r * 0.3, y - r * 0.7, r * 0.45, r * 0.22, hairK(0.7), alpha);
    if (style === "curly") {
      for (let i = 0; i < 6; i++) {
        const a = Math.PI + (i / 5) * Math.PI;
        fb.circle(cx + Math.cos(a) * r * 0.95, y - r * 0.25 + Math.sin(a) * r * 0.85, r * 0.38, hairK(i % 2 ? 0.2 : -0.3), alpha);
      }
    }
    if ((style === "long" || ap.gender === "female") && !side) {
      // Side locks frame the face.
      fb.rect(x - r * 1.04, y - r * 0.4, r * 0.3, r * 1.3, hairK(-0.35), alpha);
      fb.rect(x + r * 0.74, y - r * 0.4, r * 0.3, r * 1.3, hairK(-0.35), alpha);
    }
    if (style === "bun") fb.circle(x - fdir * r * 0.5, y - r * 1.05, r * 0.42, hairK(0), alpha);
    if (style === "ponytail") {
      const px = side ? x - fdir * r * 1.15 : x;
      const py = side ? y - r * 0.2 : y - r * 1.1;
      fb.ellipse(px, py, r * 0.35, r * (side ? 0.7 : 0.35), hairK(-0.1), alpha);
    }
  }
  if (back) return;

  // Faces only where there are enough pixels to read them (close-ups and near figures).
  if (r < 2.6 || c.solid) return;
  const eye = paint([34, 26, 30], -0.2);
  const ex = side ? x + fdir * r * 0.5 : x;
  const ey = y + r * 0.12;
  const ew = Math.max(0.5, r * 0.09);
  const eh = Math.max(0.5, r * 0.15);
  if (side) fb.ellipse(ex, ey, ew, eh, eye, alpha);
  else {
    fb.ellipse(ex - r * 0.36, ey, ew, eh, eye, alpha);
    fb.ellipse(ex + r * 0.36, ey, ew, eh, eye, alpha);
  }
  const blush = paint([226, 120, 120], 0);
  const mouth = paint([150, 70, 70], 0);
  if (side) {
    fb.circle(x + fdir * r * 0.98, y + r * 0.28, Math.max(0.5, r * 0.14), paint(col.skin, 0.2), alpha);
    fb.line(x + fdir * r * 0.5, y + r * 0.55, x + fdir * r * 0.75, y + r * 0.55, mouth, alpha, Math.max(0.5, r * 0.08));
  } else {
    fb.line(x - r * 0.18, y + r * 0.55, x + r * 0.18, y + r * 0.55, mouth, alpha, Math.max(0.5, r * 0.08));
    fb.circle(x - r * 0.55, y + r * 0.4, r * 0.1, blush, alpha * 0.35);
    fb.circle(x + r * 0.55, y + r * 0.4, r * 0.1, blush, alpha * 0.35);
  }
}
