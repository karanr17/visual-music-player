import { rhythmFrame, type Reactivity, type Rhythm, type RhythmFrame } from "../audio/rhythm";
import type { SceneScript, Section, SubjectSpec } from "../scene/schema";
import type { Transition } from "../scene/vocab";
import { bayer, clamp, FB, H, K, mix, pack, PH, PW, smooth, unpack, W } from "./fb";
import { hash1, noise2, seedOf } from "./noise";
import { lerpParams, worldParams, type WorldParams } from "./palette";
import { DEFAULT_CAST } from "../scene/normalize";
import { PALETTE_LOOKS, postProcess, type Look } from "./style";
import { compileSprite, type CustomSprite } from "./sprites";
import { alignStep, renderScene, SHOT_EASE, travelSpeed, type LiveSubject, type RenderOut, type SceneState } from "./world";

const FADE_IN = 0.6;
const FADE_OUT = 0.6;
const PARTICLE_RAMP = 0.8;
const LIGHTS_RAMP = 0.6;
const TRAVEL_RAMP = 1.5;

// Fraction of a transition that happens before the boundary. Flash peaks just
// before the downbeat and decays after it; everything else lands on the boundary.
const LEAD: Partial<Record<Transition, number>> = { flash: 0.35 };

const PARAM_BLEND = new Set<Transition>(["time_shift", "weather_shift", "crossfade", "dissolve"]);

interface Audio {
  energy: number;
  onset: number;
}

// Dissolve threshold per pixel: mostly soft noise (the new scene spreads in organic patches),
// with a little ordered dither so patch edges stay pixel-crisp instead of a fine checkerboard.
const DISSOLVE = (() => {
  const t = new Float32Array(PW * PH);
  for (let y = 0; y < PH; y++) for (let x = 0; x < PW; x++) t[y * PW + x] = 0.8 * noise2(x / (18 * K), y / (18 * K), 7) + 0.2 * bayer(x, y);
  let lo = Infinity;
  let hi = -Infinity;
  for (const v of t) {
    lo = Math.min(lo, v);
    hi = Math.max(hi, v);
  }
  for (let i = 0; i < t.length; i++) t[i] = (t[i] - lo) / (hi - lo);
  return t;
})();

const ease = (p: number) => (p < 0.5 ? 4 * p * p * p : 1 - (-2 * p + 2) ** 3 / 2);

function key(s: SubjectSpec): string {
  return s.kind === "custom" ? `custom:${s.custom}` : s.kind;
}

// Pairs subjects across two moments by kind so a figure that persists keeps
// existing (and glides if its position changed) instead of popping out and back in.
function diffSubjects(prev: SubjectSpec[], cur: SubjectSpec[]): { cur: [SubjectSpec, SubjectSpec | null][]; gone: SubjectSpec[] } {
  const pool = [...prev];
  const out: [SubjectSpec, SubjectSpec | null][] = [];
  for (const c of cur) {
    let idx = pool.findIndex((p) => key(p) === key(c) && p.position === c.position);
    if (idx < 0) idx = pool.findIndex((p) => key(p) === key(c));
    out.push([c, idx >= 0 ? pool.splice(idx, 1)[0] : null]);
  }
  return { cur: out, gone: pool };
}

export class Director {
  private params: WorldParams[] = [];
  private seeds: number[] = [];
  private sprites = new Map<string, CustomSprite>();
  private speeds: number[][] = [];
  private travelBase: number[] = [];
  private a = new FB();
  private b = new FB();
  private snap = new FB();
  private seekFrom = -1;
  private dissolveMs = 350;
  private lastT = -1;
  // ∫₀ᵗ energy dτ for the playing track; the default assumes a steady mid level.
  private energyInt: (t: number) => number = (t) => 0.4 * t;
  private energyPace = (t: number) => 0.6 * t + 0.8 * this.energyInt(t);
  private pace = this.energyPace;
  private rhythm: Rhythm | null = null;
  private reactivity: Reactivity = "off";
  private beatPos: ((t: number) => number) | undefined;
  readonly out = new FB();

  constructor(
    private script: SceneScript,
    private style: Look,
  ) {
    this.load(script, style);
  }

  get loadedScript(): SceneScript {
    return this.script;
  }

  load(script: SceneScript, style: Look): void {
    this.script = script;
    this.style = style;
    this.params = script.sections.map((s) => worldParams(s.world));
    this.seeds = script.sections.map((s, i) => seedOf(`${script.trackKey}|${s.world.setting}|${s.recurrence ?? i % 3}`));
    this.sprites = new Map((script.sprites ?? []).map((sp) => [sp.name, compileSprite(sp.palette, sp.rows)]));
    this.speeds = script.sections.map((s) => s.moments.map((m) => travelSpeed(s.world.setting, m.subjects)));
    // Carried across sections so a road that continues into the next section keeps rolling.
    this.travelBase = [0];
    for (let i = 1; i < script.sections.length; i++) this.travelBase.push(this.travelBase[i - 1] + this.travelIn(i - 1, script.sections[i].start));
  }


  // With a beat grid and reactivity on, walking steps land on beats, downbeats lift the light,
  // strong beats nudge the camera and the high band thins or thickens particles. Without either,
  // the scene moves with the energy envelope as before.
  setRhythm(rhythm: Rhythm | null, reactivity: Reactivity): void {
    this.rhythm = reactivity === "off" ? null : rhythm;
    this.reactivity = reactivity;
    const r = this.rhythm;
    this.pace = r ? (t) => r.pace(t) : this.energyPace;
    this.beatPos = r ? (t) => r.beatPos(t) : undefined;
  }

  private beat(t: number): RhythmFrame | null {
    return this.rhythm && this.reactivity !== "off" ? rhythmFrame(this.rhythm, this.reactivity, t) : null;
  }

  // A one-shot accent (lightning, flash, pulse) hits on the beat nearest its lyric line.
  private event(m: Section["moments"][number], t: number): SceneState["event"] {
    if (m.event === "none") return null;
    let at = m.t;
    const r = this.rhythm;
    if (r) {
      const b = Math.round(r.beatPos(m.t));
      const i = Math.max(0, Math.min(r.beats.length - 1, b));
      if (Math.abs(r.beats[i] - m.t) <= r.beatPeriod / 2) at = r.beats[i];
    }
    return t >= at ? { kind: m.event, dt: t - at, seed: Math.floor(m.t * 10) } : null;
  }

  setEnergyIntegral(fn: (t: number) => number): void {
    this.energyInt = fn;
  }

  // Dissolves from whatever is on screen now into whatever renders next (seeks, script swaps).
  dissolveIn(ms: number): void {
    this.snap.copyFrom(this.out);
    this.seekFrom = performance.now();
    this.dissolveMs = ms;
  }

  private sectionIndex(t: number): number {
    const ss = this.script.sections;
    for (let i = ss.length - 1; i >= 0; i--) if (t >= ss[i].start) return i;
    return 0;
  }

  private lights(sec: Section, base: number, k: number, t: number): number {
    let level = base;
    for (let i = 0; i <= k; i++) {
      const m = sec.moments[i];
      if (m.event !== "lights_on" && m.event !== "lights_off") continue;
      const target = m.event === "lights_on" ? 1 : 0.08;
      level = level + (target - level) * clamp((t - m.t) / LIGHTS_RAMP);
    }
    return level;
  }

  // Road distance as the integral of a speed that eases between moments: a pure function of t,
  // so seeking lands on the same frame and the stripes never jump when the speed changes.
  private travel(i: number, t: number): number {
    return (this.travelBase[i] ?? 0) + this.travelIn(i, t);
  }

  private travelIn(i: number, t: number): number {
    const sec = this.script.sections[i];
    const ms = sec.moments;
    const v = this.speeds[i];
    if (!ms.length) return 0;
    let d = v[0] * (Math.min(t, ms[0].t) - sec.start);
    for (let j = 0; j < ms.length && ms[j].t < t; j++) {
      const from = j > 0 ? v[j - 1] : v[0];
      const len = Math.min(t, ms[j + 1]?.t ?? Infinity) - ms[j].t;
      const r = Math.min(len, TRAVEL_RAMP);
      d += from * r + ((v[j] - from) * r * r) / (2 * TRAVEL_RAMP) + v[j] * (len - r);
    }
    return d;
  }

  private camera(i: number, t: number, a: Audio, intensity: number): { x: number; y: number } {
    const sec = this.script.sections[i];
    const amp = 0.7 + intensity * 0.6;
    let x = 0;
    let y = 0;
    switch (sec.world.camera) {
      case "drift":
        x = Math.sin(t * 0.07) * 25 * amp;
        y = Math.sin(t * 0.05) * 2;
        break;
      case "slow_pan":
        x = (t - sec.start) * 3;
        break;
      case "float":
        x = Math.sin(t * 0.11) * 10;
        y = Math.sin(t * 0.3) * 5 * amp;
        break;
      case "static":
        break;
    }
    const beat = this.beat(t);
    y += beat ? beat.bump : a.onset * 4;
    return { x, y };
  }

  private state(i: number, t: number, a: Audio, entering: boolean): SceneState {
    const sec = this.script.sections[i];
    const ms = sec.moments;
    let k = 0;
    for (let j = ms.length - 1; j >= 0; j--) {
      if (t >= ms[j].t) {
        k = j;
        break;
      }
    }
    const m = ms[k];
    const prev = k > 0 ? ms[k - 1] : null;
    const since = Math.max(0, t - m.t);
    // Section's first moment arrives with the section transition; it doesn't fade on its own.
    const fresh = prev && !entering ? clamp(since / FADE_IN) : 1;

    const subjects: LiveSubject[] = [];
    const slots = new Map<string, number>();
    const slotOf = (pos: string) => {
      const n = slots.get(pos) ?? 0;
      slots.set(pos, n + 1);
      return n;
    };
    const { cur, gone } = diffSubjects(prev?.subjects ?? [], m.subjects);
    cur.forEach(([s, before], idx) => {
      subjects.push({
        kind: s.kind,
        custom: s.custom ?? "",
        focus: !!s.focus,
        wasFocus: before ? !!before.focus : !!s.focus,
        position: s.position,
        fromPosition: before && before.position !== s.position ? before.position : null,
        motion: s.motion,
        alpha: before ? 1 : fresh,
        move: since,
        since: before ? (prev?.t ?? m.t) : m.t,
        slot: slotOf(s.position),
        seed: hash1(i * 101 + idx * 7 + s.kind.length) * 100,
      });
    });
    if (prev && since < FADE_OUT) {
      gone.forEach((s, idx) => {
        subjects.push({
          kind: s.kind,
          custom: s.custom ?? "",
          focus: !!s.focus,
          wasFocus: !!s.focus,
          position: s.position,
          fromPosition: null,
          motion: s.motion,
          alpha: 1 - since / FADE_OUT,
          move: Infinity,
          since: prev.t,
          slot: slotOf(s.position),
          seed: hash1(i * 101 + idx * 13 + 5) * 100,
        });
      });
    }

    const ramp = prev ? clamp(since / PARTICLE_RAMP) : 1;
    const gain = this.beat(t)?.particles ?? 1;
    const particles =
      prev && prev.particles !== m.particles
        ? [{ kind: prev.particles, amount: (1 - ramp) * gain }, { kind: m.particles, amount: ramp * gain }]
        : [{ kind: m.particles, amount: gain }];

    const params = { ...this.params[i], lights: this.lights(sec, this.params[i].lights, k, t) };
    const cam = this.camera(i, t, a, m.intensity);
    return {
      setting: sec.world.setting,
      params,
      subjects,
      particles,
      event: this.event(m, t),
      camX: cam.x,
      camY: cam.y,
      seed: this.seeds[i],
      travel: this.travel(i, t),
      sprites: this.sprites,
      backlight: !PALETTE_LOOKS.has(this.style),
      cast: this.script.cast ?? DEFAULT_CAST,
      // A section's first moment arrives with the section transition, so it doesn't ease in.
      shot: m.shot ?? "medium",
      fromShot: prev ? (prev.shot ?? "medium") : (m.shot ?? "medium"),
      shotSince: since,
      pace: this.pace,
      stepAlign: this.rhythm ? alignStep : undefined,
      beatPos: this.rhythm ? this.beatPos : undefined,
      nod: this.beat(t)?.nod ?? 0,
    };
  }

  private shake(st: SceneState): { x: number; y: number } {
    if (st.event?.kind !== "shake" || st.event.dt > 1.2) return { x: 0, y: 0 };
    const amp = 4 * Math.exp(-st.event.dt * 2.5);
    const f = Math.floor(st.event.dt * 30);
    return { x: (hash1(f) - 0.5) * 2 * amp, y: (hash1(f + 99) - 0.5) * 2 * amp };
  }

  private draw(fb: FB, st: SceneState, t: number, a: Audio): RenderOut {
    const sh = this.shake(st);
    st.camX += sh.x;
    st.camY += sh.y;
    return renderScene(fb, st, t, a.energy);
  }

  // Blends two moments' worth of state into one scene for same-setting transitions.
  private blendStates(A: SceneState, B: SceneState, k: number): SceneState {
    const subjects: LiveSubject[] = [];
    const bKinds = new Map<string, LiveSubject>();
    const id = (s: LiveSubject) => `${s.kind}|${s.custom}|${s.position}`;
    for (const s of B.subjects) bKinds.set(id(s), s);
    for (const s of A.subjects) {
      const match = bKinds.get(id(s));
      if (match) {
        subjects.push({ ...match, alpha: Math.max(s.alpha, match.alpha) });
        bKinds.delete(id(s));
      } else subjects.push({ ...s, alpha: s.alpha * (1 - k) });
    }
    for (const s of bKinds.values()) subjects.push({ ...s, alpha: s.alpha * k });
    return {
      setting: B.setting,
      params: lerpParams(A.params, B.params, k),
      subjects,
      particles: [...A.particles.map((p) => ({ ...p, amount: p.amount * (1 - k) })), ...B.particles.map((p) => ({ ...p, amount: p.amount * k }))],
      event: k < 0.5 ? A.event : B.event,
      camX: A.camX + (B.camX - A.camX) * k,
      camY: A.camY + (B.camY - A.camY) * k,
      seed: A.seed,
      travel: A.travel + (B.travel - A.travel) * k,
      sprites: this.sprites,
      backlight: !PALETTE_LOOKS.has(this.style),
      cast: this.script.cast ?? DEFAULT_CAST,
      // The framing moves from A's shot to B's over the blend.
      shot: B.shot,
      fromShot: A.shot,
      shotSince: k * SHOT_EASE,
      nod: B.nod,
      pace: this.pace,
      stepAlign: this.rhythm ? alignStep : undefined,
      beatPos: this.rhythm ? this.beatPos : undefined,
    };
  }

  frame(t: number, audio: Audio): FB {
    // A jump in time is a seek: keep the previous frame so the new one dissolves in over it.
    if (this.lastT >= 0 && Math.abs(t - this.lastT) > 1.5) {
      this.dissolveIn(350);
    }
    const ss = this.script.sections;
    const i = this.sectionIndex(t);
    const next = ss[i + 1];
    let ov: RenderOut | null = null;

    // Is t inside the window of the transition into the next section (or still
    // inside the tail of the transition into this one, for flash)?
    let tr: { from: number; to: number; p: number; type: Transition } | null = null;
    const windowFor = (j: number) => {
      const s = ss[j];
      const lead = LEAD[s.transitionIn] ?? 1;
      return { start: s.start - s.transitionDuration * lead, end: s.start + s.transitionDuration * (1 - lead) };
    };
    if (next) {
      const w = windowFor(i + 1);
      if (t >= w.start && t < w.end) tr = { from: i, to: i + 1, p: (t - w.start) / (w.end - w.start), type: next.transitionIn };
    }
    if (!tr && i > 0) {
      const w = windowFor(i);
      if (t >= w.start && t < w.end) tr = { from: i - 1, to: i, p: (t - w.start) / (w.end - w.start), type: ss[i].transitionIn };
    }

    if (!tr) {
      ov = this.draw(this.out, this.state(i, t, audio, false), t, audio);
      if (i === 0 && t < ss[0].transitionDuration) this.fromBlack(ss[0].transitionIn, t / Math.max(0.01, ss[0].transitionDuration));
    } else {
      ov = this.transition(tr.from, tr.to, tr.type, clamp(tr.p), t, audio);
    }

    const lift = this.beat(t)?.lift ?? 0;
    if (ov && lift) ov = { ...ov, brightness: ov.brightness * (1 + lift) };
    // Grain is seeded from t rather than a frame counter, so a seek lands on the same pixels.
    postProcess(this.out, this.style, Math.floor(t * 30), ov);
    this.applySeekDissolve();
    this.lastT = t;
    return this.out;
  }

  private transition(fi: number, ti: number, type: Transition, p: number, t: number, audio: Audio): RenderOut {
    const ss = this.script.sections;
    const A = this.state(fi, t, audio, false);
    const B = this.state(ti, t, audio, true);
    const same = ss[fi].world.setting === ss[ti].world.setting;
    const e = ease(p);

    if (same && PARAM_BLEND.has(type)) return this.draw(this.out, this.blendStates(A, B, smooth(p)), t, audio);
    if (!same && (type === "time_shift" || type === "weather_shift")) type = "dissolve";

    const out = this.out.data;
    const ad = this.a.data;
    const bd = this.b.data;
    let ov: RenderOut;

    switch (type) {
      case "pan_up":
      case "pan_down": {
        const dir = type === "pan_up" ? 1 : -1;
        const dist = H * 1.15 * dir;
        A.camY += e * dist;
        B.camY += (1 - e) * dist;
        const oa = this.draw(this.a, A, t, audio);
        const ob = this.draw(this.b, B, t, audio);
        ov = p < 0.5 ? oa : ob;
        this.ditherMix(ad, bd, out, smooth((p - 0.38) / 0.24));
        break;
      }
      case "pan_left":
      case "pan_right": {
        const dir = type === "pan_right" ? 1 : -1;
        const dist = W * 1.3 * dir;
        A.camX += e * dist;
        B.camX -= (1 - e) * dist;
        const oa = this.draw(this.a, A, t, audio);
        const ob = this.draw(this.b, B, t, audio);
        ov = p < 0.5 ? oa : ob;
        this.ditherMix(ad, bd, out, smooth((p - 0.3) / 0.4));
        break;
      }
      case "zoom_in": {
        const oa = this.draw(this.a, A, t, audio);
        const ob = this.draw(this.b, B, t, audio);
        ov = p < 0.5 ? oa : ob;
        const z = 1 + e * e * 5;
        const mixK = smooth((p - 0.45) / 0.4);
        const cx = PW / 2;
        const cy = PH * 0.55;
        for (let y = 0; y < PH; y++) {
          const sy = Math.min(PH - 1, Math.max(0, Math.floor(cy + (y - cy) / z)));
          for (let x = 0; x < PW; x++) {
            const sx = Math.min(PW - 1, Math.max(0, Math.floor(cx + (x - cx) / z)));
            const i = y * PW + x;
            out[i] = DISSOLVE[i] < mixK ? bd[i] : ad[sy * PW + sx];
          }
        }
        break;
      }
      case "fade_black": {
        if (p < 0.5) {
          ov = this.draw(this.out, A, t, audio);
          ov = { ...ov, brightness: ov.brightness * (1 - smooth(p * 2)) };
        } else {
          ov = this.draw(this.out, B, t, audio);
          ov = { ...ov, brightness: ov.brightness * smooth((p - 0.5) * 2) };
        }
        break;
      }
      case "flash": {
        const lead = LEAD.flash ?? 0.5;
        ov = this.draw(this.out, p < lead ? A : B, t, audio);
        const f = p < lead ? (p / lead) ** 2 : 1 - (p - lead) / (1 - lead);
        ov = { ...ov, flash: Math.max(ov.flash, f) };
        break;
      }
      case "crossfade": {
        const oa = this.draw(this.a, A, t, audio);
        const ob = this.draw(this.b, B, t, audio);
        ov = p < 0.5 ? oa : ob;
        const k = smooth(p);
        for (let i = 0; i < out.length; i++) out[i] = pack(mix(unpack(ad[i]), unpack(bd[i]), k));
        break;
      }
      default: {
        const oa = this.draw(this.a, A, t, audio);
        const ob = this.draw(this.b, B, t, audio);
        ov = p < 0.5 ? oa : ob;
        this.ditherMix(ad, bd, out, smooth(p));
      }
    }
    return ov;
  }

  private ditherMix(a: Uint32Array, b: Uint32Array, out: Uint32Array, k: number): void {
    for (let i = 0; i < out.length; i++) out[i] = DISSOLVE[i] < k ? b[i] : a[i];
  }

  private fromBlack(type: Transition, p: number): void {
    const d = this.out.data;
    const k = smooth(p);
    if (type === "dissolve" || type === "crossfade") {
      for (let i = 0; i < d.length; i++) if (DISSOLVE[i] >= k) d[i] = 0xff000000;
      return;
    }
    for (let i = 0; i < d.length; i++) {
      const c = unpack(d[i]);
      d[i] = pack([c[0] * k, c[1] * k, c[2] * k].map(Math.round) as [number, number, number]);
    }
  }

  private applySeekDissolve(): void {
    if (this.seekFrom < 0) return;
    const p = (performance.now() - this.seekFrom) / this.dissolveMs;
    if (p >= 1) {
      this.seekFrom = -1;
      return;
    }
    const d = this.out.data;
    const s = this.snap.data;
    for (let i = 0; i < d.length; i++) if (DISSOLVE[i] >= p) d[i] = s[i];
  }
}
