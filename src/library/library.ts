import { parseBlob } from "music-metadata";
import { addLooseSidecars } from "../analysis/client";
import { addPlateFiles, PLATES_EXT } from "../plates/client";
import { dbGet, dbPut } from "../db";

export interface Track {
  id: string;
  file: File;
  lrcFile?: File;
  analysisFile?: File;
  title: string;
  artist: string;
  album: string;
  duration: number;
}

const AUDIO_EXT = /\.(mp3|m4a|aac|flac|wav|ogg|opus|webm)$/i;
const LRC_EXT = /\.lrc$/i;
const ANALYSIS_EXT = /\.analysis\.json$/i;

function baseName(name: string): string {
  return name.replace(ANALYSIS_EXT, "").replace(/\.[^.]+$/, "").toLowerCase();
}

function probeDuration(file: File): Promise<number> {
  return new Promise((resolve) => {
    const a = new Audio();
    const url = URL.createObjectURL(file);
    const done = (d: number) => {
      URL.revokeObjectURL(url);
      resolve(Number.isFinite(d) ? d : 0);
    };
    a.preload = "metadata";
    a.onloadedmetadata = () => done(a.duration);
    a.onerror = () => done(0);
    a.src = url;
  });
}

const NOISE = /\b(official|music|lyrics?|lyric|audio|video|visuali[sz]er|hd|hq|4k|mp3|128k|320k|remaster(ed)?|explicit|clean)\b/gi;

// Downloads from YouTube and friends arrive with "Artist - Title (Official Video)(MP3_128K)"
// names, channel artists like "PostMaloneVEVO", and ":" or "," mangled into "_".
export function cleanTitle(raw: string): string {
  return raw
    .replace(/_\s/g, ": ")
    .replace(/\s*[([](?:[^)\]]*\b(?:official|video|audio|lyrics?|mp3|\d+k|visuali[sz]er|hd|remaster)[^)\]]*)[)\]]/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}

function guessFromName(name: string): { artist: string; title: string } {
  const stem = cleanTitle(name.replace(/\.[^.]+$/, "").replace(/^\d+[\s._-]+/, ""));
  const m = stem.match(/^(.+?)\s+-\s+(.+)$/);
  return m ? { artist: m[1].replace(/:\s/g, ", ").trim(), title: m[2].trim() } : { artist: "", title: stem };
}

const isChannelArtist = (a: string) => /vevo$|\s-\stopic$|official$/i.test(a.trim()) || !a.trim();

async function toTrack(file: File): Promise<Track> {
  const guess = guessFromName(file.name);
  let title = guess.title;
  let artist = guess.artist;
  let album = "";
  let duration = 0;
  try {
    const meta = await parseBlob(file, { duration: false, skipCovers: true });
    title = meta.common.title || title;
    artist = meta.common.artist || meta.common.albumartist || artist;
    album = meta.common.album || "";
    duration = meta.format.duration ?? 0;
  } catch (err) {
    console.warn("[library] metadata parse failed", file.name, err);
  }
  // A title that embeds "Artist - Song" with a channel name as artist is a rip; trust the title.
  title = cleanTitle(title);
  const split = title.match(/^(.+?)\s+-\s+(.+)$/);
  const sharesArtist = split && [...words(split[1])].some((w) => words(artist).has(w));
  if (split && (isChannelArtist(artist) || sharesArtist)) {
    artist = split[1].replace(/:\s/g, ", ").trim();
    title = split[2].trim();
  } else if (isChannelArtist(artist) && guess.artist) {
    artist = guess.artist;
  }
  if (!duration) duration = await probeDuration(file);
  return { id: `${file.name}:${file.size}:${file.lastModified}`, file, title, artist, album, duration };
}

// --- Pairing lyrics files with audio files ---

const words = (s: string) =>
  new Set(
    s
      .toLowerCase()
      .replace(NOISE, " ")
      .replace(/\.[a-z0-9]+$/, "")
      .split(/[^\p{L}\p{N}]+/u)
      .filter((w) => w.length > 1),
  );

interface LrcInfo {
  file: File;
  title: string;
  artist: string;
  length: number;
}

async function lrcInfo(file: File): Promise<LrcInfo> {
  const head = (await file.slice(0, 2048).text()).split(/\r?\n/);
  const tag = (k: string) => head.map((l) => l.match(new RegExp(`^\\[${k}:\\s*(.*?)\\]`, "i"))?.[1]).find(Boolean) ?? "";
  const len = tag("length").match(/(\d+):(\d+)/);
  return { file, title: tag("ti"), artist: tag("ar"), length: len ? Number(len[1]) * 60 + Number(len[2]) : 0 };
}

// Exact base-name match first; otherwise the lyric file's own title must appear in the
// track (title, artist and file name), with artist overlap and length as tie-breakers.
function score(track: Track, lrc: LrcInfo): number {
  if (baseName(track.file.name) === baseName(lrc.file.name)) return 1000;
  const trackWords = new Set([...words(track.title), ...words(track.artist), ...words(track.file.name)]);
  const titleWords = [...words(lrc.title || guessFromName(lrc.file.name).title)];
  if (!titleWords.length || !titleWords.every((w) => trackWords.has(w))) return 0;
  const artistWords = [...words(lrc.artist || guessFromName(lrc.file.name).artist)];
  let s = 10 + titleWords.length * 3 + artistWords.filter((w) => trackWords.has(w)).length * 2;
  if (lrc.length && track.duration) s -= Math.min(8, Math.abs(lrc.length - track.duration));
  return s;
}

export async function tracksFromFiles(files: File[]): Promise<Track[]> {
  const audio = files.filter((f) => AUDIO_EXT.test(f.name)).sort((a, b) => a.name.localeCompare(b.name));
  const [tracks, lrcs] = await Promise.all([
    Promise.all(audio.map(toTrack)),
    Promise.all(files.filter((f) => LRC_EXT.test(f.name)).map(lrcInfo)),
  ]);
  const pairs = tracks
    .flatMap((t) => lrcs.map((l) => ({ t, l, s: score(t, l) })))
    .filter((p) => p.s > 0)
    .sort((a, b) => b.s - a.s);
  const used = new Set<LrcInfo>();
  for (const { t, l } of pairs) {
    if (t.lrcFile || used.has(l)) continue;
    t.lrcFile = l.file;
    used.add(l);
  }
  // One song and one lyric file dropped together belong together, whatever they're named.
  if (tracks.length === 1 && lrcs.length === 1 && !tracks[0].lrcFile) tracks[0].lrcFile = lrcs[0].file;
  const sidecars = files.filter((f) => ANALYSIS_EXT.test(f.name));
  const loose = new Set(sidecars);
  for (const t of tracks) {
    const s = sidecars.find((f) => baseName(f.name) === baseName(t.file.name));
    if (s) {
      t.analysisFile = s;
      loose.delete(s);
    }
  }
  if (tracks.length === 1 && sidecars.length === 1 && !tracks[0].analysisFile) {
    tracks[0].analysisFile = sidecars[0];
    loose.delete(sidecars[0]);
  }
  addLooseSidecars([...loose]);
  await addPlateFiles(files);
  return tracks;
}

// --- Remembered folder (File System Access API, Chromium only) ---

interface DirHandle extends FileSystemDirectoryHandle {
  queryPermission(opts: { mode: "read" }): Promise<PermissionState>;
  requestPermission(opts: { mode: "read" }): Promise<PermissionState>;
}

declare global {
  interface Window {
    showDirectoryPicker?: (opts?: { id?: string; mode?: "read" }) => Promise<DirHandle>;
  }
}

export const folderSupported = typeof window !== "undefined" && "showDirectoryPicker" in window;

async function collectFiles(dir: DirHandle, out: File[], depth = 0): Promise<void> {
  if (depth > 6) return;
  for await (const entry of dir.values()) {
    if (entry.kind === "file") {
      if (AUDIO_EXT.test(entry.name) || LRC_EXT.test(entry.name) || ANALYSIS_EXT.test(entry.name) || PLATES_EXT.test(entry.name)) {
        out.push(await (entry as FileSystemFileHandle).getFile());
      }
    } else {
      await collectFiles(entry as DirHandle, out, depth + 1);
    }
  }
}

export async function pickFolder(): Promise<Track[]> {
  if (!window.showDirectoryPicker) throw new Error("Folder access needs a Chromium browser");
  const dir = await window.showDirectoryPicker({ id: "music", mode: "read" });
  await dbPut("kv", "folder", dir);
  const files: File[] = [];
  await collectFiles(dir, files);
  return tracksFromFiles(files);
}

export async function rememberedFolderName(): Promise<string | null> {
  const dir = await dbGet<DirHandle>("kv", "folder");
  return dir?.name ?? null;
}

// Must run inside a user gesture: re-granting read permission shows a browser prompt.
export async function reopenFolder(): Promise<Track[] | null> {
  const dir = await dbGet<DirHandle>("kv", "folder");
  if (!dir) return null;
  let perm = await dir.queryPermission({ mode: "read" });
  if (perm !== "granted") perm = await dir.requestPermission({ mode: "read" });
  if (perm !== "granted") return null;
  const files: File[] = [];
  await collectFiles(dir, files);
  return tracksFromFiles(files);
}
