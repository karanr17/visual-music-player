import { loadAnalysis, type LoadedAnalysis } from "../analysis/client";
import { computeEnvelope, type Envelope } from "../audio/envelope";
import type { Track } from "../library/library";
import { loadLyrics, lyricsHash, type Lyrics } from "../lyrics/lyrics";
import { currentReference, referenceImagePart } from "../reference";
import { getSettings } from "../settings";
import { ambientScript } from "./compile";
import { NoProviderError, providerCaller } from "./interpret";
import { compileResult, runPipeline } from "./pipeline";
import type { SceneScript } from "./schema";
import { bundledScript, getPrefs, getScript, recordUnmapped, saveScript, saveSprites, spriteLibrary, trackKey, type SongPrefs } from "./store";

// API errors stringify as "400 {json…}"; the nested message is the part worth showing.
function readableError(err: unknown): string {
  const nested = (err as { error?: { error?: { message?: string } } })?.error?.error?.message;
  if (nested) return nested;
  return err instanceof Error ? err.message : String(err);
}

// Recent generation events, kept in localStorage so they can be inspected from another tab.
function logEvent(msg: string): void {
  try {
    const log: string[] = JSON.parse(localStorage.getItem("vmp.log") ?? "[]");
    log.push(`${new Date().toLocaleTimeString()} ${msg}`);
    localStorage.setItem("vmp.log", JSON.stringify(log.slice(-40)));
  } catch {
    // Diagnostics only.
  }
}

export type SceneStatus = "loading" | "analysing" | "ambient" | "queued" | "generating" | "ready" | "error";

export interface Prepared {
  track: Track;
  key: string;
  baseKey: string;
  model: string;
  scriptKey: string;
  lyrics: Lyrics;
  envelope: Envelope | null;
  analysis: LoadedAnalysis | null;
  prefs: SongPrefs;
  script: SceneScript;
  status: SceneStatus;
  error?: string;
}

// Which generator a cached script belongs to, so each model's take on a song is kept apart.
function generatorId(): string {
  const s = getSettings();
  const single = s.provider === "ollama" ? `ollama:${s.ollamaModel}` : s.model;
  const director = s.provider === "ollama" ? s.ollamaDirectorModel || s.ollamaModel : s.directorModel;
  const base = s.twoPass ? `${single}+dir:${director}` : single;
  const ref = seesReference() ? currentReference() : null;
  return ref ? `${base}+ref:${ref.id}` : base;
}

// Scripts written with and without audio analysis are cached apart, so analysis arriving later
// (mc serve started, a sidecar dropped) gets a fresh script instead of the old one.
function scriptKeyFor(baseKey: string, model: string, analysis: LoadedAnalysis | null): string {
  return `${baseKey}#${model}${analysis ? `#audio:${analysis.sha256.slice(0, 12)}` : ""}`;
}

// Scenes are written with the reference artwork in view only in the reference look, by choice.
function seesReference(): boolean {
  const s = getSettings();
  return s.styleOverride === "reference" && s.referenceForScenes && !!currentReference() && s.provider !== "ollama";
}

// Loads everything a track needs and runs scene generation one song at a time,
// so a playlist never fans out into parallel paid API calls.
export class SceneService extends EventTarget {
  private prepared = new Map<string, Promise<Prepared>>();
  private queue: { track: Track; force: boolean }[] = [];
  private running: { id: string; abort: AbortController } | null = null;
  private statuses = new Map<string, SceneStatus>();

  statusOf(trackId: string): SceneStatus | undefined {
    return this.statuses.get(trackId);
  }

  private emit(p: Prepared): void {
    this.statuses.set(p.track.id, p.status);
    logEvent(`${p.track.title || p.track.file.name}: ${p.status}${p.error ? ` (${p.error})` : ""}`);
    this.dispatchEvent(new CustomEvent<Prepared>("update", { detail: p }));
  }

  prepare(track: Track): Promise<Prepared> {
    let p = this.prepared.get(track.id);
    if (!p) {
      this.statuses.set(track.id, "loading");
      p = this.load(track).then((r) => {
        this.statuses.set(track.id, r.status);
        return r;
      });
      this.prepared.set(track.id, p);
    }
    return p;
  }

  private async load(track: Track): Promise<Prepared> {
    const key = trackKey(track);
    const analysisP = !getSettings().useAnalysis ? Promise.resolve(null) : loadAnalysis(track, {
      serverUrl: getSettings().analysisUrl.trim(),
      onServerStart: () => {
        this.statuses.set(track.id, "analysing");
        this.dispatchEvent(new CustomEvent<string>("analysing", { detail: track.id }));
      },
    });
    const [lyrics, envelope, prefs, analysis] = await Promise.all([loadLyrics(track), computeEnvelope(track.file), getPrefs(key), analysisP]);
    if (analysis) logEvent(`${track.title || track.file.name}: analysis from ${analysis.origin}`);
    const baseKey = `${key}#${lyricsHash(lyrics)}`;
    const model = generatorId();
    const scriptKey = scriptKeyFor(baseKey, model, analysis);
    const cached = (await getScript(scriptKey)) ?? (analysis ? await bundledScript(analysis.sha256, key) : null);
    return {
      track,
      key,
      baseKey,
      model,
      scriptKey,
      lyrics,
      envelope,
      analysis,
      prefs,
      script: cached ?? ambientScript(track, envelope, key),
      status: cached ? "ready" : "ambient",
    };
  }

  // Current track goes to the front; prefetches go to the back.
  async request(track: Track, opts: { front?: boolean; force?: boolean } = {}): Promise<void> {
    const p = await this.prepare(track);
    if (!opts.force && (p.status === "ready" || p.status === "generating" || p.status === "queued")) {
      if (opts.front && p.status === "queued") this.bump(track.id);
      return;
    }
    if (getSettings().provider === "off") return;
    this.queue = this.queue.filter((q) => q.track.id !== track.id);
    const item = { track, force: !!opts.force };
    if (opts.front) this.queue.unshift(item);
    else this.queue.push(item);
    p.status = "queued";
    this.emit(p);
    void this.pump();
  }

  private bump(id: string): void {
    const i = this.queue.findIndex((q) => q.track.id === id);
    if (i > 0) this.queue.unshift(...this.queue.splice(i, 1));
  }

  private async pump(): Promise<void> {
    if (this.running) return;
    const next = this.queue.shift();
    if (!next) return;
    const p = await this.prepare(next.track);
    const abort = new AbortController();
    const model = p.model;
    const scriptKey = p.scriptKey;
    this.running = { id: next.track.id, abort };
    p.status = "generating";
    p.error = undefined;
    this.emit(p);
    try {
      const settings = getSettings();
      const library = await spriteLibrary();
      const image = model.includes("+ref:") ? referenceImagePart() : null;
      const result = await runPipeline(
        {
          track: p.track,
          lyrics: p.lyrics,
          analysis: p.analysis?.analysis ?? null,
          envelope: p.envelope,
          userDirection: p.prefs.scenePrompt,
          librarySprites: [...library.keys()],
          image,
        },
        settings,
        providerCaller(settings),
        abort.signal,
      );
      const { output, provider, notes } = result;
      if (result.directorError) logEvent(`${p.track.title || p.track.file.name}: director failed (${result.directorError}); single pass used`);
      // Scripts embed every sprite they use, so an exported script renders on its own.
      const used = new Set(output.sections.flatMap((s) => s.moments.flatMap((m) => m.subjects.map((x) => x.custom).filter(Boolean))));
      const drawn = new Set(output.sprites.map((s) => s.name));
      const sprites = [...output.sprites.filter((s) => used.has(s.name)), ...[...used].filter((n) => !drawn.has(n)).flatMap((n) => library.get(n) ?? [])];
      await saveSprites(output.sprites);
      const script = {
        ...compileResult(result, p.track.duration, p.key),
        model: provider === "ollama" ? settings.ollamaModel : settings.model,
        sprites,
        ...(notes
          ? { direction: { logline: notes.logline, arc: notes.arc, model: provider === "ollama" ? settings.ollamaDirectorModel || settings.ollamaModel : settings.directorModel } }
          : {}),
      };
      await saveScript(scriptKey, script);
      await recordUnmapped(script.unmapped);
      // The model may have been switched while this ran; then it only fills the cache.
      if (p.model === model) {
        p.script = script;
        p.status = "ready";
      }
    } catch (err) {
      if (abort.signal.aborted) return;
      if (err instanceof NoProviderError) {
        p.status = "ambient";
        p.error = err.message;
        return;
      }
      p.status = "error";
      p.error = readableError(err);
      console.error("[scenes] generation failed", p.track.title, err);
    } finally {
      this.running = null;
      this.emit(p);
      void this.pump();
    }
  }

  // Shows the new generator's (model, or model + reference artwork) cached take on this song, or generates one. The current scenes
  // stay on screen until the new ones arrive, which makes side-by-side comparison easy.
  async switchModel(track: Track): Promise<void> {
    const p = await this.prepare(track);
    p.model = generatorId();
    p.scriptKey = scriptKeyFor(p.baseKey, p.model, p.analysis);
    if (this.running?.id === track.id) this.running.abort.abort();
    const cached = await getScript(p.scriptKey);
    if (cached) {
      this.queue = this.queue.filter((q) => q.track.id !== track.id);
      p.script = cached;
      p.status = "ready";
      p.error = undefined;
      this.emit(p);
      return;
    }
    await this.request(track, { front: true, force: true });
  }

  async replaceScript(track: Track, script: SceneScript): Promise<void> {
    const p = await this.prepare(track);
    p.script = script;
    p.status = "ready";
    await saveScript(p.scriptKey, script);
    this.emit(p);
  }

  async updatePrefs(track: Track, prefs: SongPrefs): Promise<void> {
    const p = await this.prepare(track);
    p.prefs = prefs;
    this.emit(p);
  }
}
