import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { compile } from "../scene/compile";
import { audioBlock, buildUserPrompt } from "../scene/prompt";
import type { ModelOutput } from "../scene/schema";
import { SongAnalysis } from "./schema";
import { barSeconds, buildTimeline, instrumentalSegments, segmentLines, snapToDownbeat } from "./structure";

// Unbury Your Heart: A 0-22.3 (no singing), B 22.3-62.6, C (chorus) at 62.6, 118.3, 185.5 …
const analysis = SongAnalysis.parse(JSON.parse(readFileSync(join(__dirname, "../../public/analysis/unbury-your-heart.analysis.json"), "utf8")));

// One lyric line every 5 s from 23 s to 258 s, skipping 156-185 s (segment F) as a break.
const lines = Array.from({ length: 48 }, (_, i) => 23 + i * 5)
  .filter((t) => t < 156 || t >= 186)
  .map((t, i) => ({ t, text: `line ${i}` }));

const world = (setting: ModelOutput["sections"][number]["world"]["setting"]) => ({
  setting,
  timeOfDay: "dusk" as const,
  weather: "clear" as const,
  mood: "warm" as const,
  camera: "drift" as const,
  plate: `a ${setting} at dusk`,
});

function section(label: ModelOutput["sections"][number]["label"], fromLine: number, toLine: number, setting: Parameters<typeof world>[0]) {
  return {
    label,
    fromLine,
    toLine,
    world: world(setting),
    transitionIn: "dissolve" as const,
    moments: Array.from({ length: toLine - fromLine + 1 }, (_, k) => ({
      line: fromLine + k,
      shot: "medium" as const,
      subjects: [],
      particles: "none" as const,
      event: "none" as const,
      intensity: 0.5,
    })),
  };
}

const output = (sections: ModelOutput["sections"]): ModelOutput => ({
  style: "natural",
  cast: undefined as unknown as ModelOutput["cast"],
  sections,
  sprites: [],
  unmapped: [],
});

describe("timeline", () => {
  it("marks segments with no singing as instrumental", () => {
    const inst = instrumentalSegments(analysis, lines.map((l) => l.t));
    expect(inst.map((s) => s.label)).toEqual(["A", "F", "G"]);
  });

  it("interleaves instrumental markers with lyric lines", () => {
    const tl = buildTimeline(lines, analysis);
    expect(tl[0]).toMatchObject({ t: 0, lyric: null });
    expect(tl[1]).toMatchObject({ t: 23, lyric: 0 });
    expect(tl.filter((e) => e.lyric === null)).toHaveLength(3);
    expect(tl.map((e) => e.t)).toEqual([...tl.map((e) => e.t)].sort((a, b) => a - b));
  });

  it("splits long segments into several pseudo-lines when there are no lyrics", () => {
    const pl = segmentLines(analysis);
    expect(pl.length).toBeGreaterThan(analysis.segments.length);
    expect(pl[0].text).toContain("part A");
  });
});

describe("downbeat snapping", () => {
  it("moves a time onto the nearest downbeat within half a bar", () => {
    const d = analysis.downbeats[20];
    expect(snapToDownbeat(d + 0.3, analysis)).toBe(d);
    expect(snapToDownbeat(d - 0.3, analysis)).toBe(d);
  });

  it("leaves a time alone when no downbeat is near", () => {
    const sparse = { ...analysis, downbeats: [10, 40] };
    expect(snapToDownbeat(25, sparse)).toBe(25);
  });

  it("estimates the bar length from the downbeats", () => {
    expect(barSeconds(analysis)).toBeCloseTo((60 / analysis.tempo.bpm) * 4, 0);
  });
});

describe("compile with analysis", () => {
  const tl = buildTimeline(lines, analysis);
  const times = tl.map((e) => e.t);
  const instrumental = tl.map((e) => e.lyric === null);
  const idx = (t: number) => tl.findIndex((e) => e.t >= t);

  // A model that ignored the instrumental markers and grouped by lyrics alone.
  const careless = output([
    section("verse", 0, idx(62) - 1, "field"),
    section("chorus", idx(62), idx(86) - 1, "beach"),
    section("verse", idx(86), idx(118) - 1, "city"),
    section("chorus", idx(118), idx(135) - 1, "forest"),
    section("bridge", idx(135), idx(185.5) - 1, "lake"),
    section("chorus", idx(185.5), tl.length - 1, "space"),
  ]);
  const script = compile(careless, times, analysis.source.durationS, "k", "claude", { analysis, instrumental });

  it("gives every instrumental stretch its own section", () => {
    expect(script.sections[0]).toMatchObject({ label: "intro", start: 0 });
    expect(script.sections[1].label).toBe("verse");
    expect(script.sections.some((s) => s.label === "instrumental" && Math.abs(s.start - 156.7) < 1)).toBe(true);
    expect(script.sections.at(-1)!.label).toBe("outro");
  });

  it("starts every section after the first on a downbeat", () => {
    for (const s of script.sections.slice(1)) expect(analysis.downbeats).toContain(s.start);
  });

  it("returns repeated choruses to the first chorus's world", () => {
    const choruses = script.sections.filter((s) => s.label === "chorus");
    expect(choruses.length).toBeGreaterThanOrEqual(3);
    for (const c of choruses) expect(c.recurrence).toBe("C");
    expect(new Set(choruses.map((c) => c.world.setting))).toEqual(new Set(["beach"]));
  });

  it("makes transitions a whole number of beats", () => {
    const beat = barSeconds(analysis) / 4;
    const checked = script.sections.slice(1).filter((s, i) => {
      const prev = script.sections[i];
      return s.transitionDuration < (prev.end - prev.start) / 2;
    });
    expect(checked.length).toBeGreaterThan(3);
    for (const s of checked) expect(s.transitionDuration / beat).toBeCloseTo(Math.round(s.transitionDuration / beat), 5);
  });

  it("is unchanged without analysis", () => {
    const plain = output([section("verse", 0, 5, "field"), section("chorus", 6, 10, "beach")]);
    const t = lines.map((l) => l.t);
    const s = compile(plain, t, 270, "k", "claude");
    expect(s.sections.map((x) => x.start)).toEqual([0, t[6]]);
    expect(s.sections[0].recurrence).toBeUndefined();
  });
});

describe("audio prompt block", () => {
  it("lists tempo, recurrence labels and descriptors as hints", () => {
    const block = audioBlock(analysis, lines);
    expect(block).toMatch(/about 100 BPM/);
    expect(block).toMatch(/0:00-0:22 {2}A/);
    expect(block).toMatch(/C′/);
    expect(block).toMatch(/often wrong/);
  });

  it("flags a low-confidence tempo", () => {
    const shaky = { ...analysis, tempo: { ...analysis.tempo, confidence: 0.3 } };
    expect(audioBlock(shaky, lines)).toMatch(/may be half or double/);
  });

  it("goes into the user prompt with the instrumental markers numbered as lines", () => {
    const track = { id: "x", file: new File([], "x.mp3"), title: "Unbury Your Heart", artist: "Siobhan Dakay", album: "", duration: 271 };
    const lyrics = { lines: lines.map((l) => ({ ...l, end: l.t + 4, words: [] })), synced: true, source: "lrc-file" as const, instrumental: false };
    const prompt = buildUserPrompt(track, lyrics, null, "", [], false, { analysis, timeline: buildTimeline(lines, analysis) });
    expect(prompt).toMatch(/\[0\] 0:00 \(instrumental/);
    expect(prompt).toMatch(/\[1\] 0:23 line 0/);
    expect(prompt).toMatch(/Audio \(measured/);
  });
});
