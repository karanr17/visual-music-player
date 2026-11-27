import { tracksFromFiles, type Track } from "./library/library";

// The hosted demo's three CC BY 3.0 songs. The audio is fetched from ccMixter when the site is
// built (scripts/fetch-demo-audio.sh) and never committed; their analyses, scene scripts and
// plates are bundled in public/, so they play with no server and no LLM.

export const CC_BY = "https://creativecommons.org/licenses/by/3.0/";

export interface DemoSong {
  slug: string;
  title: string;
  credit: string;
  page: string;
}

export async function demoSongs(): Promise<DemoSong[]> {
  const res = await fetch(`${import.meta.env.BASE_URL}demo/songs.json`);
  if (!res.ok) throw new Error("No demo songs in this build");
  return res.json();
}

async function file(url: string, name: string, type: string): Promise<File> {
  const res = await fetch(url);
  // Vite's dev server answers a missing file with index.html, so check the type too.
  if (!res.ok || (res.headers.get("content-type") ?? "").includes("text/html")) throw new Error(`${name} is missing`);
  return new File([await res.blob()], name, { type });
}

// One song's audio and lyrics as a Track, credited for the player bar.
export async function demoTrack(song: DemoSong): Promise<Track> {
  const base = import.meta.env.BASE_URL;
  const [audio, lrc] = await Promise.all([
    file(`${base}audio/${song.slug}.mp3`, `${song.slug}.mp3`, "audio/mpeg"),
    file(`${base}demo/${song.slug}.lrc`, `${song.slug}.lrc`, "text/plain"),
  ]);
  const [track] = await tracksFromFiles([audio, lrc]);
  return { ...track, credit: { text: song.credit, url: song.page } };
}
