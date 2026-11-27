import { describe, expect, it } from "vitest";
import { cleanUnmapped, directorJsonSchema, mergePasses, normalizeDirector, normalizeScript, renderNotes, scriptJsonSchema } from "./director";
import { ModelOutput } from "./schema";

const world = { setting: "beach", timeOfDay: "dusk", weather: "clear", mood: "warm", camera: "drift" };

const rawNotes = {
  logline: "A goodbye on the shore.",
  arc: "Warm dusk turns to a cold night.",
  style: "watercolor",
  cast: { lead: { gender: "female", age: "adult", skin: "#c68a64", hair: "#2b1d16", hairStyle: "long", top: "#d9a441", bottom: "#3b4a6b", outfit: "dress" } },
  sections: [
    // Out of order, with a near-miss label and an out-of-range line, as models sometimes write.
    { label: "Chorus", fromLine: 3, toLine: 9, world: { ...world, setting: "Ocean", timeOfDay: "Night" }, transitionIn: "pan-up", intent: "The sea takes over.", shots: [{ line: 3, shot: "wide", focus: "an empty sea" }, { line: 4, shot: "close", focus: "a letter" }, { line: 40, shot: "close", focus: "out of range" }] },
    { label: "intro", fromLine: 1, toLine: 2, world, transitionIn: "fade_black", intent: "Two people on the sand.", shots: [{ line: 1, shot: "wide", focus: "the couple far off" }, { line: 2, shot: "medium", focus: "the couple" }] },
  ],
};

describe("director notes", () => {
  it("repairs near misses, orders sections and clamps lines", () => {
    const { notes, misses } = normalizeDirector(rawNotes, 6);
    expect(notes.sections.map((s) => [s.label, s.fromLine, s.toLine])).toEqual([
      ["intro", 0, 2],
      ["chorus", 3, 5],
    ]);
    expect(notes.sections[1].world.setting).toBe("ocean");
    expect(notes.sections[1].transitionIn).toBe("pan_up");
    expect(notes.sections[1].shots.map((s) => s.line)).toEqual([3, 4]);
    expect(notes.style).toBe("watercolor");
    expect(notes.cast.lead.outfit).toBe("dress");
    // The partner was missing: the default fills it in.
    expect(notes.cast.partner.gender).toBe("male");
    expect(misses).toEqual([]);
  });

  it("refuses notes with no sections", () => {
    expect(() => normalizeDirector({ logline: "x" }, 5)).toThrow();
  });

  it("produces structured-output schemas without numeric bounds", () => {
    for (const s of [directorJsonSchema(), scriptJsonSchema()]) expect(JSON.stringify(s)).not.toMatch(/minimum|maximum|\$schema/);
  });
});

describe("merging the passes", () => {
  const { notes } = normalizeDirector(rawNotes, 6);
  const { script } = normalizeScript({
    moments: [
      { line: 0, subjects: [{ kind: "couple", custom: "", position: "far", motion: "still", focus: false }], particles: "none", event: "none", intensity: 0.3 },
      { line: 1, subjects: [{ kind: "couple", custom: "", position: "center", motion: "walk", focus: true }], particles: "fireflies", event: "flash", intensity: 0.5 },
      // Line 2 skipped by the model.
      { line: 3, subjects: [{ kind: "boat", custom: "", position: "far", motion: "drift", focus: false }, { kind: "lighthouse_beam", custom: "", position: "right", motion: "still", focus: false }, { kind: "tidepool", custom: "", position: "left", motion: "still", focus: false }], particles: "none", event: "none", intensity: 0.6 },
      { line: 4, subjects: [{ kind: "custom", custom: "Paper Boat", position: "center", motion: "still", focus: true }], particles: "none", event: "none", intensity: 0.9 },
      { line: 5, subjects: [], particles: "none", event: "none", intensity: 0.2 },
    ],
    sprites: [{ name: "paper boat", palette: ["#000000", "#ffffff", "#cccccc"], rows: ["..0000..", ".011110.", "01111110", "02222220", ".000000."] }],
    unmapped: ["tide"],
  });
  const merged = mergePasses(notes, script);

  it("is a valid ModelOutput", () => {
    expect(ModelOutput.safeParse(merged).success).toBe(true);
  });

  it("takes structure, worlds, style and cast from the director", () => {
    expect(merged.style).toBe("watercolor");
    expect(merged.sections.map((s) => s.world.setting)).toEqual(["beach", "ocean"]);
    expect(merged.cast.lead.outfit).toBe("dress");
  });

  it("takes shots from the director and keeps the script's own default elsewhere", () => {
    const shot = (line: number) => merged.sections.flatMap((s) => s.moments).find((m) => m.line === line)?.shot;
    expect([shot(1), shot(2), shot(3), shot(4)]).toEqual(["wide", "medium", "wide", "close"]);
    expect(shot(0)).toBe("medium");
  });

  it("fills a skipped line with the previous subjects but not its one-shot event", () => {
    const m2 = merged.sections[0].moments.find((m) => m.line === 2)!;
    expect(m2.subjects[0].kind).toBe("couple");
    expect(m2.event).toBe("none");
  });

  it("drops unknown subjects into unmapped and resolves drawn sprites", () => {
    const m3 = merged.sections[1].moments.find((m) => m.line === 3)!;
    expect(m3.subjects.map((s) => s.kind)).toEqual(["boat", "lighthouse"]);
    expect(merged.unmapped).toEqual(expect.arrayContaining(["tide", "tidepool"]));
    const m4 = merged.sections[1].moments.find((m) => m.line === 4)!;
    expect(m4.subjects[0]).toMatchObject({ kind: "custom", custom: "paper_boat" });
  });

  it("renders the plan for the script pass with every line", () => {
    const text = renderNotes(notes, Array.from({ length: 6 }, (_, i) => ({ t: i * 4, text: `line ${i}` })));
    expect(text).toMatch(/\[4\] line 4 {2}→ {2}close: a letter/);
    expect(text).toMatch(/\[0\] line 0$/m);
  });
});

describe("unmapped log", () => {
  it("keeps short nouns the engine lacks and drops notes and vocabulary names", () => {
    expect(
      cleanUnmapped([
        "Lighthouse Beam",
        "rooftop",
        "rain",
        "storm cloud",
        "factory (lines 17, 20, 35; drawn as houses)",
        "figure's long shadow stretching across the whole empty road at night",
        "barrel (line 12)",
        "lighthouse beam",
        "river",
      ]),
    ).toEqual(["lighthouse beam", "storm cloud", "factory", "barrel"]);
  });
});

describe("missing lines", async () => {
  const { missingLines } = await import("./pipeline");
  it("lists the line indices with no moment", () => {
    expect(missingLines([{ line: 0 }, { line: 2 }, { line: 2 }], 5)).toEqual([1, 3, 4]);
  });
});
