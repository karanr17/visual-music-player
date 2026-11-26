import { computeEnvelope, type Envelope } from "../audio/envelope";
import type { Track } from "../library/library";
import { loadLyrics, lyricsHash, type Lyrics } from "../lyrics/lyrics";
import { currentReference, referenceImagePart } from "../reference";
import { getSettings } from "../settings";
import { ambientScript, compile, pseudoLines } from "./compile";
import { interpret, NoProviderError } from "./interpret";
import { buildUserPrompt } from "./prompt";
import type { SceneScript } from "./schema";
import { getPrefs, getScript, recordUnmapped, saveScript, saveSprites, spriteLibrary, trackKey, type SongPrefs } from "./store";

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

export type SceneStatus = "loading" | "ambient" | "queued" | "generating" | "ready" | "error";

export interface Prepared {
  track: Track;
  key: string;
  baseKey: string;
  model: string;
  scriptKey: string;
  lyrics: Lyrics;
  envelope: Envelope | null;
  prefs: SongPrefs;
  script: SceneScript;
  status: SceneStatus;
  error?: string;
}

// Which generator a cached script belongs to, so each model's take on a song is kept apart.
function generatorId(): string {
  const s = getSettings();
  const base = s.provider === "ollama" ? `ollama:${s.ollamaModel}` : s.model;
  const ref = seesReference() ? currentReference() : null;
  return ref ? `${base}+ref:${ref.id}` : base;
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
    const [lyrics, envelope, prefs] = await Promise.all([loadLyrics(track), computeEnvelope(track.file), getPrefs(key)]);
    const baseKey = `${key}#${lyricsHash(lyrics)}`;
    const model = generatorId();
    const scriptKey = `${baseKey}#${model}`;
    const cached = await getScript(scriptKey);
    return {
      track,
      key,
      baseKey,
      model,
      scriptKey,
      lyrics,
      envelope,
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
      const hasLyrics = p.lyrics.lines.length > 0;
      const pseudo = hasLyrics ? null : pseudoLines(p.envelope, p.track.duration);
      const lineTimes = hasLyrics ? p.lyrics.lines.map((l) => l.t) : pseudo!.map((l) => l.t);
      const library = await spriteLibrary();
      const image = model.includes("+ref:") ? referenceImagePart() : null;
      const prompt = buildUserPrompt(p.track, p.lyrics, pseudo, p.prefs.scenePrompt, [...library.keys()], !!image);
      const { output, provider } = await interpret(settings, prompt, abort.signal, [...library.keys()], image);
      // Scripts embed every sprite they use, so an exported script renders on its own.
      const used = new Set(output.sections.flatMap((s) => s.moments.flatMap((m) => m.subjects.map((x) => x.custom).filter(Boolean))));
      const drawn = new Set(output.sprites.map((s) => s.name));
      const sprites = [...output.sprites.filter((s) => used.has(s.name)), ...[...used].filter((n) => !drawn.has(n)).flatMap((n) => library.get(n) ?? [])];
      await saveSprites(output.sprites);
      const script = {
        ...compile(output, lineTimes, p.track.duration, p.key, provider),
        model: provider === "ollama" ? settings.ollamaModel : settings.model,
        sprites,
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
    p.scriptKey = `${p.baseKey}#${p.model}`;
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
