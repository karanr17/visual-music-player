import type { Track } from "../library/library";

export interface LyricWord {
  text: string;
  t: number;
}

export interface LyricLine {
  t: number;
  end: number;
  text: string;
  words: LyricWord[];
}

export interface Lyrics {
  lines: LyricLine[];
  synced: boolean;
  source: "lrc-file" | "lrclib" | "none";
  instrumental: boolean;
}

const NONE: Lyrics = { lines: [], synced: false, source: "none", instrumental: false };

// Accepts [mm:ss], [mm:ss.xx] and the less common [mm:ss:xx].
const TIME_TAG = /\[(\d+):(\d+(?:[.:]\d+)?)\]/g;
const WORD_TAG = /<(\d+):(\d+(?:[.:]\d+)?)>/g;

function toSec(m: string, s: string): number {
  return Number(m) * 60 + Number(s.replace(":", "."));
}

// Words without enhanced-LRC timing are spread across the line weighted by length,
// which tracks sung pacing better than an even split.
function interpolateWords(text: string, start: number, end: number): LyricWord[] {
  const parts = text.split(/\s+/).filter(Boolean);
  if (!parts.length) return [];
  const span = Math.max(0.3, Math.min(end - start, 8) * 0.85);
  const total = parts.reduce((n, w) => n + w.length + 1, 0);
  let acc = 0;
  return parts.map((w) => {
    const word = { text: w, t: start + (acc / total) * span };
    acc += w.length + 1;
    return word;
  });
}

function finalize(raw: { t: number; text: string; words?: LyricWord[] }[], duration: number): LyricLine[] {
  raw.sort((a, b) => a.t - b.t);
  const lines: LyricLine[] = [];
  raw.forEach((r, i) => {
    const end = i + 1 < raw.length ? raw[i + 1].t : Math.max(r.t + 4, duration || r.t + 4);
    if (!r.text.trim()) return;
    lines.push({ t: r.t, end, text: r.text, words: r.words?.length ? r.words : interpolateWords(r.text, r.t, end) });
  });
  return lines;
}

export function parseLrc(src: string, duration: number): LyricLine[] {
  const raw: { t: number; text: string; words?: LyricWord[] }[] = [];
  let offset = 0;
  for (const line of src.split(/\r?\n/)) {
    const off = line.match(/^\[offset:\s*([+-]?\d+)\]/i);
    if (off) offset = Number(off[1]) / 1000;
    const stamps = [...line.matchAll(TIME_TAG)];
    if (!stamps.length) continue;
    const body = line.replace(TIME_TAG, "");
    const words: LyricWord[] = [];
    const wordTags = [...body.matchAll(WORD_TAG)];
    wordTags.forEach((m, i) => {
      const from = m.index! + m[0].length;
      const to = i + 1 < wordTags.length ? wordTags[i + 1].index! : body.length;
      const text = body.slice(from, to).trim();
      if (text) words.push({ text, t: toSec(m[1], m[2]) - offset });
    });
    const text = body.replace(WORD_TAG, "").replace(/\s+/g, " ").trim();
    for (const s of stamps) raw.push({ t: toSec(s[1], s[2]) - offset, text, words: words.length ? words : undefined });
  }
  return finalize(raw, duration);
}

function spreadPlain(text: string, duration: number): LyricLine[] {
  const rows = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (!rows.length || !duration) return [];
  const start = duration * 0.08;
  const step = (duration * 0.84) / rows.length;
  return finalize(rows.map((r, i) => ({ t: start + i * step, text: r })), duration);
}

interface LrclibRecord {
  syncedLyrics: string | null;
  plainLyrics: string | null;
  instrumental: boolean;
  duration: number;
}

// Lookup forms: the bare song title (no "(feat. …)" or soundtrack suffix) and the main artist.
const lookupTitle = (t: string) => t.replace(/\s*[([].*$/, "").replace(/\s+(feat\.?|ft\.?)\s.*$/i, "").trim();
const mainArtist = (a: string) => a.split(/\s*(?:,|&|\bx\b|\bfeat\.?|\bft\.?|\band\b)\s*/i)[0].trim();

async function getJson<T>(url: string): Promise<T | null> {
  try {
    const res = await fetch(url);
    return res.ok ? ((await res.json()) as T) : null;
  } catch (err) {
    console.warn("[lyrics] LRCLIB request failed", err);
    return null;
  }
}

async function fetchLrclib(track: Track): Promise<LrclibRecord | null> {
  const title = lookupTitle(track.title);
  if (!title) return null;
  const artist = mainArtist(track.artist);
  const exact = new URLSearchParams({ track_name: title, artist_name: artist });
  if (track.duration) exact.set("duration", String(Math.round(track.duration)));
  const hit = await getJson<LrclibRecord>(`https://lrclib.net/api/get?${exact}`);
  if (hit) return hit;
  // Prefer a synced hit whose length matches ours; a different cut of the song desyncs everything.
  const pickBest = (hits: LrclibRecord[] | null) => {
    const close = (hits ?? []).filter((h) => !track.duration || Math.abs(h.duration - track.duration) < 4);
    return close.find((h) => h.syncedLyrics) ?? close[0] ?? null;
  };
  const byFields = new URLSearchParams({ track_name: title });
  if (artist) byFields.set("artist_name", artist);
  return (
    pickBest(await getJson<LrclibRecord[]>(`https://lrclib.net/api/search?${byFields}`)) ??
    pickBest(await getJson<LrclibRecord[]>(`https://lrclib.net/api/search?${new URLSearchParams({ q: `${artist} ${title}`.trim() })}`))
  );
}

export async function loadLyrics(track: Track): Promise<Lyrics> {
  if (track.lrcFile) {
    const lines = parseLrc(await track.lrcFile.text(), track.duration);
    if (lines.length) return { lines, synced: true, source: "lrc-file", instrumental: false };
  }
  const rec = await fetchLrclib(track);
  if (!rec) return NONE;
  if (rec.instrumental) return { ...NONE, source: "lrclib", instrumental: true };
  if (rec.syncedLyrics) {
    const lines = parseLrc(rec.syncedLyrics, track.duration);
    if (lines.length) return { lines, synced: true, source: "lrclib", instrumental: false };
  }
  if (rec.plainLyrics) {
    const lines = spreadPlain(rec.plainLyrics, track.duration);
    if (lines.length) return { lines, synced: false, source: "lrclib", instrumental: false };
  }
  return NONE;
}

export function lyricsHash(lyrics: Lyrics): string {
  let h = 2166136261;
  for (const l of lyrics.lines) {
    const s = `${l.t.toFixed(2)}|${l.text}\n`;
    for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  }
  return (h >>> 0).toString(36);
}
