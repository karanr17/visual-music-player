import { Clock } from "./audio/clock";
import { Rhythm, type Reactivity } from "./audio/rhythm";
import { energyAt, energyIntegral, onsetAt } from "./audio/envelope";
import { folderSupported, pickFolder, rememberedFolderName, reopenFolder, tracksFromFiles, type Track } from "./library/library";
import { Captions } from "./render/captions";
import { loadCharacters } from "./render/characters";
import { demoContent } from "./demo";
import { Director } from "./render/director";
import { PH, PW } from "./render/fb";
import { ambientScript } from "./scene/compile";
import { SceneScript } from "./scene/schema";
import { claudeCodeAvailable } from "./scene/interpret";
import { SceneService, type Prepared, type SceneStatus } from "./scene/service";
import { exportAll, importAll, savePrefs, unmappedCounts } from "./scene/store";
import { STYLES } from "./scene/vocab";
import { currentReference, loadReference, setReferenceImage } from "./reference";
import { CLAUDE_MODELS, getSettings, LOOK_LABELS, modelLabel, onSettings, updateSettings, type Provider, type Settings } from "./settings";

// 60 fps when the machine keeps up; heavy scenes on slow machines fall back to 30.
const FAST_MS = 1000 / 60;
const DEMO_BPM = 96;
const SLOW_MS = 1000 / 30;

const STATUS_TEXT: Record<SceneStatus, string> = {
  loading: "Loading…",
  analysing: "Analysing audio with mc serve…",
  ambient: "Ambient scene",
  queued: "Queued for scenes",
  generating: "Imagining scenes…",
  ready: "",
  error: "Scene generation failed",
};

const fmt = (t: number) => (Number.isFinite(t) ? `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, "0")}` : "0:00");

function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, html = ""): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  if (html) e.innerHTML = html;
  return e;
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

export class App {
  private audio = new Audio();
  private clock = new Clock(this.audio);
  private scenes = new SceneService();
  private captions = new Captions();
  private director: Director;
  private sceneCanvas = el("canvas", { width: String(PW), height: String(PH), class: "scene" });
  private sceneCtx = this.sceneCanvas.getContext("2d")!;
  private imageData = new ImageData(PW, PH);
  private tracks: Track[] = [];
  private index = -1;
  private current: Prepared | null = null;
  private pendingPlay: string | null = null;
  private objectUrl = "";
  private lastFrame = 0;
  private renderMs = 0;
  private idleTimer = 0;
  private ui!: Record<string, HTMLElement>;
  private demo: (ReturnType<typeof demoContent> & { t0: number; startT: number; freeze: boolean }) | null = null;

  constructor(private root: HTMLElement) {
    const idleTrack: Track = { id: "idle", file: new File([], "idle"), title: "idle", artist: "", album: "", duration: 600 };
    this.director = new Director(ambientScript(idleTrack, null, "idle"), "natural");
    this.audio.preload = "auto";
    this.buildUi();
    this.bindEvents();
    this.director.setEnergyIntegral(this.energySum);
    this.startDemoFromUrl();
    // Figures are drawn from the character atlas, so the first frame waits for it.
    loadCharacters()
      .catch((err) => console.error("[player] character sprites failed to load", err))
      .finally(() => requestAnimationFrame(this.tick));
  }

  // Must agree with the energy each frame passes to the director (see render).
  private energySum = (t: number): number => {
    if (this.demo && !this.tracks.length) return 0.45 * t + (0.25 / 1.7) * (1 - Math.cos(t * 1.7));
    return energyIntegral(this.current?.envelope ?? null, t - (this.current?.prefs.lyricOffset ?? 0));
  };

  // ---------- Playback ----------

  private async addTracks(list: Track[], replace = false): Promise<void> {
    if (!list.length) return;
    const wasEmpty = !this.tracks.length || replace;
    this.tracks = replace ? list : [...this.tracks, ...list];
    this.renderPlaylist();
    if (wasEmpty) await this.play(0);
  }

  private async play(i: number): Promise<void> {
    if (i < 0 || i >= this.tracks.length) return;
    this.index = i;
    const track = this.tracks[i];
    if (this.objectUrl) URL.revokeObjectURL(this.objectUrl);
    this.objectUrl = URL.createObjectURL(track.file);
    this.audio.src = this.objectUrl;
    this.current = null;
    this.setStatus("loading");
    this.pendingPlay = null;
    this.renderNowPlaying();
    this.renderPlaylist();

    const prepared = await this.scenes.prepare(track);
    if (this.tracks[this.index]?.id !== track.id) return;
    this.current = prepared;
    // Scenes are written for the whole song, so by default hold playback until they exist.
    const s = getSettings();
    if (s.waitForScenes && s.provider !== "off" && prepared.status !== "ready") this.pendingPlay = track.id;
    else this.startAudio();
    // Request generation before touching the renderer, so a render problem can't block it.
    void this.scenes.request(track, { front: true });
    try {
      this.director.load(prepared.script, this.styleFor(prepared.script));
      this.applyRhythm();
      this.director.dissolveIn(800);
    } catch (err) {
      console.error("[player] couldn't load scene script", err);
    }
    this.renderNowPlaying();
    this.setStatus(prepared.status, prepared.error);
    // Prefetch only the next song: background generation spends plan usage.
    const n = this.tracks[i + 1];
    if (n) void this.scenes.request(n);
  }

  private switchModel(model: string): void {
    if (model === getSettings().model) return;
    updateSettings({ model });
    if (this.current) void this.scenes.switchModel(this.current.track);
  }

  private renderLookOptions(): void {
    const sel = this.ui.look as HTMLSelectElement;
    const ref = currentReference();
    sel.innerHTML = [
      `<option value="auto">Look: auto</option>`,
      ...STYLES.map((v) => `<option value="${v}">${LOOK_LABELS[v]}</option>`),
      ref ? `<option value="reference">My reference: ${esc(ref.name.slice(0, 24))}</option>` : "",
      `<option value="__pick">${ref ? "Change" : "Choose"} reference image…</option>`,
    ].join("");
    sel.value = getSettings().styleOverride === "reference" && !ref ? "auto" : getSettings().styleOverride;
  }

  // Looks are a render-time finish and switch instantly; only the reference look, when Claude
  // is allowed to see the artwork, changes which scene script applies.
  private setLook(look: Settings["styleOverride"]): void {
    const before = getSettings();
    updateSettings({ styleOverride: look });
    const scenesChange = before.referenceForScenes && (before.styleOverride === "reference") !== (look === "reference");
    if (scenesChange && this.current) void this.scenes.switchModel(this.current.track);
  }

  private async chooseReference(file: File): Promise<void> {
    const prevId = currentReference()?.id;
    try {
      await setReferenceImage(file);
    } catch (err) {
      this.toast(String((err as Error).message));
      return;
    }
    this.renderLookOptions();
    if (getSettings().styleOverride === "reference") {
      // Same look, new artwork: refresh the frame, and the scenes if Claude follows the reference.
      updateSettings({});
      if (getSettings().referenceForScenes && prevId !== currentReference()?.id && this.current) void this.scenes.switchModel(this.current.track);
    } else this.setLook("reference");
    this.toast(getSettings().referenceForScenes ? "Reference set. Claude will re-imagine this song's scenes in its spirit." : "Reference set.");
  }

  private startAudio(): void {
    this.pendingPlay = null;
    void this.audio.play().catch(() => this.toast("Press ▶ to start playback"));
  }

  private rhythms = new WeakMap<object, Rhythm>();

  // The demo reel has no recording to analyse, so it gets a plain grid at its notional tempo.
  private applyRhythm(): void {
    let r: Rhythm | null = null;
    const a = this.current?.analysis?.analysis;
    if (a) {
      r = this.rhythms.get(a) ?? new Rhythm(a);
      this.rhythms.set(a, r);
    } else if (this.demo && !this.tracks.length) {
      r = Rhythm.fromTempo(DEMO_BPM, this.demo.duration);
    }
    this.director.setRhythm(r, getSettings().reactivity);
  }

  private styleFor(script: SceneScript) {
    const o = getSettings().styleOverride;
    return o === "auto" ? script.style : o;
  }

  private onSceneUpdate = (e: Event) => {
    const p = (e as CustomEvent<Prepared>).detail;
    this.renderPlaylist();
    if (p.track.id !== this.tracks[this.index]?.id) return;
    const swapped = this.current?.script !== p.script;
    this.current = p;
    this.applyRhythm();
    if (swapped) {
      this.director.load(p.script, this.styleFor(p.script));
      this.director.dissolveIn(1400);
    }
    if (this.pendingPlay === p.track.id && (p.status === "ready" || p.status === "error" || p.status === "ambient")) {
      this.audio.currentTime = 0;
      this.startAudio();
    }
    this.renderNowPlaying();
    this.setStatus(p.status, p.error);
    if (this.isOpen("editor")) this.fillEditor();
  };

  // ?demo plays the built-in showcase; &t=<sec> starts there, &freeze holds that frame,
  // &style=<name> forces a style family.
  private startDemoFromUrl(): void {
    const q = new URLSearchParams(location.search);
    if (!q.has("demo")) return;
    const d = demoContent();
    const style = q.get("style");
    if (style && (STYLES as readonly string[]).includes(style)) d.script.style = style as SceneScript["style"];
    const startT = Number(q.get("t") ?? 0);
    this.demo = { ...d, t0: performance.now() / 1000 - startT, startT, freeze: q.has("freeze") };
    this.director.load(d.script, this.styleFor(d.script));
    this.applyRhythm();
    this.ui.empty.hidden = true;
    this.ui.title.textContent = "Demo: every setting and transition";
  }

  private tick = (now: number) => {
    requestAnimationFrame(this.tick);
    if (now - this.lastFrame < (this.renderMs > 11 ? SLOW_MS : FAST_MS) - 2) return;
    this.lastFrame = now;
    const started = performance.now();
    try {
      this.render(now);
    } finally {
      this.renderMs += (performance.now() - started - this.renderMs) * 0.05;
    }
  };

  private render(now: number): void {
    if (this.demo && !this.tracks.length) {
      const d = this.demo;
      const t = d.freeze ? d.startT : (now / 1000 - d.t0) % d.duration;
      const fb = this.director.frame(t, { energy: 0.45 + 0.25 * Math.sin(t * 1.7), onset: 0 });
      new Uint32Array(this.imageData.data.buffer).set(fb.data);
      this.sceneCtx.putImageData(this.imageData, 0, 0);
      this.captions.render(d.lyrics, t, getSettings().captions);
      this.ui.cur.textContent = fmt(t);
      this.ui.dur.textContent = fmt(d.duration);
      return;
    }
    const t = this.tracks.length ? this.clock.now() : now / 1000;
    const offset = this.current?.prefs.lyricOffset ?? 0;
    const lt = t + offset;
    const env = this.current?.envelope ?? null;
    const audio = env ? { energy: energyAt(env, t), onset: onsetAt(env, t) } : { energy: 0.35, onset: 0 };
    const fb = this.director.frame(lt, audio);
    new Uint32Array(this.imageData.data.buffer).set(fb.data);
    this.sceneCtx.putImageData(this.imageData, 0, 0);
    this.captions.render(this.current?.lyrics ?? null, lt, getSettings().captions);
    this.updateProgress(t);
  }

  // ---------- UI ----------

  private buildUi(): void {
    this.root.innerHTML = `
      <div class="stage"></div>
      <div class="status" hidden></div>
      <div class="empty">
        <h1>Visual Music Player</h1>
        <p>Drop audio files (and matching <code>.lrc</code> or <code>.analysis.json</code> files) anywhere, or open a folder.</p>
        <div class="row">
          <label class="btn">Add files<input type="file" multiple accept="audio/*,.lrc,.json" data-files hidden></label>
          <button class="btn" data-folder ${folderSupported ? "" : "hidden"}>Open folder</button>
          <button class="btn" data-reopen hidden></button>
        </div>
        <p class="hint">Scenes come from your Claude subscription via Claude Code (under <code>npm run dev</code>), or an API key / Ollama in <a href="#" data-open-settings>settings</a>.</p>
      </div>
      <aside class="playlist" hidden>
        <header>
          <strong>Queue</strong>
          <span class="row">
            <label class="btn sm">Add<input type="file" multiple accept="audio/*,.lrc,.json" data-files hidden></label>
            <button class="btn sm" data-folder ${folderSupported ? "" : "hidden"}>Folder</button>
          </span>
        </header>
        <ol></ol>
      </aside>
      <footer class="controls">
        <div class="seek"><span data-cur>0:00</span><input type="range" min="0" max="1000" value="0" data-seek><span data-dur>0:00</span></div>
        <div class="bar">
          <button class="icon" data-toggle-playlist title="Queue">☰</button>
          <button class="icon" data-prev title="Previous (Shift+←)">⏮</button>
          <button class="icon big" data-play title="Play/Pause (Space)">▶</button>
          <button class="icon" data-next title="Next (Shift+→)">⏭</button>
          <div class="now"><div data-title>—</div><div class="sub" data-sub></div></div>
          <div class="offset" title="Lyric offset ([ / ])"><button class="icon sm" data-off="-0.1">−</button><span data-offset>+0.0s</span><button class="icon sm" data-off="0.1">+</button></div>
          <select class="model" data-model title="Model that imagines the scenes">${CLAUDE_MODELS.map((m) => `<option value="${m.id}">${m.short}</option>`).join("")}</select>
          <select class="model" data-look title="Look: art style the scenes are drawn in"></select>
          <select class="model" data-reactivity title="Beat: how strongly the beat moves the picture (needs audio analysis)">
            <option value="off">Beat: off</option><option value="subtle">Beat: subtle</option><option value="strong">Beat: strong</option>
          </select>
          <input type="file" accept="image/*" data-ref-file hidden>
          <button class="icon" data-cc title="Captions (L)">CC</button>
          <button class="icon" data-edit title="Scene editor (E)">✎</button>
          <button class="icon" data-settings title="Settings">⚙</button>
          <button class="icon" data-fs title="Fullscreen (F)">⛶</button>
        </div>
      </footer>
      <dialog class="settings"></dialog>
      <dialog class="editor"></dialog>
      <div class="drop" hidden>Drop to add</div>
    `;
    const q = (s: string) => this.root.querySelector(s) as HTMLElement;
    this.ui = {
      stage: q(".stage"),
      status: q(".status"),
      empty: q(".empty"),
      playlist: q(".playlist"),
      list: q(".playlist ol"),
      controls: q(".controls"),
      play: q("[data-play]"),
      seek: q("[data-seek]"),
      cur: q("[data-cur]"),
      dur: q("[data-dur]"),
      title: q("[data-title]"),
      sub: q("[data-sub]"),
      offset: q("[data-offset]"),
      cc: q("[data-cc]"),
      model: q("[data-model]"),
      look: q("[data-look]"),
      reactivity: q("[data-reactivity]"),
      refFile: q("[data-ref-file]"),
      settings: q("dialog.settings"),
      editor: q("dialog.editor"),
      drop: q(".drop"),
      reopen: q("[data-reopen]"),
    };
    this.ui.stage.append(this.sceneCanvas, this.captions.canvas);
    this.captions.canvas.classList.add("captions");
    this.ui.cc.classList.toggle("on", getSettings().captions);
    void rememberedFolderName().then((name) => {
      if (!name || !folderSupported) return;
      this.ui.reopen.textContent = `Reopen “${name}”`;
      this.ui.reopen.hidden = false;
    });
  }

  private bindEvents(): void {
    this.scenes.addEventListener("update", this.onSceneUpdate);
    this.scenes.addEventListener("analysing", (e) => {
      if (!this.current && this.tracks[this.index]?.id === (e as CustomEvent<string>).detail) this.setStatus("analysing");
    });
    this.audio.addEventListener("ended", () => void this.play(this.index + 1));
    this.audio.addEventListener("play", () => (this.ui.play.textContent = "⏸"));
    this.audio.addEventListener("pause", () => (this.ui.play.textContent = "▶"));
    onSettings((s) => {
      this.ui.cc.classList.toggle("on", s.captions);
      (this.ui.look as HTMLSelectElement).value = s.styleOverride;
      (this.ui.reactivity as HTMLSelectElement).value = s.reactivity;
      this.applyRhythm();
      const script = this.current?.script ?? (this.demo && !this.tracks.length ? this.demo.script : null);
      if (script) this.director.load(script, this.styleFor(script));
    });

    this.ui.status.addEventListener("click", () => {
      if (this.pendingPlay) return this.startAudio();
      if (this.current?.status === "error") void this.scenes.request(this.current.track, { front: true, force: true });
    });

    this.root.addEventListener("click", (e) => {
      const t = (e.target as HTMLElement).closest<HTMLElement>("button, a, li[data-i]");
      if (!t) return;
      if (t.matches("[data-play]")) this.togglePlay();
      else if (t.matches("[data-prev]")) void this.play(Math.max(0, this.index - 1));
      else if (t.matches("[data-next]")) void this.play(this.index + 1);
      else if (t.matches("[data-cc]")) updateSettings({ captions: !getSettings().captions });
      else if (t.matches("[data-fs]")) this.toggleFullscreen();
      else if (t.matches("[data-settings], [data-open-settings]")) {
        e.preventDefault();
        this.openSettings();
      } else if (t.matches("[data-edit]")) this.openEditor();
      else if (t.matches("[data-toggle-playlist]")) this.ui.playlist.hidden = !this.ui.playlist.hidden;
      else if (t.matches("[data-off]")) void this.nudgeOffset(Number(t.dataset.off));
      else if (t.matches("[data-folder]")) void pickFolder().then((l) => this.addTracks(l, true)).catch((err) => this.toast(String(err.message ?? err)));
      else if (t.matches("[data-reopen]")) void reopenFolder().then((l) => l && this.addTracks(l, true));
      else if (t.matches("li[data-i]")) void this.play(Number(t.dataset.i));
    });

    this.ui.model.addEventListener("change", () => this.switchModel((this.ui.model as HTMLSelectElement).value));

    this.renderLookOptions();
    void loadReference().then(() => this.renderLookOptions());
    (this.ui.reactivity as HTMLSelectElement).value = getSettings().reactivity;
    this.ui.reactivity.addEventListener("change", () => updateSettings({ reactivity: (this.ui.reactivity as HTMLSelectElement).value as Reactivity }));
    this.ui.look.addEventListener("change", () => {
      const sel = this.ui.look as HTMLSelectElement;
      if (sel.value === "__pick") {
        sel.value = getSettings().styleOverride;
        (this.ui.refFile as HTMLInputElement).click();
      } else this.setLook(sel.value as Settings["styleOverride"]);
    });
    this.ui.refFile.addEventListener("change", () => {
      const input = this.ui.refFile as HTMLInputElement;
      const file = input.files?.[0];
      input.value = "";
      if (file) void this.chooseReference(file);
    });

    this.root.addEventListener("change", (e) => {
      const input = e.target as HTMLInputElement;
      if (input.matches("[data-files]") && input.files) {
        void tracksFromFiles([...input.files]).then((l) => this.addTracks(l));
        input.value = "";
      }
    });

    const seek = this.ui.seek as HTMLInputElement;
    seek.addEventListener("input", () => {
      if (this.audio.duration) this.audio.currentTime = (Number(seek.value) / 1000) * this.audio.duration;
    });

    let dragDepth = 0;
    window.addEventListener("dragenter", (e) => {
      e.preventDefault();
      dragDepth++;
      this.ui.drop.hidden = false;
    });
    window.addEventListener("dragleave", () => {
      if (--dragDepth <= 0) this.ui.drop.hidden = true;
    });
    window.addEventListener("dragover", (e) => e.preventDefault());
    window.addEventListener("drop", (e) => {
      e.preventDefault();
      dragDepth = 0;
      this.ui.drop.hidden = true;
      const files = [...(e.dataTransfer?.files ?? [])];
      if (files.length) void tracksFromFiles(files).then((l) => this.addTracks(l));
    });

    window.addEventListener("keydown", this.onKey);
    window.addEventListener("mousemove", this.wake);
    this.wake();
  }

  private onKey = (e: KeyboardEvent) => {
    const target = e.target as HTMLElement;
    if (target.closest("input, textarea, select") || this.isOpen("settings") || this.isOpen("editor")) return;
    const a = this.audio;
    switch (e.key) {
      case " ":
        e.preventDefault();
        this.togglePlay();
        break;
      case "ArrowLeft":
        if (e.shiftKey) void this.play(Math.max(0, this.index - 1));
        else a.currentTime = Math.max(0, a.currentTime - 5);
        break;
      case "ArrowRight":
        if (e.shiftKey) void this.play(this.index + 1);
        else a.currentTime = Math.min(a.duration || 0, a.currentTime + 5);
        break;
      case "l":
      case "L":
        updateSettings({ captions: !getSettings().captions });
        break;
      case "f":
      case "F":
        this.toggleFullscreen();
        break;
      case "e":
      case "E":
        this.openEditor();
        break;
      case "[":
        void this.nudgeOffset(-0.1);
        break;
      case "]":
        void this.nudgeOffset(0.1);
        break;
      default:
        return;
    }
    this.wake();
  };

  private wake = () => {
    this.root.classList.remove("idle");
    clearTimeout(this.idleTimer);
    this.idleTimer = window.setTimeout(() => {
      if (!this.audio.paused) this.root.classList.add("idle");
    }, 2500);
  };

  private togglePlay(): void {
    if (!this.tracks.length) return;
    if (this.pendingPlay) return this.startAudio();
    if (this.audio.paused) void this.audio.play();
    else this.audio.pause();
  }

  private toggleFullscreen(): void {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void this.root.requestFullscreen();
  }

  private async nudgeOffset(d: number): Promise<void> {
    const p = this.current;
    if (!p) return;
    const lyricOffset = Math.round((p.prefs.lyricOffset + d) * 10) / 10;
    p.prefs = await savePrefs(p.key, { lyricOffset });
    this.renderNowPlaying();
  }

  private setStatus(s: SceneStatus, err?: string): void {
    let text = STATUS_TEXT[s] + (s === "error" ? `${err ? `: ${err}` : ""} · click to retry` : "");
    if (this.pendingPlay && (s === "queued" || s === "generating" || s === "loading")) {
      text = `${modelLabel(getSettings().model)} is imagining the scenes… playback starts when they're ready · click to play now`;
    }
    if (s === "ambient" && err) {
      this.ui.status.textContent = `Ambient scene: ${err}`;
    } else this.ui.status.textContent = text;
    this.ui.status.hidden = !this.ui.status.textContent;
    this.ui.status.classList.toggle("busy", s === "generating" || s === "loading");
    this.ui.status.classList.toggle("err", s === "error");
  }

  private toast(msg: string): void {
    this.ui.status.textContent = msg;
    this.ui.status.hidden = false;
    this.ui.status.classList.add("err");
  }

  private renderNowPlaying(): void {
    const t = this.tracks[this.index];
    this.ui.empty.hidden = !!this.tracks.length;
    this.ui.title.textContent = t ? t.title || t.file.name : "—";
    const p = this.current;
    const lyr = p ? (p.lyrics.lines.length ? `${p.lyrics.synced ? "synced" : "unsynced"} lyrics · ${p.lyrics.source}` : p.lyrics.instrumental ? "instrumental" : "no lyrics found") : "";
    const by = p?.status === "ready" && p.script.model ? `scenes: ${modelLabel(p.script.model)}${p.model.includes("+ref:") ? " + reference" : ""}` : "";
    const a = p?.analysis;
    const audio = a ? `${Math.round(a.analysis.tempo.bpm)} BPM · ${a.analysis.segments.length} parts (${a.origin})` : p ? "no audio analysis" : "";
    this.ui.sub.textContent = [t?.artist, lyr, audio, by].filter(Boolean).join(" · ");
    (this.ui.model as HTMLSelectElement).value = getSettings().model;
    const o = p?.prefs.lyricOffset ?? 0;
    this.ui.offset.textContent = `${o >= 0 ? "+" : ""}${o.toFixed(1)}s`;
  }

  private renderPlaylist(): void {
    const statusOf = (track: Track) => {
      const st = this.scenes.statusOf(track.id);
      return st ? `<i class="dot ${st}" title="${STATUS_TEXT[st] || "Scenes ready"}"></i>` : `<i class="dot"></i>`;
    };
    this.ui.list.innerHTML = this.tracks
      .map(
        (t, i) =>
          `<li data-i="${i}" class="${i === this.index ? "on" : ""}">${statusOf(t)}<span>${esc(t.title || t.file.name)}</span><small>${esc(t.artist)}</small></li>`,
      )
      .join("");
  }

  private lastProgress = -1;
  private updateProgress(t: number): void {
    const d = this.audio.duration;
    const k = Math.round(t);
    if (k === this.lastProgress && !this.audio.paused) return;
    this.lastProgress = k;
    this.ui.cur.textContent = fmt(t);
    this.ui.dur.textContent = fmt(d);
    if (d && document.activeElement !== this.ui.seek) (this.ui.seek as HTMLInputElement).value = String(Math.round((t / d) * 1000));
  }

  private isOpen(which: "settings" | "editor"): boolean {
    return (this.ui[which] as HTMLDialogElement).open;
  }

  // ---------- Settings ----------

  private async openSettings(): Promise<void> {
    const s = getSettings();
    const d = this.ui.settings as HTMLDialogElement;
    const unmapped = await unmappedCounts();
    const p = this.current;
    d.innerHTML = `
      <form method="dialog">
        <h2>Settings</h2>
        <fieldset>
          <legend>Scene imagination</legend>
          <label>Provider
            <select name="provider">
              ${(["auto", "claude-code", "claude", "ollama", "off"] as Provider[]).map((v) => `<option value="${v}" ${v === s.provider ? "selected" : ""}>${{ auto: "Auto: Claude subscription → API key → Ollama", "claude-code": "Claude subscription only (via Claude Code)", claude: "API key only", ollama: "Ollama only (local)", off: "Off (ambient only)" }[v]}</option>`).join("")}
            </select>
          </label>
          <small data-bridge>Checking for Claude Code…</small>
          <label>Claude API key (optional) <input name="apiKey" type="password" autocomplete="off" value="${esc(s.apiKey)}" placeholder="sk-ant-…"></label>
          <small>Stored only in this browser and sent only to api.anthropic.com.</small>
          <label>Claude model (used by both the subscription and the API key)
            <select name="model">${CLAUDE_MODELS.map((m) => `<option value="${m.id}" ${m.id === s.model ? "selected" : ""}>${m.label}</option>`).join("")}</select>
          </label>
          <div class="row">
            <label>Ollama URL <input name="ollamaUrl" value="${esc(s.ollamaUrl)}"></label>
            <label>Ollama model <input name="ollamaModel" value="${esc(s.ollamaModel)}"></label>
          </div>
          <small>Ollama needs <code>OLLAMA_ORIGINS=*</code> (or this page's origin) to accept browser requests.</small>
        </fieldset>
        <fieldset>
          <legend>Audio analysis</legend>
          <label class="check"><input type="checkbox" name="useAnalysis" ${s.useAnalysis ? "checked" : ""}> Use audio analysis (tempo, bars, repeating parts) when it's available</label>
          <label>music-connector URL <input name="analysisUrl" value="${esc(s.analysisUrl)}" placeholder="empty: don't ask a server"></label>
          <small>When <code>mc serve</code> runs there, each new song is analysed for tempo, bars and repeating parts, so scenes change on the beat and choruses return to their world. Without it, <code>.analysis.json</code> sidecar files are used. Applies from the next song loaded.</small>
        </fieldset>
        <fieldset>
          <legend>Display</legend>
          <label class="check"><input type="checkbox" name="captions" ${s.captions ? "checked" : ""}> Show lyrics as captions</label>
          <label class="check"><input type="checkbox" name="waitForScenes" ${s.waitForScenes ? "checked" : ""}> Wait for scenes before playing a new song</label>
          <label>Look
            <select name="styleOverride">
              <option value="auto">Chosen per song by Claude</option>
              ${STYLES.map((v) => `<option value="${v}" ${v === s.styleOverride ? "selected" : ""}>${LOOK_LABELS[v]}</option>`).join("")}
              ${currentReference() ? `<option value="reference" ${s.styleOverride === "reference" ? "selected" : ""}>My reference image</option>` : ""}
            </select>
          </label>
          <div class="row ref">
            ${currentReference() ? `<img src="${currentReference()!.image}" alt="" class="ref-thumb">` : ""}
            <label class="btn">${currentReference() ? "Change" : "Choose"} reference image<input type="file" accept="image/*" data-settings-ref hidden></label>
          </div>
          <label class="check"><input type="checkbox" name="referenceForScenes" ${s.referenceForScenes ? "checked" : ""}> Let Claude see the reference when imagining scenes (re-imagines the song; otherwise only colours change)</label>
        </fieldset>
        ${
          p
            ? `<fieldset>
          <legend>This song: ${esc(p.track.title)}</legend>
          <label>Scene direction <textarea name="scenePrompt" rows="2" placeholder="e.g. a desert road at dawn, a long drive alone">${esc(p.prefs.scenePrompt)}</textarea></label>
          <button type="button" class="btn" data-regen>Save direction &amp; regenerate scenes</button>
        </fieldset>`
            : ""
        }
        <fieldset>
          <legend>Scene library</legend>
          <div class="row">
            <button type="button" class="btn" data-export>Export all scripts</button>
            <label class="btn">Import<input type="file" accept="application/json" data-import hidden></label>
          </div>
          <details><summary>Concepts the vocabulary couldn't show (${unmapped.length})</summary>
            <ul class="unmapped">${unmapped.slice(0, 60).map(([c, n]) => `<li>${esc(c)} <b>${n}</b></li>`).join("") || "<li>None yet</li>"}</ul>
          </details>
        </fieldset>
        <div class="row end"><button class="btn primary" value="save">Done</button></div>
      </form>`;
    const form = d.querySelector("form")!;
    void claudeCodeAvailable().then((b) => {
      const el = d.querySelector("[data-bridge]");
      if (!el) return;
      el.textContent = b.available
        ? `Claude Code ${b.version ?? ""} found: scenes use your Claude subscription, no API key needed.`
        : "Claude Code bridge not available (it only runs under npm run dev with the claude CLI installed and signed in).";
    });
    const save = () => {
      const f = new FormData(form);
      updateSettings({
        provider: f.get("provider") as Provider,
        apiKey: String(f.get("apiKey") ?? "").trim(),
        ollamaUrl: String(f.get("ollamaUrl")),
        ollamaModel: String(f.get("ollamaModel")),
        captions: f.get("captions") === "on",
        waitForScenes: f.get("waitForScenes") === "on",
        referenceForScenes: f.get("referenceForScenes") === "on",
        analysisUrl: String(f.get("analysisUrl") ?? "").trim(),
        useAnalysis: f.get("useAnalysis") === "on",
      });
    };
    form.addEventListener("change", (e) => {
      const t = e.target as HTMLInputElement;
      if (t.matches("[name=model]")) this.switchModel(t.value);
      else if (t.matches("[name=styleOverride]")) this.setLook(t.value as Settings["styleOverride"]);
      else if (t.matches("[data-settings-ref]")) {
        const file = t.files?.[0];
        if (file) void this.chooseReference(file).then(() => d.close());
      } else {
        const before = getSettings().referenceForScenes;
        save();
        if (before !== getSettings().referenceForScenes && getSettings().styleOverride === "reference" && this.current) void this.scenes.switchModel(this.current.track);
      }
    });
    d.querySelector("[data-regen]")?.addEventListener("click", async () => {
      save();
      if (!p) return;
      const prefs = await savePrefs(p.key, { scenePrompt: String(new FormData(form).get("scenePrompt") ?? "") });
      await this.scenes.updatePrefs(p.track, prefs);
      void this.scenes.request(p.track, { front: true, force: true });
      d.close();
    });
    d.querySelector("[data-export]")?.addEventListener("click", async () => {
      const a = el("a", { download: "visual-music-player-scenes.json" });
      a.href = URL.createObjectURL(await exportAll());
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    });
    d.querySelector("[data-import]")?.addEventListener("change", async (e) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (!file) return;
      try {
        const r = await importAll(file);
        this.toast(`Imported ${r.scripts} scene scripts${r.skipped ? ` (${r.skipped} invalid skipped)` : ""}. They apply next time each song loads.`);
      } catch (err) {
        this.toast(String((err as Error).message));
      }
    });
    d.addEventListener("close", () => {
      save();
      if (this.current?.status === "ambient") void this.scenes.request(this.current.track, { front: true });
    }, { once: true });
    d.showModal();
  }

  // ---------- Scene editor ----------

  private openEditor(): void {
    const d = this.ui.editor as HTMLDialogElement;
    d.innerHTML = `
      <div class="ed">
        <header><h2>Scene script</h2><span data-meta></span></header>
        <textarea spellcheck="false" data-json></textarea>
        <div class="err" data-err></div>
        <div class="row end">
          <button class="btn" data-regen>Regenerate</button>
          <button class="btn" data-revert>Revert</button>
          <button class="btn" data-close>Close</button>
          <button class="btn primary" data-save>Save</button>
        </div>
      </div>`;
    this.fillEditor();
    const err = d.querySelector("[data-err]") as HTMLElement;
    d.querySelector("[data-close]")!.addEventListener("click", () => d.close());
    d.querySelector("[data-revert]")!.addEventListener("click", () => this.fillEditor());
    d.querySelector("[data-regen]")!.addEventListener("click", () => {
      if (this.current) void this.scenes.request(this.current.track, { front: true, force: true });
    });
    d.querySelector("[data-save]")!.addEventListener("click", async () => {
      if (!this.current) return;
      try {
        const raw = JSON.parse((d.querySelector("[data-json]") as HTMLTextAreaElement).value);
        const parsed = SceneScript.safeParse({ ...raw, source: "manual" });
        if (!parsed.success) {
          err.textContent = parsed.error.issues.slice(0, 6).map((i) => `${i.path.join(".")}: ${i.message}`).join("\n");
          return;
        }
        err.textContent = "";
        await this.scenes.replaceScript(this.current.track, parsed.data);
        d.close();
      } catch (e) {
        err.textContent = `Invalid JSON: ${(e as Error).message}`;
      }
    });
    d.showModal();
  }

  private fillEditor(): void {
    const d = this.ui.editor;
    const ta = d.querySelector("[data-json]") as HTMLTextAreaElement | null;
    const meta = d.querySelector("[data-meta]");
    if (!ta || !meta) return;
    const p = this.current;
    ta.value = p ? JSON.stringify(p.script, null, 2) : "No track loaded.";
    meta.textContent = p ? `${p.track.title} · ${p.script.source} · ${p.script.sections.length} sections · ${STATUS_TEXT[p.status] || "ready"}` : "";
  }
}
