import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { SceneScript } from "../scene/schema";
import { Director } from "./director";
import { unpack } from "./fb";
import { worldParams } from "./palette";
import { matchPlates, PLATE_H, PLATE_W, PlateSet, quantizePlate, type DecodedPlates, type PlateImage } from "./plates";

const script = JSON.parse(readFileSync(join(__dirname, "../../docs/demo/unbury-your-heart.scene.json"), "utf8")) as SceneScript;
const PNG = "data:image/png;base64,AA==";

// Far layer: a sky band cut out above a hill line; near layer: the bottom third.
function synthetic(): PlateImage {
  const far = new Uint8ClampedArray(PLATE_W * PLATE_H * 4);
  const near = new Uint8ClampedArray(PLATE_W * PLATE_H * 4);
  for (let y = 0; y < PLATE_H; y++) {
    for (let x = 0; x < PLATE_W; x++) {
      const i = (y * PLATE_W + x) * 4;
      const hill = 90 + 12 * Math.sin(x / 30);
      if (y > hill) far.set([60 + x / 4, 120, 80 + y / 3, 255], i);
      if (y > 150) near.set([140, 90 + (x % 40), 40, 255], i);
    }
  }
  return { layers: [far, near] };
}

function plateSet(): DecodedPlates {
  const set: PlateSet = {
    version: 1,
    trackKey: script.trackKey,
    model: "test",
    width: PLATE_W,
    height: PLATE_H,
    plates: { p1: { prompt: "x", seed: 1, layers: [PNG, PNG] } },
    sections: script.sections.map((s) => ({ setting: s.world.setting, prompt: s.world.plate ?? "", plate: "p1" })),
  };
  return { set, images: new Map([["p1", synthetic()]]) };
}

describe("plate sets", () => {
  it("parse with the generator's shape", () => {
    expect(PlateSet.safeParse(plateSet().set).success).toBe(true);
    expect(PlateSet.safeParse({ ...plateSet().set, width: 320 }).success).toBe(false);
  });

  it("match a script by track, setting and plate prompt", () => {
    const { set } = plateSet();
    expect(matchPlates(set, script).every((id) => id === "p1")).toBe(true);
    expect(matchPlates({ ...set, trackKey: "other" }, script).every((id) => id === null)).toBe(true);
    const edited = structuredClone(script);
    edited.sections[2].world.plate = "a different place";
    edited.sections[3].world.setting = "road";
    const ids = matchPlates(set, edited);
    expect(ids[2]).toBeNull();
    expect(ids[3]).toBeNull();
    expect(ids[4]).toBe("p1");
  });
});

describe("quantising", () => {
  const params = worldParams(script.sections[0].world);
  const q = quantizePlate("p1", synthetic(), params);

  it("keeps transparency and uses only a few colours from the world's palette", () => {
    expect(q.layers[0][10 * PLATE_W + 10]).toBe(0);
    const used = new Set(q.layers.flatMap((l) => [...l]).filter((v) => v));
    expect(used.size).toBeGreaterThan(3);
    expect(used.size).toBeLessThanOrEqual(15);
  });

  it("re-tones the same plate for another time of day", () => {
    const night = quantizePlate("p1", synthetic(), worldParams({ ...script.sections[0].world, timeOfDay: "night" }));
    const lum = (layers: Uint32Array[]) => {
      let s = 0;
      let n = 0;
      for (const v of layers[1]) if (v) (s += unpack(v).reduce((a, b) => a + b), n++);
      return s / n;
    };
    expect(lum(night.layers)).toBeLessThan(lum(q.layers));
  });
});

describe("illustrated rendering", () => {
  const frame = (d: Director, t: number) => Buffer.from(d.frame(t, { energy: 0.5, onset: 0 }).data.buffer);

  it("draws the plate where a section has one and nothing changes without plates", () => {
    const plain = new Director(script, "natural");
    const lit = new Director(script, "natural");
    lit.setPlates(plateSet());
    expect(lit.platesShown).toBe(script.sections.length);
    expect(frame(lit, 40).equals(frame(plain, 40))).toBe(false);
    lit.setPlates(null);
    expect(frame(lit, 40.5).equals(frame(new Director(script, "natural"), 40.5))).toBe(true);
  });

  it("renders the same pixels at t whether it played up to t or jumped there", () => {
    const t = 33.4;
    const played = new Director(script, "lofi");
    played.setPlates(plateSet());
    for (let x = 30; x < t; x += 1 / 12) played.frame(x, { energy: 0.5, onset: 0 });
    const a = frame(played, t);
    const jumped = new Director(script, "lofi");
    jumped.setPlates(plateSet());
    expect(frame(jumped, t).equals(a)).toBe(true);
  });
});
