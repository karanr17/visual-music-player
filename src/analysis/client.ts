import { dbGet, dbPut } from "../db";
import type { Track } from "../library/library";
import { SongAnalysis } from "./schema";

export type AnalysisOrigin = "cache" | "server" | "sidecar" | "bundled";

export interface LoadedAnalysis {
  analysis: SongAnalysis;
  origin: AnalysisOrigin;
  sha256: string;
}

export const DEFAULT_ANALYSIS_URL = "http://127.0.0.1:8765";

const HEALTH_TIMEOUT_MS = 1500;
// Generous: the first request after `mc serve` starts may queue behind another song's analysis.
const ANALYZE_TIMEOUT_MS = 3 * 60_000;
// A sidecar for a different encode of the same song is still usable if the lengths agree.
const DURATION_TOLERANCE_S = 2;

export async function sha256Hex(file: Blob): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function parse(data: unknown, from: string): SongAnalysis | null {
  const r = SongAnalysis.safeParse(data);
  if (r.success) return r.data;
  console.warn(`[analysis] ${from} is not a SongAnalysis v1`, r.error.issues.slice(0, 3));
  return null;
}

function withTimeout(ms: number, outer?: AbortSignal): AbortSignal {
  const t = AbortSignal.timeout(ms);
  return outer ? AbortSignal.any([outer, t]) : t;
}

// Sidecars dropped without a matching audio file name (the published examples are named after
// the song, not the download) wait here and are matched by hash or by the file name they record.
const looseSidecars = new Set<File>();

export function addLooseSidecars(files: File[]): void {
  for (const f of files) looseSidecars.add(f);
}

function matches(a: SongAnalysis, sha: string, track: Track, strict: boolean): boolean {
  if (a.source.sha256 === sha) return true;
  if (strict && a.source.fileName !== track.file.name) return false;
  return !track.duration || Math.abs(a.source.durationS - track.duration) <= DURATION_TOLERANCE_S;
}

async function fromSidecar(track: Track, sha: string): Promise<SongAnalysis | null> {
  if (track.analysisFile) {
    try {
      const a = parse(JSON.parse(await track.analysisFile.text()), track.analysisFile.name);
      if (a && matches(a, sha, track, false)) return a;
      if (a) console.warn("[analysis] sidecar is for a different recording", track.analysisFile.name);
    } catch (err) {
      console.warn("[analysis] couldn't read sidecar", track.analysisFile.name, err);
    }
  }
  for (const f of looseSidecars) {
    try {
      const a = parse(JSON.parse(await f.text()), f.name);
      if (a && matches(a, sha, track, true)) return a;
    } catch {
      // Not JSON; ignore it like any other unrelated file.
    }
  }
  return null;
}

// Analyses shipped with the static build (public/analysis/) for the CC BY demo songs.
async function fromBundle(sha: string, signal?: AbortSignal): Promise<SongAnalysis | null> {
  const base = import.meta.env.BASE_URL;
  try {
    const res = await fetch(`${base}analysis/index.json`, { signal });
    if (!res.ok) return null;
    const index = (await res.json()) as Record<string, string>;
    const name = index[sha];
    if (!name) return null;
    const file = await fetch(`${base}analysis/${name}`, { signal });
    return file.ok ? parse(await file.json(), name) : null;
  } catch {
    return null;
  }
}

async function fromServer(url: string, track: Track, signal?: AbortSignal): Promise<SongAnalysis | null> {
  const base = url.replace(/\/+$/, "");
  try {
    const health = await fetch(`${base}/health`, { signal: withTimeout(HEALTH_TIMEOUT_MS, signal) });
    if (!health.ok) return null;
  } catch {
    return null;
  }
  const res = await fetch(`${base}/analyze?${new URLSearchParams({ name: track.file.name })}`, {
    method: "POST",
    headers: { "content-type": "application/octet-stream" },
    body: track.file,
    signal: withTimeout(ANALYZE_TIMEOUT_MS, signal),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`mc serve ${res.status}: ${detail.slice(0, 200)}`);
  }
  return parse(await res.json(), `${base}/analyze`);
}

export interface AnalysisOptions {
  // Base URL of `mc serve`; empty skips the server.
  serverUrl: string;
  signal?: AbortSignal;
  onServerStart?: () => void;
}

// Cache first, then mc serve, then a sidecar file, then the bundled demo analyses. Never throws:
// without analysis the player still works, it just doesn't know the music's structure.
export async function loadAnalysis(track: Track, opts: AnalysisOptions): Promise<LoadedAnalysis | null> {
  let sha: string;
  try {
    sha = await sha256Hex(track.file);
  } catch (err) {
    console.warn("[analysis] couldn't hash", track.file.name, err);
    return null;
  }
  const cached = await dbGet<unknown>("analysis", sha);
  const fromCache = cached ? parse(cached, "cache") : null;
  if (fromCache) return { analysis: fromCache, origin: "cache", sha256: sha };

  const found = async (): Promise<[SongAnalysis, AnalysisOrigin] | null> => {
    if (opts.serverUrl) {
      try {
        opts.onServerStart?.();
        const a = await fromServer(opts.serverUrl, track, opts.signal);
        if (a) return [a, "server"];
      } catch (err) {
        if (opts.signal?.aborted) throw err;
        console.warn("[analysis] mc serve failed; trying sidecar files", err);
      }
    }
    const side = await fromSidecar(track, sha);
    if (side) return [side, "sidecar"];
    const bundled = await fromBundle(sha, opts.signal);
    return bundled ? [bundled, "bundled"] : null;
  };

  try {
    const r = await found();
    if (!r) return null;
    await dbPut("analysis", sha, r[0]);
    return { analysis: r[0], origin: r[1], sha256: sha };
  } catch (err) {
    console.warn("[analysis] unavailable", err);
    return null;
  }
}
