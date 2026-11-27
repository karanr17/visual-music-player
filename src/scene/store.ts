import { dbEntries, dbGet, dbPut } from "../db";
import type { Track } from "../library/library";
import { SceneScript, type SpriteSpec } from "./schema";

export interface SongPrefs {
  lyricOffset: number;
  scenePrompt: string;
}

export function trackKey(track: Track): string {
  return `${track.artist}|${track.title}|${Math.round(track.duration)}`.toLowerCase();
}

export const getScript = (scriptKey: string) => dbGet<SceneScript>("scripts", scriptKey);

// Scene scripts shipped with the static build (public/scripts/) for the demo songs, by the audio's
// SHA-256, so the hosted demo needs no LLM. The script takes the track's own key, which is what
// its plates and cache are matched by.
export async function bundledScript(sha256: string, key: string): Promise<SceneScript | null> {
  const base = import.meta.env.BASE_URL;
  try {
    const index = await fetch(`${base}scripts/index.json`);
    if (!index.ok) return null;
    const name = ((await index.json()) as Record<string, string>)[sha256];
    if (!name) return null;
    const res = await fetch(`${base}scripts/${name}`);
    const parsed = res.ok ? SceneScript.safeParse(await res.json()) : null;
    return parsed?.success ? { ...parsed.data, trackKey: key } : null;
  } catch {
    return null;
  }
}
export const saveScript = (scriptKey: string, s: SceneScript) => dbPut("scripts", scriptKey, s);

export async function getPrefs(key: string): Promise<SongPrefs> {
  return { lyricOffset: 0, scenePrompt: "", ...(await dbGet<Partial<SongPrefs>>("songPrefs", key)) };
}

export async function savePrefs(key: string, patch: Partial<SongPrefs>): Promise<SongPrefs> {
  const next = { ...(await getPrefs(key)), ...patch };
  await dbPut("songPrefs", key, next);
  return next;
}

export async function recordUnmapped(concepts: string[]): Promise<void> {
  for (const c of concepts) await dbPut("unmapped", c, ((await dbGet<number>("unmapped", c)) ?? 0) + 1);
}

export async function unmappedCounts(): Promise<[string, number][]> {
  return (await dbEntries<number>("unmapped")).sort((a, b) => b[1] - a[1]);
}

interface ExportFile {
  app: "visual-music-player";
  version: 1;
  scripts: Record<string, SceneScript>;
  songPrefs: Record<string, SongPrefs>;
}

export async function exportAll(): Promise<Blob> {
  const data: ExportFile = {
    app: "visual-music-player",
    version: 1,
    scripts: Object.fromEntries(await dbEntries<SceneScript>("scripts")),
    songPrefs: Object.fromEntries(await dbEntries<SongPrefs>("songPrefs")),
  };
  return new Blob([JSON.stringify(data, null, 1)], { type: "application/json" });
}

export async function importAll(file: File): Promise<{ scripts: number; skipped: number }> {
  const data = JSON.parse(await file.text()) as Partial<ExportFile>;
  if (data.app !== "visual-music-player") throw new Error("Not a Visual Music Player export");
  let scripts = 0;
  let skipped = 0;
  for (const [k, v] of Object.entries(data.scripts ?? {})) {
    const parsed = SceneScript.safeParse(v);
    if (parsed.success) {
      await dbPut("scripts", k, parsed.data);
      scripts++;
    } else skipped++;
  }
  for (const [k, v] of Object.entries(data.songPrefs ?? {})) await dbPut("songPrefs", k, v);
  return { scripts, skipped };
}

// Sprites the model drew, shared across songs so a "sunflower" is drawn once and reused.
export async function saveSprites(sprites: SpriteSpec[]): Promise<void> {
  for (const s of sprites) await dbPut("sprites", s.name, s);
}

export async function spriteLibrary(): Promise<Map<string, SpriteSpec>> {
  return new Map(await dbEntries<SpriteSpec>("sprites"));
}
