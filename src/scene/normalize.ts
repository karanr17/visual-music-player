import { z } from "zod";
import { ModelOutput, type AppearanceSpec, type CastSpec } from "./schema";
import {
  AGES, CAMERAS, EVENTS, GENDERS, HAIRSTYLES, MOODS, MOTIONS, OUTFITS, PARTICLES, POSITIONS, SECTION_LABELS,
  SETTINGS, SHOTS, STYLES, SUBJECTS, TIMES, TRANSITIONS, WEATHERS,
} from "./vocab";

// JSON schema for structured outputs, built by hand from the zod schema. The SDK's zod
// helper rewrites `enum` into description text, which would leave the vocabulary unenforced;
// here enums stay real and only the keywords the API rejects are stripped.
export function outputJsonSchema(): Record<string, unknown> {
  const strip = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(strip);
    if (!node || typeof node !== "object") return node;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node)) {
      if (k === "$schema" || k === "minimum" || k === "maximum" || k === "exclusiveMinimum" || k === "exclusiveMaximum") continue;
      out[k] = strip(v);
    }
    return out;
  };
  return strip(z.toJSONSchema(ModelOutput)) as Record<string, unknown>;
}

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => !!v && typeof v === "object" && !Array.isArray(v);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const num = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) ? v : Number.isFinite(Number(v)) && v !== "" && v !== null ? Number(v) : d);

// Accepts near-misses ("Night", "night sky", "pan-up") before falling back to a default, and
// reports what it couldn't place so it lands in the unmapped log instead of failing the song.
function pick<T extends string>(allowed: readonly T[], v: unknown, fallback: T, misses: string[]): T {
  if (typeof v !== "string") return fallback;
  const norm = v.trim().toLowerCase().replace(/[\s-]+/g, "_");
  if ((allowed as readonly string[]).includes(norm)) return norm as T;
  // The longest match wins, so "lighthouse_beam" becomes a lighthouse, not a house.
  const partial = allowed.filter((a) => norm.includes(a) || a.includes(norm)).sort((x, y) => y.length - x.length)[0];
  if (partial && norm.length >= 3) return partial;
  misses.push(v.trim().toLowerCase());
  return fallback;
}

const HEX = /^#?([0-9a-f]{6}|[0-9a-f]{3})$/i;
const MAX_SPRITE = 48;

export const spriteName = (s: string) => s.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");

// Sprites arrive as free-form text; anything unusable is dropped, not rendered as garbage.
function normalizeSprites(v: unknown): ModelOutput["sprites"] {
  const out: ModelOutput["sprites"] = [];
  for (const sp of arr(v).filter(isRec)) {
    const name = spriteName(String(sp.name ?? ""));
    const palette = arr(sp.palette)
      .map((c) => String(c).trim())
      .filter((c) => HEX.test(c))
      .map((c) => (c.startsWith("#") ? c : `#${c}`))
      .slice(0, 10);
    let rows = arr(sp.rows).map((r) => String(r)).slice(0, MAX_SPRITE);
    const width = Math.min(MAX_SPRITE, Math.max(0, ...rows.map((r) => r.length)));
    rows = rows.map((r) => r.slice(0, width).padEnd(width, "."));
    const inked = rows.join("").replace(/\./g, "").length;
    if (!name || !palette.length || width < 4 || rows.length < 4 || inked < 6) continue;
    if (out.some((o) => o.name === name)) continue;
    out.push({ name, palette, rows });
  }
  return out.slice(0, 8);
}

// Used when a script predates the cast or the model's cast is unusable.
export const DEFAULT_CAST: CastSpec = {
  lead: { gender: "female", age: "adult", skin: "#c68a64", hair: "#2b1d16", hairStyle: "long", top: "#d9a441", bottom: "#3b4a6b", outfit: "pants" },
  partner: { gender: "male", age: "adult", skin: "#e0b08a", hair: "#4a2f1d", hairStyle: "short", top: "#3f6f9f", bottom: "#2d2d38", outfit: "pants" },
  child: { gender: "neutral", age: "child", skin: "#d9a07a", hair: "#6b4226", hairStyle: "curly", top: "#d9534f", bottom: "#3b5b8a", outfit: "shorts" },
};

const hex = (v: unknown, d: string) => {
  const s = String(v ?? "").trim();
  return HEX.test(s) ? (s.startsWith("#") ? s : `#${s}`) : d;
};

function normalizeAppearance(v: unknown, d: AppearanceSpec, misses: string[]): AppearanceSpec {
  const a = isRec(v) ? v : {};
  return {
    gender: pick(GENDERS, a.gender, d.gender, misses),
    age: pick(AGES, a.age, d.age, misses),
    skin: hex(a.skin, d.skin),
    hair: hex(a.hair, d.hair),
    hairStyle: pick(HAIRSTYLES, a.hairStyle, d.hairStyle, misses),
    top: hex(a.top, d.top),
    bottom: hex(a.bottom, d.bottom),
    outfit: pick(OUTFITS, a.outfit, d.outfit, misses),
  };
}

export function normalizeCast(v: unknown, misses: string[] = []): CastSpec {
  const c = isRec(v) ? v : {};
  return {
    lead: normalizeAppearance(c.lead, DEFAULT_CAST.lead, misses),
    partner: normalizeAppearance(c.partner, DEFAULT_CAST.partner, misses),
    child: normalizeAppearance(c.child, DEFAULT_CAST.child, misses),
  };
}

export function normalizeWorld(v: unknown, misses: string[]): ModelOutput["sections"][number]["world"] {
  const w = isRec(v) ? v : {};
  return {
    setting: pick(SETTINGS, w.setting, "field", misses),
    timeOfDay: pick(TIMES, w.timeOfDay, "night", misses),
    weather: pick(WEATHERS, w.weather, "clear", misses),
    mood: pick(MOODS, w.mood, "serene", misses),
    camera: pick(CAMERAS, w.camera, "drift", misses),
  };
}

export type MomentOut = ModelOutput["sections"][number]["moments"][number];

// `known`: sprite names a "custom" subject may refer to.
export function normalizeMoment(m: Rec, known: Set<string>, misses: string[]): MomentOut {
  return {
    line: Math.round(num(m.line, 0)),
    shot: pick(SHOTS, m.shot, "medium", misses),
    subjects: arr(m.subjects)
      .filter(isRec)
      .flatMap((x) => {
        const before = misses.length;
        const kind = pick(SUBJECTS, x.kind, "lone_figure", misses);
        // An unknown subject is dropped rather than silently turned into a figure.
        if (misses.length > before) return [];
        const custom = kind === "custom" ? spriteName(String(x.custom ?? "")) : "";
        if (kind === "custom" && !known.has(custom)) {
          if (custom) misses.push(custom);
          return [];
        }
        return [{ kind, custom, position: pick(POSITIONS, x.position, "center", misses), motion: pick(MOTIONS, x.motion, "still", misses), focus: x.focus === true }];
      }),
    particles: pick(PARTICLES, m.particles, "none", misses),
    event: pick(EVENTS, m.event, "none", misses),
    intensity: Math.max(0, Math.min(1, num(m.intensity, 0.5))),
  };
}

export { isRec, arr, num, pick, normalizeSprites };

// librarySprites: names of previously drawn sprites the model may reuse without redrawing.
export function normalizeOutput(raw: unknown, librarySprites: string[] = []): { output: ModelOutput; repaired: string[] } {
  const misses: string[] = [];
  const r = isRec(raw) ? raw : {};
  const sprites = normalizeSprites(r.sprites);
  const known = new Set([...sprites.map((s) => s.name), ...librarySprites]);
  const sections = arr(r.sections)
    .filter(isRec)
    .map((s) => ({
      label: pick(SECTION_LABELS, s.label, "verse", misses),
      fromLine: Math.round(num(s.fromLine, 0)),
      toLine: Math.round(num(s.toLine, num(s.fromLine, 0))),
      world: normalizeWorld(s.world, misses),
      transitionIn: pick(TRANSITIONS, s.transitionIn, "dissolve", misses),
      moments: arr(s.moments).filter(isRec).map((m) => normalizeMoment(m, known, misses)),
    }));
  if (!sections.length) throw new Error("Scene script had no sections");
  const unmapped = arr(r.unmapped).filter((u): u is string => typeof u === "string");
  return {
    output: { style: pick(STYLES, r.style, "natural", misses), cast: normalizeCast(r.cast, misses), sections, sprites, unmapped: [...unmapped, ...misses] },
    repaired: misses,
  };
}
