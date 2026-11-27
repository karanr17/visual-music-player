import { SongAnalysis } from "./analysis/schema";
import { Rhythm, type Reactivity } from "./audio/rhythm";
import { computeEnvelope, energyAt, energyIntegral, onsetAt, type Envelope } from "./audio/envelope";
import { parseLrc, type Lyrics } from "./lyrics/lyrics";
import { Captions, CH, CW } from "./render/captions";
import { loadCharacters } from "./render/characters";
import { Director } from "./render/director";
import { PH, PW } from "./render/fb";
import { decode } from "./plates/client";
import { PlateSet } from "./render/plates";
import { SceneScript } from "./scene/schema";

// ?capture: renders a scene script frame by frame at exact times, for videos and comparisons
// (scripts/render-comparison.mjs drives it). Nothing plays; every frame is a pure function of t.

const STRIP = 44;

export interface CaptureInput {
  script: unknown;
  lrc?: string;
  audioUrl?: string;
  analysis?: unknown;
  title: string;
  // Default "subtle"; "off" renders as the player did before beat reactivity.
  reactivity?: Reactivity;
  // A plate set from scripts/plates: renders in illustrated mode.
  plates?: unknown;
}

const COLORS: Record<string, string> = {
  intro: "#6c7a89",
  verse: "#3d7ea6",
  pre_chorus: "#7d5ba6",
  chorus: "#d9822b",
  bridge: "#3fa37a",
  outro: "#6c7a89",
  instrumental: "#8a8f3d",
};

class Capture {
  private director!: Director;
  private script!: SceneScript;
  private lyrics: Lyrics | null = null;
  private env: Envelope | null = null;
  private analysis: SongAnalysis | null = null;
  private rhythm: Rhythm | null = null;
  private title = "";
  private captions = new Captions();
  private scene = Object.assign(document.createElement("canvas"), { width: PW, height: PH });
  private img = new ImageData(PW, PH);
  private out = Object.assign(document.createElement("canvas"), { width: CW, height: CH + STRIP });

  async load(input: CaptureInput): Promise<{ sections: number; duration: number; plates: number }> {
    await loadCharacters();
    await document.fonts?.ready;
    this.script = SceneScript.parse(input.script);
    this.title = input.title;
    this.analysis = input.analysis ? SongAnalysis.parse(input.analysis) : null;
    if (input.audioUrl) {
      const blob = await (await fetch(input.audioUrl)).blob();
      this.env = await computeEnvelope(new File([blob], "audio"));
    }
    const duration = this.script.sections.at(-1)!.end;
    this.lyrics = input.lrc ? { lines: parseLrc(input.lrc, duration), synced: true, source: "lrc-file", instrumental: false } : null;
    this.director = new Director(this.script, this.script.style);
    this.director.setEnergyIntegral((t) => energyIntegral(this.env, t));
    this.rhythm = this.analysis ? new Rhythm(this.analysis) : null;
    this.director.setRhythm(this.rhythm, input.reactivity ?? "subtle");
    this.director.setPlates(input.plates ? await decode(PlateSet.parse(input.plates)) : null);
    return { sections: this.script.sections.length, duration, plates: this.director.platesShown };
  }

  frame(t: number): string {
    const fb = this.director.frame(t, { energy: energyAt(this.env, t), onset: onsetAt(this.env, t) });
    new Uint32Array(this.img.data.buffer).set(fb.data);
    this.scene.getContext("2d")!.putImageData(this.img, 0, 0);
    this.captions.render(this.lyrics, t, true);
    const g = this.out.getContext("2d")!;
    g.imageSmoothingEnabled = false;
    g.drawImage(this.scene, 0, 0, CW, CH);
    g.drawImage(this.captions.canvas, 0, 0);
    this.strip(g, t);
    return this.out.toDataURL("image/png");
  }

  // Section blocks under the picture: colour is the section label, the letter is the recurrence
  // group, ticks are downbeats. The white line is the playhead.
  private strip(g: CanvasRenderingContext2D, t: number): void {
    const ss = this.script.sections;
    const dur = ss.at(-1)!.end;
    const x = (v: number) => Math.round((v / dur) * CW);
    g.fillStyle = "#111";
    g.fillRect(0, CH, CW, STRIP);
    g.font = '11px "Pixelify Sans", ui-monospace, monospace';
    g.textBaseline = "top";
    g.fillStyle = "#ddd";
    const cur = [...ss].reverse().find((s) => t >= s.start) ?? ss[0];
    g.fillText(`${this.title}  ·  ${cur.label}${cur.recurrence ? ` (${cur.recurrence})` : ""}: ${cur.world.setting}, ${cur.world.timeOfDay}`, 6, CH + 3);
    for (const s of ss) {
      g.fillStyle = COLORS[s.label] ?? "#555";
      g.fillRect(x(s.start) + 1, CH + 18, Math.max(1, x(s.end) - x(s.start) - 1), 16);
      if (s.recurrence && x(s.end) - x(s.start) > 10) {
        g.fillStyle = "#000";
        g.fillText(s.recurrence, x(s.start) + 3, CH + 20);
      }
    }
    if (this.analysis) {
      g.fillStyle = "rgba(255,255,255,0.45)";
      for (const d of this.analysis.downbeats) g.fillRect(x(d), CH + 35, 1, 3);
    }
    if (this.rhythm) {
      // A metronome from the analysis's beat grid, to check the picture against: big on downbeats.
      const r = this.rhythm;
      const k = Math.max(Math.exp(-r.sinceDownbeat(t) / 0.15), 0.5 * Math.exp(-r.sinceBeat(t) / 0.15));
      g.fillStyle = `rgba(255,214,120,${(0.15 + 0.85 * k).toFixed(3)})`;
      g.beginPath();
      g.arc(CW - 12, CH + 8, 3 + 3 * k, 0, Math.PI * 2);
      g.fill();
    }
    g.fillStyle = "#fff";
    g.fillRect(x(t), CH + 15, 2, 26);
  }
}

export function startCapture(root: HTMLElement): void {
  const c = new Capture();
  root.textContent = "capture mode: call window.vmpCapture.load(input), then frame(t)";
  (window as unknown as { vmpCapture: Capture }).vmpCapture = c;
}
