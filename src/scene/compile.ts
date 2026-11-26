import type { Track } from "../library/library";
import { energySegments, type Envelope } from "../audio/envelope";
import type { ModelOutput, SceneScript, Section } from "./schema";
import type { Mood, Setting, Transition } from "./vocab";
import type { PseudoLine } from "./prompt";

const TRANSITION_SECONDS: Record<Transition, number> = {
  flash: 0.4,
  fade_black: 2,
  dissolve: 1.6,
  crossfade: 1.6,
  pan_up: 2.6,
  pan_down: 2.6,
  pan_left: 2.4,
  pan_right: 2.4,
  zoom_in: 2.2,
  time_shift: 4,
  weather_shift: 3,
};

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

export function compile(
  out: ModelOutput,
  lineTimes: number[],
  duration: number,
  trackKey: string,
  source: SceneScript["source"],
): SceneScript {
  const n = lineTimes.length;
  const last = Math.max(0, n - 1);
  const raw = out.sections
    .map((s) => ({ ...s, fromLine: clamp(s.fromLine, 0, last), toLine: clamp(s.toLine, 0, last) }))
    .filter((s) => s.toLine >= s.fromLine)
    .sort((a, b) => a.fromLine - b.fromLine)
    .filter((s, i, arr) => i === 0 || s.fromLine > arr[i - 1].fromLine);
  if (!raw.length) throw new Error("Scene script had no usable sections");

  const sections: Section[] = raw.map((s, i) => {
    const start = i === 0 ? 0 : (lineTimes[s.fromLine] ?? 0);
    const nextFrom = raw[i + 1]?.fromLine;
    const end = nextFrom !== undefined ? (lineTimes[nextFrom] ?? duration) : Math.max(duration, start + 1);
    const moments = s.moments
      .filter((m) => m.line >= s.fromLine && m.line <= s.toLine)
      .map((m) => ({
        t: lineTimes[m.line] ?? start,
        subjects: m.subjects.slice(0, 5),
        particles: m.particles,
        event: m.event,
        intensity: clamp(m.intensity, 0, 1),
      }))
      .sort((a, b) => a.t - b.t);
    if (!moments.length) moments.push({ t: start, subjects: [], particles: "none", event: "none", intensity: 0.4 });
    return {
      label: s.label,
      start,
      end,
      world: s.world,
      transitionIn: s.transitionIn,
      transitionDuration: TRANSITION_SECONDS[s.transitionIn],
      moments,
    };
  });

  // A transition may not eat more than half of the section it leaves.
  for (let i = 1; i < sections.length; i++) {
    const prevLen = sections[i - 1].end - sections[i - 1].start;
    sections[i].transitionDuration = Math.min(sections[i].transitionDuration, prevLen / 2);
  }

  return {
    version: 1,
    trackKey,
    source,
    style: out.style,
    cast: out.cast,
    sections,
    unmapped: [...new Set(out.unmapped.map((u) => u.trim().toLowerCase()).filter(Boolean))],
    createdAt: Date.now(),
  };
}

export function pseudoLines(env: Envelope | null, duration: number): PseudoLine[] {
  const seg = duration > 360 ? 20 : 12;
  return energySegments(env, duration, seg).map((s) => {
    const word = s.energy < 0.25 ? "quiet" : s.energy < 0.5 ? "moderate" : s.energy < 0.75 ? "strong" : "peak";
    const m = (t: number) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, "0")}`;
    return { t: s.start, text: `${m(s.start)}-${m(s.end)} energy ${s.energy.toFixed(2)} (${word})` };
  });
}

const AMBIENT_SETTINGS: Setting[] = ["field", "lake", "ocean", "mountains", "sky", "city"];

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

// Shown while the real script generates, and when no provider is available.
export function ambientScript(track: Track, env: Envelope | null, trackKey: string): SceneScript {
  const h = hash(`${track.artist}|${track.title}`);
  const segs = energySegments(env, track.duration || 180, 30);
  const avg = segs.reduce((n, s) => n + s.energy, 0) / Math.max(1, segs.length);
  const mood: Mood = avg > 0.6 ? "euphoric" : avg > 0.4 ? "serene" : "melancholy";
  return {
    version: 1,
    trackKey,
    source: "ambient",
    style: "natural",
    sections: [
      {
        label: "instrumental",
        start: 0,
        end: Math.max(1, track.duration),
        world: {
          setting: AMBIENT_SETTINGS[h % AMBIENT_SETTINGS.length],
          timeOfDay: (["dusk", "night", "dawn"] as const)[(h >>> 4) % 3],
          weather: "clear",
          mood,
          camera: "drift",
        },
        transitionIn: "fade_black",
        transitionDuration: 2,
        moments: [{ t: 0, subjects: [], particles: avg > 0.5 ? "sparkles" : "fireflies", event: "none", intensity: avg }],
      },
    ],
    unmapped: [],
    createdAt: Date.now(),
  };
}
