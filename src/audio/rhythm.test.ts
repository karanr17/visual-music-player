import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SongAnalysis } from "../analysis/schema";
import { FOOTFALL_PACE, STEP_PX, WALK_V } from "../render/characters";
import { Director } from "../render/director";
import { K } from "../render/fb";
import { applyMotion, type LiveSubject, type SceneState } from "../render/world";
import type { SceneScript } from "../scene/schema";
import { gridPosition, Rhythm, rhythmFrame } from "./rhythm";

const analysis = SongAnalysis.parse(JSON.parse(readFileSync(join(__dirname, "../../public/analysis/unbury-your-heart.analysis.json"), "utf8")));
const rhythm = new Rhythm(analysis);

describe("beat grid", () => {
  it("is a whole number at every beat and linear between", () => {
    const b = [1, 2, 3.5];
    expect(gridPosition(b, 1, 2)).toBe(1);
    expect(gridPosition(b, 1, 2.75)).toBeCloseTo(1.5);
    expect(gridPosition(b, 1, 0)).toBe(-1);
    expect(gridPosition(b, 1, 4.5)).toBe(3);
  });

  it("puts a whole number of footfall periods of pace on each beat", () => {
    expect(FOOTFALL_PACE).toBeCloseTo(4 / ((WALK_V * K) / STEP_PX));
    for (const b of analysis.beats.slice(0, 40)) {
      const steps = rhythm.pace(b) / (FOOTFALL_PACE * rhythm.footfallsPerBeat);
      expect(steps).toBeCloseTo(Math.round(steps), 6);
    }
  });

  it("keeps the walk near its tuned speed whatever the tempo", () => {
    for (const bpm of [60, 90, 100, 128, 150, 180]) {
      const r = Rhythm.fromTempo(bpm, 120);
      const rate = (r.pace(60) - r.pace(0)) / 60;
      expect(rate).toBeGreaterThan(0.5);
      expect(rate).toBeLessThan(1.6);
    }
  });

  it("falls back to an even grid from the tempo alone", () => {
    const r = Rhythm.fromTempo(120, 30);
    expect(r.beatPos(0.5)).toBeCloseTo(1);
    expect(r.sinceDownbeat(2.25)).toBeCloseTo(0.25);
    expect(rhythmFrame(r, "subtle", 3).lift).toBeGreaterThan(0);
  });

  it("lifts the light hardest right on a downbeat", () => {
    const d = analysis.downbeats[30];
    const on = rhythmFrame(rhythm, "strong", d).lift;
    expect(on).toBeGreaterThan(rhythmFrame(rhythm, "strong", d + rhythm.beatPeriod / 2).lift);
    expect(on).toBeGreaterThan(rhythmFrame(rhythm, "subtle", d).lift);
  });
});

describe("walking on the beat", () => {
  const sub: LiveSubject = {
    kind: "walking_figure", custom: "", focus: false, wasFocus: false, position: "left", fromPosition: null,
    motion: "walk", alpha: 1, move: 0, since: 0, slot: 0, seed: 0,
  };

  it("lands footfalls (walk frames 0 and 4) on beats, through turns", async () => {
    const { alignStep } = await import("../render/world");
    const state = { pace: (t: number) => rhythm.pace(t), stepAlign: alignStep, travel: 0 } as unknown as SceneState;
    for (const since of [30.13, 47.9, 61.02]) {
      const s = { ...sub, since };
      let checked = 0;
      const at = (t: number) => applyMotion(s, { x: 100, y: 120, s: 2, ink: [0, 0, 0] }, 2, state, t, 0.5, false, false).gait;
      const R = (WALK_V * K) / STEP_PX;
      for (const b of analysis.beats.filter((x) => x > since + 2 && x < since + 40)) {
        const g = at(b);
        const frame = g.dist / g.step;
        // Only full-speed stretches: eased starts, stops and turns are allowed off the grid.
        const ahead = at(b + 0.1);
        const cruising = g.moving && ahead.moving && Math.abs(ahead.dist / ahead.step - frame - R * (rhythm.pace(b + 0.1) - rhythm.pace(b))) < 1e-6;
        if (!cruising) continue;
        expect(Math.abs(frame / 4 - Math.round(frame / 4))).toBeLessThan(0.005);
        checked++;
      }
      expect(checked).toBeGreaterThan(20);
    }
  });
});

describe("deterministic seek", () => {
  const script = JSON.parse(readFileSync(join(__dirname, "../../docs/demo/unbury-your-heart.scene.json"), "utf8")) as SceneScript;

  it("renders the same pixels at t whether it played up to t or jumped there", () => {
    const t = 60.5;
    const played = new Director(script, "lofi");
    played.setRhythm(rhythm, "strong");
    for (let x = 56; x < t; x += 1 / 12) played.frame(x, { energy: 0.5, onset: 0 });
    const a = played.frame(t, { energy: 0.5, onset: 0 }).data.slice();

    const jumped = new Director(script, "lofi");
    jumped.setRhythm(rhythm, "strong");
    const b = jumped.frame(t, { energy: 0.5, onset: 0 }).data;
    expect(Buffer.from(b.buffer).equals(Buffer.from(a.buffer))).toBe(true);
  });

  it("changes nothing when reactivity is off", () => {
    const off = new Director(script, "natural");
    off.setRhythm(rhythm, "off");
    const plain = new Director(script, "natural");
    const t = 70.2;
    expect(Buffer.from(off.frame(t, { energy: 0.5, onset: 0.3 }).data.buffer).equals(Buffer.from(plain.frame(t, { energy: 0.5, onset: 0.3 }).data.buffer))).toBe(true);
  });
});
