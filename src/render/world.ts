import type { CastSpec, SubjectSpec } from "../scene/schema";
import type { Motion, Particles, Position, SceneEvent, Setting, SubjectKind } from "../scene/vocab";
import { DEPTH_SETTINGS, drawBackdrop, groundY, HORIZON, type SceneCtx } from "./backdrops";
import { clamp, H, lerp, mix, scale, smooth, W, type FB, type RGB } from "./fb";
import { sceneLight } from "./lighting";
import { hash1 } from "./noise";
import type { WorldParams } from "./palette";
import { drawBolt, drawParticles, drawStreak, drawWeather } from "./particles";
import { CELESTIAL, drawSubject, FLYING, strideLength, type CustomSprite, type SpriteCtx } from "./sprites";

export interface LiveSubject {
  kind: SubjectKind;
  custom: string;
  focus: boolean;
  wasFocus: boolean;
  position: Position;
  fromPosition: Position | null;
  motion: Motion;
  alpha: number;
  // Seconds since the subject started moving from fromPosition.
  move: number;
  since: number;
  slot: number;
  seed: number;
}

export interface SceneState {
  setting: Setting;
  params: WorldParams;
  subjects: LiveSubject[];
  particles: { kind: Particles; amount: number }[];
  event: { kind: SceneEvent; dt: number; seed: number } | null;
  camX: number;
  camY: number;
  seed: number;
  travel: number;
  sprites: Map<string, CustomSprite>;
  backlight: boolean;
  cast: CastSpec;
}

// How fast the road scrolls during a moment (1 = driving). An empty road is the view from the
// driver's seat; a figure standing on it means we have stopped.
export function travelSpeed(setting: Setting, subjects: SubjectSpec[]): number {
  if (setting !== "road") return 0;
  const ground = subjects.filter((s) => !CELESTIAL.has(s.kind) && !FLYING.has(s.kind) && s.position !== "sky");
  if (!ground.length || ground.some((s) => s.kind === "car" || s.kind === "train")) return 1;
  return ground.some((s) => s.motion === "walk" || s.motion === "drift") ? 0.22 : 0;
}

export interface RenderOut {
  flash: number;
  brightness: number;
  vignette: number;
}

interface Place {
  x: number;
  y: number;
  s: number;
  ink: RGB;
}

function place(sub: LiveSubject, pos: Position, setting: Setting, p: WorldParams): Place {
  const g = groundY(setting);
  const spread = sub.slot === 0 ? 0 : (sub.slot % 2 ? 1 : -1) * Math.ceil(sub.slot / 2) * 18;
  const xOf: Record<Position, number> = { left: 0.24, center: 0.5, right: 0.76, far: 0.62, sky: 0.5, foreground: 0.3 };
  const x = xOf[pos] * W + spread;
  const nearInk = scale(p.pal.near, 0.35);

  if (CELESTIAL.has(sub.kind)) {
    if (sub.kind === "rainbow") return { x: W / 2 + spread, y: HORIZON + 8, s: 1, ink: nearInk };
    const cx = pos === "left" ? 0.25 : pos === "right" ? 0.75 : 0.5;
    return { x: cx * W + spread, y: 46, s: 1, ink: nearInk };
  }
  if (pos === "sky" || FLYING.has(sub.kind)) {
    const y = pos === "foreground" ? 70 : pos === "far" ? 40 : 34 + (sub.slot % 3) * 12 + (pos === "sky" ? 0 : 18);
    return { x, y, s: pos === "foreground" ? 2 : 1, ink: scale(p.pal.mid, 0.6) };
  }
  if (pos === "foreground") return { x, y: H + 2, s: 2, ink: scale(p.pal.near, 0.35) };
  // On a road or river the distance is straight ahead, at the vanishing point.
  const farX = DEPTH_SETTINGS.has(setting) ? W / 2 + spread * 0.4 : x;
  if (pos === "far") return { x: farX, y: g.far + 2, s: 0.5, ink: mix(p.pal.far, p.pal.near, 0.35) };
  return { x, y: g.near - (sub.slot % 2) * 3, s: 1, ink: nearInk };
}

const grounded = (sub: LiveSubject, pos: Position) => !CELESTIAL.has(sub.kind) && !FLYING.has(sub.kind) && pos !== "sky";

// How far a subject slides when the camera pans, matching the backdrop layer it stands on.
function parallax(sub: LiveSubject, pos: Position, setting: Setting, y: number): number {
  if (CELESTIAL.has(sub.kind)) return -0.08;
  if (!grounded(sub, pos)) return 0.3;
  const top = groundY(setting).top;
  if (top !== undefined) return clamp((y - top) / (H - top));
  return pos === "far" ? 0.45 : 1;
}

// Figures that walk between spots; anything else glides (birds, boats) or, if rooted, crossfades.
const WALKERS = new Set<SubjectKind>(["lone_figure", "walking_figure", "child", "couple", "figure_with_umbrella", "dog", "cat"]);
const ROOTED = new Set<SubjectKind>([
  "house", "tree", "dead_tree", "street_lamp", "lighthouse", "door", "bench", "window_light", "bridge", "ladder",
  "campfire", "sunflower", "flower", "rose", "wilted_flower",
]);
// Subjects that emit light; stamping them for a rim would stack their glow several times over.
const GLOWING = new Set<SubjectKind>(["street_lamp", "campfire", "candle", "lantern", "phone", "lighthouse"]);
const GLIDE = 1.2;

// Half-width of a subject's contact shadow at scale 1.
const FOOTPRINT: Partial<Record<SubjectKind, number>> = {
  couple: 11, embracing_couple: 8, crowd: 44, car: 19, house: 17, tree: 11, dead_tree: 7, bench: 11, dog: 8, cat: 6,
  campfire: 9, street_lamp: 3, lighthouse: 5, child: 4, train: 0, bridge: 0, sunflower: 4, flower: 3, rose: 3,
  wilted_flower: 3, door: 7, sitting_figure: 7,
};
const NO_SHADOW = new Set<SubjectKind>(["boat", "ship", "whale", "bridge", "train", "ladder", "chains", "heart", "broken_heart", "mask", "crown", "key", "letter", "clock", "phone"]);
const JOG = 40;

interface Motioned {
  x: number;
  y: number;
  // Distance covered on foot, which drives the stride so feet plant instead of skating.
  gait: number;
  moving: boolean;
  flip: boolean;
}

function applyMotion(sub: LiveSubject, pl: Place, s: number, t: number, energy: number, floats: boolean, alongDepth: boolean): Motioned {
  const dt = Math.max(0, t - sub.since);
  const pace = 0.6 + energy * 0.8;
  const walker = WALKERS.has(sub.kind);
  let { x, y } = pl;
  let gait = 0;
  let moving = false;
  let flip = false;
  const dir = pl.x > W / 2 ? -1 : 1;
  switch (sub.motion) {
    case "walk": {
      moving = true;
      // Walking along a road: the figure keeps its place and the road scrolls past.
      if (alongDepth) break;
      const travel = dt * 16 * Math.max(0.5, s) * pace;
      // Ping-pong within a 100px span so a long line doesn't walk the figure off screen.
      const span = 100;
      const ph = travel % (span * 2);
      const off = ph < span ? ph : span * 2 - ph;
      x += dir * (off - 25);
      flip = (ph < span ? dir : -dir) < 0;
      gait = travel;
      break;
    }
    case "rise":
      y -= Math.min(70, dt * 6 * pace);
      break;
    case "fall":
      y += Math.min(30, dt * 6 * pace);
      break;
    case "sway":
      x += Math.sin(t * 1.5 + sub.seed) * 2 * pace;
      break;
    case "fly":
      x += Math.sin(t * 0.3 + sub.seed) * 30;
      y += Math.sin(t * 2 + sub.seed) * 4;
      moving = true;
      break;
    case "drift": {
      if (alongDepth) {
        moving = walker;
        break;
      }
      // A drifting figure strolls; a drifting object floats.
      const d = Math.min(80, dt * (walker ? 7 : 4));
      x += d * dir;
      if (walker) {
        gait = d;
        moving = d < 80;
        flip = dir < 0;
      } else y += Math.sin(t * 0.8 + sub.seed) * 1.5;
      break;
    }
    case "spin":
      flip = Math.floor(t * 2 + sub.seed) % 2 === 0;
      break;
    case "still":
      break;
  }
  if (floats && !CELESTIAL.has(sub.kind)) y += Math.sin(t * 0.9 + sub.seed) * 3;
  return { x, y, gait, moving, flip };
}

export function renderScene(fb: FB, st: SceneState, t: number, energy: number): RenderOut {
  let p = st.params;
  // A subject-scale moon or sun replaces the sky's own, never doubles it.
  const big = st.subjects.some((s) => (s.kind === "big_moon" || s.kind === "big_sun") && s.alpha > 0.3);
  if (big) p = { ...p, sunAlpha: 0, moonAlpha: 0 };
  const ctx: SceneCtx = { fb, p, t, energy, camX: st.camX, camY: st.camY, seed: st.seed, travel: st.travel };
  drawBackdrop(ctx, st.setting);

  const g = groundY(st.setting);
  const light = sceneLight(p);
  // Celestial subjects sit behind everything else; draw them first.
  const ordered = [...st.subjects].sort((a, b) => Number(CELESTIAL.has(b.kind)) - Number(CELESTIAL.has(a.kind)));
  const drawOne = (sub: LiveSubject, pl: Place, pos: Position, alpha: number, glide: { dist: number; face: number } | null) => {
    const onGround = grounded(sub, pos);
    const alongDepth = onGround && DEPTH_SETTINGS.has(st.setting);
    const far = pl.s < 1;
    const sc: SpriteCtx = {
      fb, pal: p.pal, t, energy, ink: pl.ink, lights: p.lights, daylight: p.daylight, sprites: st.sprites, alongDepth,
      light, haze: far ? 0.45 : 0, hazeCol: mix(p.pal.far, p.pal.skyBot, 0.4), cast: st.cast,
    };
    // The focus subject is the line's close-up: twice the size, lit from behind.
    const canFocus = !CELESTIAL.has(sub.kind) && pl.s >= 1 && pl.s < 2;
    const focus = sub.focus && canFocus;
    // Zooming into or out of a close-up eases instead of popping between sizes.
    const zoom = lerp(sub.wasFocus && canFocus ? 2 : 1, focus ? 2 : 1, smooth(sub.move / 0.7));
    const s = pl.s < 1 ? 0.5 : Math.round(pl.s) * zoom;
    const m = applyMotion(sub, pl, s, t, energy, g.floats, alongDepth);
    let { moving, flip } = m;
    let gait: number | undefined;
    if (alongDepth && moving) gait = t * 10 + sub.seed;
    else if (glide || m.gait > 0) {
      const dist = m.gait + (glide?.dist ?? 0);
      gait = (dist / strideLength(sub.kind, s)) * Math.PI * 2 + sub.seed;
      if (glide) {
        moving = true;
        flip = glide.face < 0;
      }
    }
    const sx = m.x - st.camX * parallax(sub, pos, st.setting, pl.y);
    const sy = m.y + st.camY * (onGround ? 1 : 0.5);
    // A soft contact shadow, thrown away from the key light, plants the subject on the ground.
    if (onGround && !g.floats && pos !== "far" && !NO_SHADOW.has(sub.kind)) {
      const rx = (FOOTPRINT[sub.kind] ?? 6) * s;
      const throwX = -light.dir * rx * (0.15 + 0.35 * p.sunAlpha);
      fb.shadow(sx + throwX, sy, rx, rx * 0.22 + 0.8, 0.38 * (0.35 + 0.65 * p.daylight) * alpha);
    }
    // Faint backlight so dark silhouettes separate from equally dark ground.
    if (st.backlight && !CELESTIAL.has(sub.kind)) fb.glow(sx, sy - 12 * s, 20 * s, focus ? mix(p.pal.skyBot, p.pal.light, 0.5) : p.pal.skyBot, (focus ? 0.4 : 0.22) * alpha);
    else if (!CELESTIAL.has(sub.kind) && !GLOWING.has(sub.kind) && alpha > 0.5) {
      // Palette looks can't show a soft glow, so a thin light rim separates the silhouette instead.
      const rim = mix(p.pal.skyBot, p.pal.light, 0.6);
      const rc: SpriteCtx = { ...sc, ink: rim, solid: rim };
      for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) drawSubject(sub.kind, rc, sx + dx, sy + dy, s, alpha, moving, flip, sub.seed, sub.custom, gait);
    }
    drawSubject(sub.kind, sc, sx, sy, s, alpha, moving, flip, sub.seed, sub.custom, gait);
  };

  for (const sub of ordered) {
    if (sub.alpha <= 0.01) continue;
    const to = place(sub, sub.position, st.setting, p);
    if (!sub.fromPosition) {
      drawOne(sub, to, sub.position, sub.alpha, null);
      continue;
    }
    const from = place(sub, sub.fromPosition, st.setting, p);
    if (ROOTED.has(sub.kind)) {
      // A house doesn't walk: it fades out of its old spot and into the new one.
      const k = clamp(sub.move / 0.8);
      if (k < 1) drawOne(sub, from, sub.fromPosition, sub.alpha * (1 - k), null);
      drawOne(sub, to, sub.position, sub.alpha * k, null);
      continue;
    }
    const dx = to.x - from.x;
    const onFoot = WALKERS.has(sub.kind) && grounded(sub, sub.position);
    // Walkers cross at a steady pace (constant speed keeps the stride honest); others ease.
    const dur = onFoot ? clamp(Math.abs(dx) / JOG, 0.8, 4) : GLIDE;
    const lin = clamp(sub.move / dur);
    const k = onFoot ? lin : lin * lin * (3 - 2 * lin);
    const pl: Place = { x: lerp(from.x, to.x, k), y: lerp(from.y, to.y, k), s: k < 0.5 ? from.s : to.s, ink: mix(from.ink, to.ink, k) };
    const walking = onFoot && lin < 1 && Math.abs(dx) > 2;
    drawOne(sub, pl, k < 0.5 ? sub.fromPosition : sub.position, sub.alpha, walking ? { dist: Math.abs(dx) * k, face: Math.sign(dx) } : null);
  }

  let flash = 0;
  if (st.setting === "club") {
    // Indoors: no weather.
  } else if (st.setting === "room") {
    const wx = 190 + st.camX, wy = 34 + st.camY;
    flash = drawWeather(fb, p, t, energy, [Math.max(0, wx | 0), Math.max(0, wy | 0), Math.min(W, (wx + 90) | 0), Math.min(H, (wy + 70) | 0)]);
  } else {
    flash = drawWeather(fb, p, t, energy);
  }
  for (const pt of st.particles) drawParticles(fb, pt.kind, pt.amount, p, t, energy);

  let brightness = 1;
  let vignette = 0.25;
  const ev = st.event;
  if (ev) {
    const { dt } = ev;
    switch (ev.kind) {
      case "lightning":
        if (dt < 0.35) {
          drawBolt(fb, 60 + hash1(ev.seed) * 200, ev.seed, 1 - dt / 0.35);
          flash = Math.max(flash, (1 - dt / 0.35) * 0.7);
        }
        break;
      case "shooting_star":
        if (dt < 1.2) {
          const d = dt / 1.2;
          drawStreak(fb, 40 + d * 220, 14 + d * 50, 1 - d * 0.7);
        }
        break;
      case "flash":
        flash = Math.max(flash, clamp(1 - dt / 0.5));
        break;
      case "pulse": {
        // Two-beat heartbeat envelope.
        const beat = (k: number) => Math.exp(-((dt - k) ** 2) / 0.004);
        brightness += 0.3 * (beat(0.1) + 0.7 * beat(0.35));
        break;
      }
      case "darken":
        brightness *= 1 - 0.4 * clamp(dt / 0.8);
        vignette = 0.25 + 0.4 * clamp(dt / 0.8);
        break;
      case "brighten":
        brightness *= 1 + 0.2 * clamp(dt / 0.8);
        vignette = 0.1;
        break;
      default:
        break;
    }
  }
  return { flash, brightness, vignette };
}
