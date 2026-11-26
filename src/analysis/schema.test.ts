import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { SongAnalysis } from "./schema";

const ROOT = join(__dirname, "../..");
const vendored = JSON.parse(readFileSync(join(ROOT, "schema/song-analysis.v1.schema.json"), "utf8"));

type Json = Record<string, any>;

interface Shape {
  type?: string;
  nullable?: boolean;
  props?: Record<string, Shape>;
  required?: string[];
  additional?: Shape;
  items?: Shape;
  minimum?: number;
  maximum?: number;
  pattern?: string;
  const?: unknown;
}

const SAFE = Number.MAX_SAFE_INTEGER;

// Reduces pydantic's and zod's JSON Schema dialects to the parts both sides must agree on:
// field names, which are required, types, nullability and bounds. Titles, descriptions and
// defaults differ by generator and are not part of the contract a reader depends on.
function shape(node: Json, defs: Json): Shape {
  if (node.$ref) return shape(defs[node.$ref.split("/").pop()], defs);
  if (node.anyOf) {
    const nonNull = node.anyOf.filter((n: Json) => n.type !== "null");
    if (nonNull.length !== 1) throw new Error(`unsupported anyOf: ${JSON.stringify(node.anyOf)}`);
    return { ...shape(nonNull[0], defs), nullable: true };
  }
  const out: Shape = {};
  let type = node.type;
  if (Array.isArray(type)) {
    out.nullable = type.includes("null");
    type = type.find((t: string) => t !== "null");
  }
  out.type = type;
  if (node.properties) {
    out.props = Object.fromEntries(Object.entries(node.properties).map(([k, v]) => [k, shape(v as Json, defs)]));
    out.required = [...(node.required ?? [])].sort();
  }
  if (node.additionalProperties && typeof node.additionalProperties === "object") out.additional = shape(node.additionalProperties, defs);
  if (node.items) out.items = shape(node.items, defs);
  if (node.minimum !== undefined && Math.abs(node.minimum) !== SAFE) out.minimum = node.minimum;
  if (node.maximum !== undefined && Math.abs(node.maximum) !== SAFE) out.maximum = node.maximum;
  if (node.pattern) out.pattern = node.pattern;
  if (node.const !== undefined) out.const = node.const;
  return out;
}

describe("SongAnalysis zod schema", () => {
  it("matches the vendored music-connector JSON Schema", () => {
    const fromZod = z.toJSONSchema(SongAnalysis, { io: "input" }) as Json;
    expect(shape(fromZod, fromZod.$defs ?? {})).toEqual(shape(vendored, vendored.$defs));
  });

  it("vendors a v1 schema", () => {
    expect(vendored.$id).toMatch(/song-analysis\.v1\.schema\.json$/);
    expect(vendored.properties.schemaVersion.pattern).toBe("^1\\.\\d+$");
  });

  const examples = join(ROOT, "public/analysis");
  for (const f of readdirSync(examples).filter((n) => n.endsWith(".analysis.json"))) {
    it(`parses ${f}`, () => {
      const data = JSON.parse(readFileSync(join(examples, f), "utf8"));
      const parsed = SongAnalysis.parse(data);
      expect(parsed.segments.length).toBeGreaterThan(0);
      expect(parsed.downbeats.length).toBeGreaterThan(0);
    });
  }

  it("ignores fields from a later minor version", () => {
    const data = JSON.parse(readFileSync(join(examples, "waking-me-softly.analysis.json"), "utf8"));
    const parsed = SongAnalysis.parse({ ...data, schemaVersion: "1.7", chords: [{ t: 0, name: "Am" }] });
    expect(parsed).not.toHaveProperty("chords");
  });

  it("rejects another major version", () => {
    const data = JSON.parse(readFileSync(join(examples, "waking-me-softly.analysis.json"), "utf8"));
    expect(SongAnalysis.safeParse({ ...data, schemaVersion: "2.0" }).success).toBe(false);
  });
});
