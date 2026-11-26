import type { AnalysisSegment, SongAnalysis } from "./schema";

// A segment shorter than this with no singing is a pickup or a breath, not a part of the song.
export const MIN_INSTRUMENTAL_S = 4;

export interface TimelineEntry {
  t: number;
  text: string;
  // Index into lyrics.lines, or null for an instrumental marker.
  lyric: number | null;
  segment?: AnalysisSegment;
}

const fmt = (t: number) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, "0")}`;

// Segments with no lyric line starting in them. The last second is excluded because a line's
// timestamp often lands just before the bar it is sung over.
export function instrumentalSegments(analysis: SongAnalysis, lineTimes: number[]): AnalysisSegment[] {
  return analysis.segments.filter(
    (s) => s.end - s.start >= MIN_INSTRUMENTAL_S && !lineTimes.some((t) => t >= s.start && t < s.end - 1),
  );
}

// Lyric lines plus one marker per instrumental segment, in time order. The scene model sees
// these as numbered lines, so instrumental stretches can get sections and moments of their own.
export function buildTimeline(lines: { t: number; text: string }[], analysis: SongAnalysis | null): TimelineEntry[] {
  const out: TimelineEntry[] = lines.map((l, i) => ({ t: l.t, text: l.text, lyric: i }));
  if (analysis) {
    for (const s of instrumentalSegments(analysis, lines.map((l) => l.t))) {
      out.push({ t: s.start, text: `(instrumental, ${fmt(s.start)}-${fmt(s.end)}, part ${s.label})`, lyric: null, segment: s });
    }
  }
  // Markers sort before a lyric at the same instant so the marker can open the section.
  return out.sort((a, b) => a.t - b.t || (a.lyric === null ? -1 : 0) - (b.lyric === null ? -1 : 0));
}

// Without lyrics, the analysis segments are the lines; long ones are split so a scene still
// has a few moments to change on.
export function segmentLines(analysis: SongAnalysis): { t: number; text: string }[] {
  const out: { t: number; text: string }[] = [];
  for (const s of analysis.segments) {
    const parts = Math.max(1, Math.round((s.end - s.start) / 15));
    const len = (s.end - s.start) / parts;
    for (let p = 0; p < parts; p++) {
      const a = s.start + p * len;
      const word = s.energy < 0.4 ? "quiet" : s.energy < 0.7 ? "moderate" : s.energy < 0.88 ? "strong" : "peak";
      out.push({ t: a, text: `${fmt(a)}-${fmt(a + len)} part ${s.label}, energy ${s.energy.toFixed(2)} (${word})${p ? " continued" : ""}` });
    }
  }
  return out;
}

export function barSeconds(analysis: SongAnalysis): number {
  const d = analysis.downbeats;
  if (d.length >= 3) {
    const gaps = d.slice(1).map((v, i) => v - d[i]).sort((a, b) => a - b);
    return gaps[Math.floor(gaps.length / 2)];
  }
  return (60 / Math.max(1, analysis.tempo.bpm)) * (analysis.tempo.beatsPerBar ?? 4);
}

// Nearest downbeat within half a bar, so a section change lands on the "one"; times with no
// downbeat that close (rubato, a missing beat track) stay where the lyrics put them.
export function snapToDownbeat(t: number, analysis: SongAnalysis): number {
  const d = analysis.downbeats;
  if (!d.length) return t;
  let lo = 0;
  let hi = d.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (d[mid] < t) lo = mid + 1;
    else hi = mid;
  }
  const near = [d[lo - 1], d[lo]].filter((v) => v !== undefined).sort((a, b) => Math.abs(a - t) - Math.abs(b - t))[0];
  return Math.abs(near - t) <= barSeconds(analysis) / 2 ? near : t;
}

export function beatSeconds(analysis: SongAnalysis): number {
  return barSeconds(analysis) / (analysis.tempo.beatsPerBar ?? 4);
}

export function dominantSegment(analysis: SongAnalysis, start: number, end: number): AnalysisSegment | null {
  let best: AnalysisSegment | null = null;
  let bestOverlap = 0;
  for (const s of analysis.segments) {
    const o = Math.min(end, s.end) - Math.max(start, s.start);
    if (o > bestOverlap) {
      best = s;
      bestOverlap = o;
    }
  }
  return best;
}
