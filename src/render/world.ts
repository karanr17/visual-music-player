import type { CastSpec, SubjectSpec } from "../scene/schema";
import type { Motion, Particles, Position, SceneEvent, Setting, Shot, SubjectKind } from "../scene/vocab";
import { DEPTH_SETTINGS, drawBackdrop, groundY, HORIZON, type SceneCtx } from "./backdrops";
import { FOOTFALL_PACE as FOOTFALL, STEP_PX, WALK_V } from "./characters";
import { clamp, H, K, lerp, mix, scale, smooth, W, type FB, type RGB } from "./fb";
import { sceneLight } from "./lighting";
import { hash1 } from "./noise";
import type { WorldParams } from "./palette";
import { drawBolt, drawParticles, drawStreak, drawWeather } from "./particles";
import { drawPlate, type PlateLayers } from "./plates";
import { CELESTIAL, drawSubject, FLYING, type CustomSprite, type Gait, type SpriteCtx } from "./sprites";

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
  // This moment's shot, the one it cuts from, and seconds since the cut.
  shot: Shot;
  fromShot: Shot;
  shotSince: number;
  // ∫ pace dt in "pace-seconds", where pace follows the music's energy. A pure function of t,
  // so anything paced by energy moves by integrating it and seeking lands on the same frame.
  pace: (t: number) => number;
  // Set when pace is locked to the beat: moves a walk's start to the next pace at which its
  // footfalls land on beats, so the figure starts in step instead of between beats.
  stepAlign?: (pace: number) => number;
  // Continuous beat count (whole at each beat) when the scene follows a beat grid.
  beatPos?: (t: number) => number;
  // Head dip in source pixels for standing figures this frame.
  nod?: number;
  // Illustrated mode: this section's backdrop plate, drawn in place of the procedural land.
  plate?: PlateLayers | null;
}

// How fast the road scrolls during a moment (1 = driving). An empty road is the view from the
// driver's seat; a figure standing on it means we have stopped.
export function travelSpeed(setting: Setting, subjects: SubjectSpec[]): number {
  if (setting !== "road") return 0;
  const ground = subjects.filter((s) => !CELESTIAL.has(s.kind) && !FLYING.has(s.kind) && s.position !== "sky");
  // Someone walking near the camera sets the pace even if a car passes in the distance.
  const near = ground.filter((s) => s.position !== "far");
  const onFoot = near.some((s) => WALKERS.has(s.kind) && (s.motion === "walk" || s.motion === "drift"));
  if (onFoot) return ROAD_WALK;
  if (!ground.length || ground.some((s) => s.kind === "car" || s.kind === "train")) return 1;
  return 0;
}

export interface RenderOut {
  flash: number;
  brightness: number;
  vignette: number;
}

// Captions take the bottom fifth of the frame (two rows reach up to y≈145, logical) and the
// player bar sits under them, so people in wide and medium shots stand above this line.
export const SAFE_BOTTOM = 144;

// Where a shot puts the ground and the horizon, and how big it draws subjects. Close shots keep
// the medium ground: only the focus subject comes forward, feet below the frame.
interface Framing {
  feet: number;
  horizon: number;
  scale: number;
}
const FRAMING: Record<Shot, Framing> = {
  wide: { feet: 134, horizon: 90, scale: 1 },
  medium: { feet: SAFE_BOTTOM - 1, horizon: 100, scale: 2 },
  close: { feet: SAFE_BOTTOM - 1, horizon: 104, scale: 2 },
};
// Close-ups: people fill the frame from the waist up, feet below the frame; objects grow less
// (they are drawn bigger to begin with) and stay whole, standing just above the captions.
const closeUp = (kind: SubjectKind) =>
  FIGURES.has(kind) ? { scale: 4, feet: 172 } : { scale: SYMBOLIC_SMALL.has(kind) ? 3 : 2.5, feet: SAFE_BOTTOM + 6 };
export const SHOT_EASE = 0.9;

// Camera offsets that land a setting's ground line on the shot's feet line and its horizon on
// the shot's horizon. camY moves layers by their depth (far ridges ~0.3, near ground 1); tilt
// moves every layer. Settings drawn in perspective keep their ground and only tilt.
function cameraFor(setting: Setting, shot: Shot): { camY: number; tilt: number } {
  const f = FRAMING[shot];
  const g = groundY(setting);
  const dHorizon = f.horizon - HORIZON;
  if (DEPTH_SETTINGS.has(setting) || g.floats) return { camY: 0, tilt: dHorizon };
  const dFeet = f.feet - g.near;
  const camY = (dFeet - dHorizon) / 0.7;
  return { camY, tilt: dFeet - camY };
}

export interface Place {
  x: number;
  y: number;
  s: number;
  ink: RGB;
}

function place(sub: LiveSubject, pos: Position, setting: Setting, p: WorldParams, fr: Framing): Place {
  const g = groundY(setting);
  const spread = sub.slot === 0 ? 0 : (sub.slot % 2 ? 1 : -1) * Math.ceil(sub.slot / 2) * 18 * Math.max(1, fr.scale * 0.75);
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
    return { x, y, s: pos === "foreground" ? 2 : fr.scale > 1 ? 1.5 : 1, ink: scale(p.pal.mid, 0.6) };
  }
  if (pos === "foreground") return { x, y: H + 2, s: fr.scale + 1, ink: scale(p.pal.near, 0.35) };
  // On a road or river the distance is straight ahead, at the vanishing point.
  const farX = DEPTH_SETTINGS.has(setting) ? W / 2 + spread * 0.4 : x;
  if (pos === "far") return { x: farX, y: g.far + 2, s: fr.scale / 2, ink: mix(p.pal.far, p.pal.near, 0.35) };
  return { x, y: g.near - (sub.slot % 2) * 3, s: fr.scale, ink: nearInk };
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
const FIGURES = new Set<SubjectKind>([
  "lone_figure", "walking_figure", "child", "couple", "embracing_couple", "dancer", "figure_with_umbrella", "reaching_figure",
  "sitting_figure",
]);
const SYMBOLIC_SMALL = new Set<SubjectKind>(["heart", "broken_heart", "key", "letter", "crown", "mask", "candle", "lantern", "phone", "clock", "flower", "rose", "wilted_flower"]);
const ROOTED = new Set<SubjectKind>([
  "house", "tree", "dead_tree", "street_lamp", "lighthouse", "door", "bench", "window_light", "bridge", "ladder",
  "campfire", "sunflower", "flower", "rose", "wilted_flower", "factory", "volcano",
]);
// Subjects that emit light; stamping them for a rim would stack their glow several times over.
const GLOWING = new Set<SubjectKind>(["street_lamp", "campfire", "candle", "lantern", "phone", "lighthouse"]);
const GLIDE = 1.2;

// Half-width of a subject's contact shadow at scale 1.
const FOOTPRINT: Partial<Record<SubjectKind, number>> = {
  factory: 8, volcano: 8, cow: 7, record_player: 7,
  couple: 11, embracing_couple: 8, crowd: 44, car: 19, house: 17, tree: 11, dead_tree: 7, bench: 11, dog: 8, cat: 6,
  campfire: 9, street_lamp: 3, lighthouse: 5, child: 4, train: 0, bridge: 0, sunflower: 4, flower: 3, rose: 3,
  wilted_flower: 3, door: 7, sitting_figure: 7,
};
const NO_SHADOW = new Set<SubjectKind>(["boat", "ship", "whale", "bridge", "train", "ladder", "chains", "heart", "broken_heart", "mask", "crown", "key", "letter", "clock", "phone"]);

// Walking speed and distances are in world units (logical px at scale 1, WALK_V per pace-second)
// and multiplied by the subject's scale on screen, so a cut to a closer shot keeps the walk where it was.
// Road travel per walk frame when walking along a road (road speed ROAD_WALK is travel units/s).
const ROAD_WALK = 0.22;
const ROAD_STEP = ROAD_WALK / 9;
// Seconds to get up to speed and to slow to a stop, and to turn round at the end of a walk.
const ACCEL = 0.45;
const TURN = 0.9;
// On a beat grid, accelerating plus turning must take whole footfall periods, or each turn would
// shift the steps off the beat.
const TURN_ON_BEAT = Math.max(1, Math.round((ACCEL + TURN) / FOOTFALL)) * FOOTFALL - ACCEL;

// Walk frames 0 and 4 are the footfalls; a cruising walk is at frame R·(u − ACCEL/2), R frames
// per pace-second, so starting at a pace ≡ this offset puts footfalls on whole footfall periods.
const STEP_OFFSET = -ACCEL / 2;

export function alignStep(p0: number): number {
  return STEP_OFFSET + FOOTFALL * Math.ceil((p0 - STEP_OFFSET) / FOOTFALL - 1e-9);
}
const SPAN = 60;

// Distance covered after time u on a leg of length `len` walked at speed v, easing in and out
// over ACCEL (a trapezoidal speed profile, so the stride slows with the body).
function leg(u: number, len: number, v: number): number {
  const T = len / v + ACCEL;
  if (u <= 0) return 0;
  if (u >= T) return len;
  if (u < ACCEL) return (v * u * u) / (2 * ACCEL);
  if (u > T - ACCEL) return len - (v * (T - u) ** 2) / (2 * ACCEL);
  return v * (u - ACCEL / 2);
}

interface Motioned {
  x: number;
  y: number;
  gait: Gait;
}

const stepLen = (s: number) => (STEP_PX * s) / K;
// The body advances in whole steps, one per walk frame, so the planted foot stays exactly where
// it landed instead of sliding forward while a frame holds.
const onStep = (d: number, step: number) => Math.floor(d / step + 1e-6) * step;

export function applyMotion(sub: LiveSubject, pl: Place, s: number, st: SceneState, t: number, energy: number, floats: boolean, alongDepth: boolean): Motioned {
  const dt = Math.max(0, t - sub.since);
  // Pace-seconds since the motion began: elapsed time weighted by the music's energy.
  const start = st.pace(sub.since);
  const u = st.pace(t) - (st.stepAlign && sub.motion === "walk" ? st.stepAlign(start) : start);
  const walker = WALKERS.has(sub.kind);
  let { x, y } = pl;
  const gait: Gait = { dist: 0, moving: false, flip: false, age: dt, step: stepLen(s) };
  const dir = pl.x > W / 2 ? -1 : 1;
  switch (sub.motion) {
    case "walk": {
      if (alongDepth) {
        // Along a road the figure keeps its place and the road scrolls past; the stride counts
        // road travel, so the feet keep time with the stripes.
        gait.moving = true;
        gait.away = st.travel / ROAD_STEP;
        break;
      }
      // Back and forth over SPAN so a long line doesn't walk the figure off screen, easing into
      // each turn and pausing to face round.
      const v = WALK_V;
      const turn = st.stepAlign ? TURN_ON_BEAT : TURN;
      const legT = SPAN / v + ACCEL;
      const period = 2 * (legT + turn);
      const n = Math.floor(u / period);
      const ph = u - n * period;
      const back = ph >= legT + turn;
      const local = back ? ph - legT - turn : ph;
      const turning = local > legT;
      const d = leg(Math.min(local, legT), SPAN, v);
      const legsDone = n * 2 + (back ? 1 : 0);
      gait.dist = (legsDone * SPAN + d) * s;
      const dq = clamp(onStep(gait.dist, gait.step) / s - legsDone * SPAN, 0, SPAN);
      const off = back ? SPAN - dq : dq;
      x += dir * (off - SPAN / 4) * s;
      const facing = back ? -dir : dir;
      if (turning) {
        // Side, then facing us, then the other side.
        const k = (local - legT) / turn;
        gait.front = k > 0.3 && k < 0.7;
        gait.flip = (k >= 0.7 ? -facing : facing) < 0;
      } else {
        gait.moving = d > 0 && d < SPAN;
        gait.flip = facing < 0;
      }
      break;
    }
    case "rise":
      y -= 70 * (1 - Math.exp(-u * 0.09));
      break;
    case "fall":
      y += 30 * (1 - Math.exp(-u * 0.2));
      break;
    case "sway":
      // One sway every two beats when there is a beat; otherwise a slow free sway.
      x += Math.sin(st.beatPos ? Math.PI * st.beatPos(t) + sub.seed : t * 1.5 + sub.seed) * 2 * (0.6 + energy * 0.8);
      break;
    case "fly":
      x += Math.sin(t * 0.3 + sub.seed) * 30;
      y += Math.sin(t * 2 + sub.seed) * 4;
      gait.moving = true;
      break;
    case "drift": {
      if (alongDepth) {
        gait.moving = walker;
        if (walker) gait.away = st.travel / ROAD_STEP;
        break;
      }
      // A drifting figure strolls a short way and stops; a drifting object floats.
      if (walker) {
        const d = leg(u, 40, WALK_V * 0.55);
        gait.dist = d * s;
        x += onStep(gait.dist, gait.step) * dir;
        gait.moving = d > 0 && d < 40;
        gait.flip = dir < 0;
      } else {
        const k = Math.min(1, dt / 20);
        x += 80 * (1 - (1 - k) * (1 - k)) * dir;
        y += Math.sin(t * 0.8 + sub.seed) * 1.5;
      }
      break;
    }
    case "spin":
      gait.flip = Math.floor(t * 2 + sub.seed) % 2 === 0;
      break;
    case "still":
      break;
  }
  if (floats && !CELESTIAL.has(sub.kind)) y += Math.sin(t * 0.9 + sub.seed) * 3;
  return { x, y, gait };
}

export function renderScene(fb: FB, st: SceneState, t: number, energy: number): RenderOut {
  let p = st.params;
  // A subject-scale moon or sun replaces the sky's own, never doubles it.
  const big = st.subjects.some((s) => (s.kind === "big_moon" || s.kind === "big_sun") && s.alpha > 0.3);
  if (big) p = { ...p, sunAlpha: 0, moonAlpha: 0 };

  // Ease the framing from the previous shot to this one.
  const k = smooth(st.shotSince / SHOT_EASE);
  const fa = FRAMING[st.fromShot];
  const fz = FRAMING[st.shot];
  const fr: Framing = { feet: lerp(fa.feet, fz.feet, k), horizon: lerp(fa.horizon, fz.horizon, k), scale: k < 0.5 ? fa.scale : fz.scale };
  const ca = cameraFor(st.setting, st.fromShot);
  const cz = cameraFor(st.setting, st.shot);
  const shotY = lerp(ca.camY, cz.camY, k);
  const tilt = lerp(ca.tilt, cz.tilt, k);
  const camY = st.camY + shotY;

  const ctx: SceneCtx = { fb, p, t, energy, camX: st.camX, camY, tilt, seed: st.seed, travel: st.travel };
  if (st.plate) drawPlate(ctx, st.plate, st.setting);
  else drawBackdrop(ctx, st.setting);

  const g = groundY(st.setting);
  const light = sceneLight(p);
  const anyFocus = st.subjects.some((s) => s.focus && grounded(s, s.position) && s.alpha > 0.5);
  // Celestial subjects sit behind everything else, and a close-up subject in front of it all.
  // A crowd is the backdrop for any dancer or figure in front of it.
  const layer = (s: LiveSubject) => (CELESTIAL.has(s.kind) ? 0 : s.kind === "crowd" ? 1 : st.shot === "close" && s.focus ? 3 : 2);
  const ordered = [...st.subjects].sort((a, b) => layer(a) - layer(b));
  const pace = st.pace(t);
  const beat = st.beatPos?.(t);
  const drawOne = (sub: LiveSubject, pl: Place, pos: Position, alpha: number, glide: { dist: number; face: number; moving: boolean } | null) => {
    const onGround = grounded(sub, pos);
    const alongDepth = onGround && DEPTH_SETTINGS.has(st.setting) && (st.setting === "road" || !WALKERS.has(sub.kind));
    const far = pl.s < 1 || pos === "far";
    const sc: SpriteCtx = {
      fb, pal: p.pal, t, energy, ink: pl.ink, lights: p.lights, daylight: p.daylight, sprites: st.sprites, alongDepth,
      light, haze: far ? 0.45 : 0, hazeCol: mix(p.pal.far, p.pal.skyBot, 0.4), cast: st.cast, pace, beat, nod: st.nod,
    };
    // In a close shot the focus subject (or every ground subject, if none is marked) steps up to
    // the camera; the cut in or out eases rather than pops.
    const canClose = onGround && pos !== "far" && pos !== "foreground";
    const zIn = canClose && st.shot === "close" && (sub.focus || !anyFocus) ? 1 : 0;
    const zFrom = canClose && st.fromShot === "close" && (sub.wasFocus || !anyFocus) ? 1 : 0;
    const z = lerp(zFrom, zIn, k);
    const cu = closeUp(sub.kind);
    let s = lerp(pl.s, Math.max(pl.s, cu.scale), z);
    // Sprites only stay crisp at whole-pixel scales.
    if (s >= 1) s = FIGURES.has(sub.kind) || sub.kind === "crowd" ? Math.round(s) : s;
    const base: Place = z > 0 ? { ...pl, y: lerp(pl.y, cu.feet, z) } : pl;
    const m = applyMotion(sub, base, s, st, t, energy, g.floats, alongDepth);
    const gait = m.gait;
    if (glide) {
      gait.dist += glide.dist;
      gait.moving = glide.moving;
      gait.flip = glide.face < 0;
    }
    // Subjects ride the shot's camera shift with the layer they stand on (on a perspective road,
    // the near spot simply moves up the road to the feet line); the close-up stands on the
    // camera's own ground, below the frame.
    const depthY = !onGround ? 0.5 : pos === "far" ? 0.4 : 1;
    const shift = onGround && pos !== "far" && DEPTH_SETTINGS.has(st.setting) ? fr.feet - g.near : shotY * depthY + tilt;
    const sx = m.x - st.camX * parallax(sub, pos, st.setting, pl.y);
    const sy = m.y + st.camY * (onGround ? 1 : 0.5) + shift * (1 - z);
    const focus = sub.focus && !CELESTIAL.has(sub.kind);
    // A soft contact shadow, thrown away from the key light, plants the subject on the ground.
    if (onGround && !g.floats && pos !== "far" && !NO_SHADOW.has(sub.kind) && z < 0.5) {
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
      for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) drawSubject(sub.kind, rc, sx + dx / K, sy + dy / K, s, alpha, gait, sub.seed, sub.custom);
    }
    drawSubject(sub.kind, sc, sx, sy, s, alpha, gait, sub.seed, sub.custom);
  };

  for (const sub of ordered) {
    if (sub.alpha <= 0.01) continue;
    const to = place(sub, sub.position, st.setting, p, fr);
    if (!sub.fromPosition) {
      drawOne(sub, to, sub.position, sub.alpha, null);
      continue;
    }
    const from = place(sub, sub.fromPosition, st.setting, p, fr);
    if (ROOTED.has(sub.kind)) {
      // A house doesn't walk: it fades out of its old spot and into the new one.
      const kk = clamp(sub.move / 0.8);
      if (kk < 1) drawOne(sub, from, sub.fromPosition, sub.alpha * (1 - kk), null);
      drawOne(sub, to, sub.position, sub.alpha * kk, null);
      continue;
    }
    const dx = to.x - from.x;
    const onFoot = WALKERS.has(sub.kind) && grounded(sub, sub.position);
    let kk: number;
    let walked = 0;
    if (onFoot) {
      // Walkers cross briskly, easing in and out; the stride follows the distance actually covered.
      const len = Math.abs(dx);
      walked = len > 0 ? leg(sub.move, len, WALK_V * 1.5 * Math.max(0.5, to.s)) : 0;
      kk = len > 0 && walked < len ? onStep(walked, stepLen(Math.max(1, Math.round(to.s)))) / len : 1;
    } else {
      const lin = clamp(sub.move / GLIDE);
      kk = lin * lin * (3 - 2 * lin);
    }
    const pl: Place = { x: lerp(from.x, to.x, kk), y: lerp(from.y, to.y, kk), s: kk < 0.5 ? from.s : to.s, ink: mix(from.ink, to.ink, kk) };
    const walking = onFoot && kk < 1 && Math.abs(dx) > 2;
    drawOne(sub, pl, kk < 0.5 ? sub.fromPosition : sub.position, sub.alpha, onFoot && Math.abs(dx) > 2 ? { dist: walked, face: Math.sign(dx), moving: walking } : null);
  }

  let flash = 0;
  if (st.setting === "club") {
    // Indoors: no weather.
  } else if (st.setting === "room") {
    const wx = 190 + st.camX, wy = 34 + camY + tilt;
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
