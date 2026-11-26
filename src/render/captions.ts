import type { LyricLine, Lyrics } from "../lyrics/lyrics";

export const CW = 640;
export const CH = 360;
const FONT = '16px "Pixelify Sans", ui-monospace, monospace';
const MAX_ROW = 560;
const POP = 0.16;

interface Glyph {
  img: HTMLCanvasElement;
  w: number;
}

interface Layout {
  rows: { words: number[]; width: number }[];
}

// Captions live on their own 2x-resolution pixel layer: 320x180 is too small for
// most non-Latin scripts to stay legible.
export class Captions {
  readonly canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private glyphs = new Map<string, Glyph>();
  private layouts = new Map<LyricLine, Layout>();
  private measure: CanvasRenderingContext2D;

  constructor() {
    this.canvas = document.createElement("canvas");
    this.canvas.width = CW;
    this.canvas.height = CH;
    this.ctx = this.canvas.getContext("2d")!;
    this.ctx.imageSmoothingEnabled = false;
    this.measure = document.createElement("canvas").getContext("2d")!;
    document.fonts?.addEventListener("loadingdone", () => {
      this.glyphs.clear();
      this.layouts.clear();
    });
  }

  // Text is rasterised once per word and thresholded so it stays hard-edged pixel art,
  // then given a 1px dark outline for contrast over any scene.
  private glyph(word: string): Glyph {
    let g = this.glyphs.get(word);
    if (g) return g;
    this.measure.font = FONT;
    const w = Math.ceil(this.measure.measureText(word).width) + 4;
    const h = 24;
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    const x = c.getContext("2d")!;
    x.font = FONT;
    x.textBaseline = "top";
    x.fillStyle = "#fff";
    x.fillText(word, 2, 3);
    const img = x.getImageData(0, 0, w, h);
    const solid = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) solid[i] = img.data[i * 4 + 3] > 110 ? 1 : 0;
    for (let y = 0; y < h; y++) {
      for (let xx = 0; xx < w; xx++) {
        const i = y * w + xx;
        const o = i * 4;
        if (solid[i]) {
          img.data[o] = img.data[o + 1] = img.data[o + 2] = 255;
          img.data[o + 3] = 255;
        } else {
          const near = (solid[i - 1] && xx > 0) || (solid[i + 1] && xx < w - 1) || solid[i - w] || solid[i + w];
          img.data[o] = 10;
          img.data[o + 1] = 8;
          img.data[o + 2] = 20;
          img.data[o + 3] = near ? 230 : 0;
        }
      }
    }
    x.putImageData(img, 0, 0);
    g = { img: c, w: w - 4 };
    this.glyphs.set(word, g);
    return g;
  }

  private layout(line: LyricLine): Layout {
    let l = this.layouts.get(line);
    if (l) return l;
    const space = this.glyph(" ").w || 6;
    const rows: Layout["rows"] = [{ words: [], width: 0 }];
    line.words.forEach((w, i) => {
      const gw = this.glyph(w.text).w;
      let row = rows[rows.length - 1];
      if (row.words.length && row.width + space + gw > MAX_ROW) {
        row = { words: [], width: 0 };
        rows.push(row);
      }
      row.width += (row.words.length ? space : 0) + gw;
      row.words.push(i);
    });
    l = { rows };
    this.layouts.set(line, l);
    return l;
  }

  render(lyrics: Lyrics | null, t: number, enabled: boolean): void {
    const ctx = this.ctx;
    ctx.clearRect(0, 0, CW, CH);
    if (!enabled || !lyrics?.lines.length) return;
    const lines = lyrics.lines;
    let li = -1;
    for (let i = lines.length - 1; i >= 0; i--) {
      if (t >= lines[i].t) {
        li = i;
        break;
      }
    }
    if (li < 0) return;
    const line = lines[li];
    const lastWord = line.words[line.words.length - 1]?.t ?? line.t;
    const hideAt = Math.min(line.end, lastWord + 5);
    const fade = t > hideAt ? 1 - (t - hideAt) / 0.4 : 1;
    if (fade <= 0) return;

    const { rows } = this.layout(line);
    const space = this.glyph(" ").w || 6;
    const rowH = 22;
    let y = CH - 26 - rows.length * rowH;
    for (const row of rows) {
      let x = Math.round((CW - row.width) / 2);
      for (const wi of row.words) {
        const w = line.words[wi];
        const g = this.glyph(w.text);
        const age = t - w.t;
        if (age >= 0) {
          const pop = Math.min(1, age / POP);
          const lift = Math.round((1 - pop) * 5);
          ctx.globalAlpha = fade * (0.35 + pop * 0.65);
          ctx.drawImage(g.img, x - 2, y - lift);
        }
        x += g.w + space;
      }
      y += rowH;
    }
    ctx.globalAlpha = 1;
  }
}
