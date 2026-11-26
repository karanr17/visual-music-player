import type { SongAnalysis } from "../analysis/schema";
import { FOOTFALL_PACE } from "../render/characters";

// The beat grid and band levels of a song as pure functions of time, so anything the renderer
// drives from them lands on the same frame however playback got to t (play, seek, capture).

export type Reactivity = "off" | "subtle" | "strong";

// The walk pace the renderer was tuned for at a typical energy (0.6 + 0.8 × 0.4 pace-s per s).
const NOMINAL_PACE_RATE = 0.92;

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : 0;
}

function gaps(times: number[]): number[] {
  return times.slice(1).map((v, i) => v - times[i]);
}

// Index of the last time ≤ t, or -1.
export function lastAtOrBefore(times: number[], t: number): number {
  let lo = 0;
  let hi = times.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (times[mid] <= t) lo = mid + 1;
    else hi = mid;
  }
  return lo - 1;
}

// Continuous position on a grid of event times: exactly k at the k-th event, linear between
// events, and extrapolated at the median period before the first and after the last.
export function gridPosition(times: number[], period: number, t: number): number {
  const n = times.length;
  if (!n) return t / period;
  if (t <= times[0]) return (t - times[0]) / period;
  if (t >= times[n - 1]) return n - 1 + (t - times[n - 1]) / period;
  const i = lastAtOrBefore(times, t);
  return i + (t - times[i]) / (times[i + 1] - times[i]);
}

// Time since the most recent grid event, extending the grid backwards before its first event.
function sinceLast(times: number[], period: number, t: number): number {
  if (!times.length) return ((t % period) + period) % period;
  const i = lastAtOrBefore(times, t);
  if (i >= 0) return t - times[i];
  const d = times[0] - t;
  return period - (d % period);
}

function sampler(series: number[], rate: number): (t: number) => number {
  if (!series.length || rate <= 0) return () => 0.5;
  return (t) => {
    const x = Math.max(0, Math.min(series.length - 1, t * rate));
    const i = Math.floor(x);
    const j = Math.min(series.length - 1, i + 1);
    return series[i] + (series[j] - series[i]) * (x - i);
  };
}

export class Rhythm {
  readonly beats: number[];
  readonly downbeats: number[];
  readonly beatPeriod: number;
  readonly barPeriod: number;
  // How many footfalls per beat keep the walk near the speed the renderer was tuned for:
  // 2 for slow songs (or a tempo read at half speed), ½ for fast ones.
  readonly footfallsPerBeat: number;
  readonly rms: (t: number) => number;
  readonly low: (t: number) => number;
  // 0..1 within this song's usual range.
  readonly high: (t: number) => number;
  // 0..1 per beat: how hard the low end hits on it, relative to the song's own range.
  private strength: number[];

  constructor(analysis: SongAnalysis) {
    const bpm = analysis.tempo.bpm > 0 ? analysis.tempo.bpm : 120;
    const perBar = analysis.tempo.beatsPerBar ?? 4;
    const dur = analysis.source.durationS;
    let beats = analysis.beats;
    if (beats.length < 2) {
      // Tempo only: an even grid from the first downbeat (or 0).
      const p = 60 / bpm;
      const t0 = analysis.downbeats[0] ?? 0;
      beats = Array.from({ length: Math.max(2, Math.ceil((dur - t0) / p)) }, (_, i) => t0 + i * p);
    }
    this.beats = beats;
    this.beatPeriod = median(gaps(beats)) || 60 / bpm;
    this.downbeats = analysis.downbeats.length >= 2 ? analysis.downbeats : beats.filter((_, i) => i % perBar === 0);
    this.barPeriod = median(gaps(this.downbeats)) || this.beatPeriod * perBar;

    const rate = (fpb: number) => (FOOTFALL_PACE * fpb) / this.beatPeriod;
    this.footfallsPerBeat = [0.5, 1, 2].reduce((best, f) =>
      Math.abs(Math.log(rate(f) / NOMINAL_PACE_RATE)) < Math.abs(Math.log(rate(best) / NOMINAL_PACE_RATE)) ? f : best,
    );

    const e = analysis.energy;
    this.rms = sampler(e.rms, e.frameRate);
    this.low = sampler(e.low, e.frameRate);
    // The band envelopes are scaled to the song's own peak, so the high band sits near the top
    // for most of a song; spreading its 10th-90th percentile over 0..1 makes changes show.
    const highRaw = sampler(e.high, e.frameRate);
    const hs = [...e.high].sort((a, b) => a - b);
    const h10 = hs[Math.floor(hs.length * 0.1)] ?? 0;
    const h90 = hs[Math.floor(hs.length * 0.9)] ?? 1;
    this.high = hs.length ? (t) => Math.max(0, Math.min(1, (highRaw(t) - h10) / Math.max(1e-3, h90 - h10))) : () => 0.5;
    const lows = beats.map((b) => this.low(b));
    const sorted = [...lows].sort((a, b) => a - b);
    const lo = sorted[Math.floor(sorted.length * 0.3)] ?? 0;
    const hi = sorted[Math.floor(sorted.length * 0.95)] ?? 1;
    this.strength = lows.map((v) => Math.max(0, Math.min(1, (v - lo) / Math.max(1e-3, hi - lo))));
  }

  // A plain grid at a known tempo, for when there is no analysis but the tempo is known.
  static fromTempo(bpm: number, durationS: number): Rhythm {
    return new Rhythm({
      schemaVersion: "1.0",
      analyzer: { version: "", model: "", calibration: "" },
      source: { sha256: "", durationS, sampleRate: 0 },
      tempo: { bpm, confidence: 0 },
      beats: [],
      downbeats: [],
      onsets: [],
      energy: { frameRate: 0, loudnessDb: 0, rms: [], low: [], mid: [], high: [] },
      segments: [],
      descriptors: {},
    });
  }

  beatPos(t: number): number {
    return gridPosition(this.beats, this.beatPeriod, t);
  }

  // Pace-seconds walked by t: a whole number of footfall periods at each beat, so a figure that
  // starts in step stays in step.
  pace(t: number): number {
    return this.beatPos(t) * this.footfallsPerBeat * FOOTFALL_PACE;
  }

  sinceBeat(t: number): number {
    return sinceLast(this.beats, this.beatPeriod, t);
  }

  sinceDownbeat(t: number): number {
    return sinceLast(this.downbeats, this.barPeriod, t);
  }

  lastBeat(t: number): { strength: number; dt: number } {
    const i = lastAtOrBefore(this.beats, t);
    return { strength: i >= 0 ? this.strength[i] : 0, dt: this.sinceBeat(t) };
  }
}

export interface RhythmFrame {
  // Added to the frame's brightness (0 = unchanged).
  lift: number;
  // Camera drop in logical pixels.
  bump: number;
  // Multiplier on particle amounts, 0..1.
  particles: number;
  // Source pixels standing figures' heads dip, held for the first part of each beat.
  nod: number;
}

const LEVELS = {
  subtle: { downbeat: 0.05, beat: 0.015, bump: 1.2, particles: 0.35, nod: 1 },
  strong: { downbeat: 0.13, beat: 0.04, bump: 3, particles: 0.7, nod: 2 },
} as const;

// Decays fast enough to read as a hit, slow enough to survive 30 fps.
const LIFT_DECAY_S = 0.22;
const BUMP_DECAY_S = 0.09;

export function rhythmFrame(r: Rhythm, level: Exclude<Reactivity, "off">, t: number): RhythmFrame {
  const L = LEVELS[level];
  // Quiet passages pulse less; the loudest pulse fully.
  const drive = 0.3 + 0.7 * r.rms(t);
  const lift = drive * (L.downbeat * Math.exp(-r.sinceDownbeat(t) / LIFT_DECAY_S) + L.beat * Math.exp(-r.sinceBeat(t) / LIFT_DECAY_S));
  const { strength, dt } = r.lastBeat(t);
  // Only beats with a real low-end hit move the camera; soft ones would just make it wobble.
  const hit = Math.max(0, strength - 0.4) / 0.6;
  const bump = L.bump * hit * Math.exp(-dt / BUMP_DECAY_S);
  const particles = 1 - L.particles + L.particles * r.high(t);
  // Pixel art can't dip by a fraction, so the head drops a whole step and comes back up.
  const nod = r.sinceBeat(t) < r.beatPeriod * 0.3 ? L.nod : 0;
  return { lift, bump, particles, nod };
}
