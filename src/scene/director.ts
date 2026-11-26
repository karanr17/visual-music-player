import { z } from "zod";
import {
  arr, isRec, normalizeCast, normalizeMoment, normalizeSprites, normalizeWorld, num, pick, type MomentOut,
} from "./normalize";
import { ModelOutput } from "./schema";
import { EVENTS, MOTIONS, PARTICLES, POSITIONS, SECTION_LABELS, SHOTS, STYLES, SUBJECTS, TRANSITIONS } from "./vocab";

// Two-pass generation. The director (a stronger model) reads the song and plans it: what it's
// about, how it develops, who is in it, the sections with their worlds, and a shot per line.
// The script pass (a cheaper model) turns that plan into the engine's moments. mergePasses
// combines them into the same ModelOutput the single-pass prompt produces.

const drawable = SUBJECTS.filter((s) => s !== "custom").join(", ");

export const DIRECTOR_PROMPT = `You are the director of a music visualizer. While a song plays, a small pixel-art engine draws what a listener might see in their mind. You don't draw; you read the song once and plan the film the engine will show.

Read for meaning and feeling, not keywords: metaphor, subtext, who is speaking to whom, what changes from the first verse to the last. "Drowning in you" is overwhelming love, not water. Upbeat production under sad words is bittersweet. Find the story if there is one, or the single image the song keeps circling if there isn't.

Write:
- logline: one sentence on what the song is about beneath its words.
- arc: two to four sentences on how the feeling moves through the song and how the pictures follow it: which places, light, time of day and weather carry each stage, and the one motif (an object, a gesture, a place) that returns and changes.
- style: one look for the whole song from its genre and mood: synthwave (80s/electronic/neon), lofi (chill/bedroom/hip-hop beats), noir (jazz/blues/smoky/dark pop), storybook (folk/acoustic/children's/whimsical), metal (rock/metal/aggressive), dream (shoegaze/ambient/ethereal), ukiyoe (calm, traditional, nature, East Asian), impressionist (romantic, classical, nostalgic, sunlit), watercolor (gentle, acoustic, tender), gameboy (playful, chiptune), nes (upbeat chiptune), comic (punk, hip-hop swagger, bold storytelling), natural (anything else).
- cast: lead is the singer or narrator ("I"), partner the person sung to or about, child any child. Read gender, age and look from the lyrics and artist when they say something; otherwise choose a look that fits the song's world. Skin, hair, top and bottom are hex colours; a dress uses the top colour.
- sections: contiguous and in order, together covering every line index from 0 to the last. Label each (intro, verse, pre_chorus, chorus, bridge, outro, instrumental) and give it a world (setting, timeOfDay, weather, mood, camera) that is the right place for that part of the song, and a transitionIn (how we arrive: time_shift or weather_shift within one place, pan_up/pan_down through the sky between places, pan_left/pan_right for a journey, zoom_in to go inward, dissolve for dreamlike shifts, flash for an explosive drop, fade_black for an ending or rupture). intent says in one sentence what the section shows and why.
- shots: for every line of a section, in order, a shot and a focus. wide shows the whole place with small figures (openings, a new world, loneliness, endings); medium frames people head to toe (the default); close fills the frame with one subject (a named object, a face-to-face line, the peak). Cut like an editor: establish wide, move in, save close for the lines that matter most, and don't stay close for long. focus names in a few words what the picture shows on that line, in things the engine can draw: ${drawable}. Name who is there and what they do ("the couple walking apart on the road", "a single candle by the window"), never text, facial expressions or abstract ideas.

Rules:
- Be literal where the lyrics are concrete: a song that names a sunflower, a ship or a phone shows that thing. Settings follow places the lyrics mention.
- If the prompt has an Audio section, follow it: every (instrumental) line starts its own section with a world of its own; sections over the same structure letter are the same music returning and get the same label and world (a chorus returns to its place); let the quiet parts be calm and wide and save the strongest images for the loudest parts. Its sound impressions are hints that are often wrong; the lyrics win.
- Vary the worlds across the song the way the feeling changes, but keep it one film: two to five distinct settings is usually right.
- Heavy themes (violence, drugs, self-harm, abuse, sex) are pictured through metaphor and atmosphere: storms, wilted flowers, chains, a lone figure, a fading light. Never literally.
- Lyrics may be in any language; interpret them in their own language.`;

export const SCRIPT_PROMPT = `You turn a director's plan into the moments a small pixel-art engine draws while a song plays. The director has already decided the sections, their worlds and a shot and focus for every line. Your job is to realise each focus with the engine's fixed vocabulary.

For every line index, write one moment:
- subjects: the full set visible during that line (not a diff), 0-4 of them; fewer is calmer. Keep subjects that should persist from the previous line so people don't pop in and out, add what the line introduces, drop what should leave. Realise the director's focus as closely as the vocabulary allows.
- position: left/center/right are on the ground, far is small in the distance, sky is up high, foreground is close and large. motion: walk, drift, sway, rise, fall, fly, spin or still.
- focus: true on exactly one subject when the director's focus points at something in particular (it is lit from behind and fills a close shot); false everywhere else, and on all subjects of a purely atmospheric line.
- Figures are the song's cast: single figures (lone_figure, walking_figure, sitting_figure, reaching_figure, dancer, figure_with_umbrella) are the lead, couples are lead and partner, child is the child.
- road and river run into the distance: walk or drift there means travelling along them. An empty road reads as the view from a moving car; a car on it means driving.
- particles add atmosphere for that line; event is a one-shot accent (use sparingly, for the strongest lines). intensity 0-1 is how charged the line is.
- When the focus names something the vocabulary lacks, pick the closest drawable picture and add the missing thing (a short noun phrase, e.g. "lighthouse beam", "broken mirror") to unmapped.
- Only for a small prop that is central to the song and missing from the vocabulary (a ring, a key on a chain, a paper boat) you may draw a sprite: at most 2 per song, 8-16 pixels on each side, a palette of 3-6 hex colours with a dark outline first, rows of equal length where "." is transparent and digits index the palette. Use it with kind "custom" and custom set to its name; for every other subject custom is "". Previously drawn sprites listed in the prompt can be reused the same way.`;

const World = ModelOutput.shape.sections.element.shape.world;
const Cast = ModelOutput.shape.cast;

export const DirectorNotes = z.object({
  logline: z.string(),
  arc: z.string(),
  style: z.enum(STYLES),
  cast: Cast,
  sections: z.array(
    z.object({
      label: z.enum(SECTION_LABELS),
      fromLine: z.number().int(),
      toLine: z.number().int(),
      world: World,
      transitionIn: z.enum(TRANSITIONS),
      intent: z.string(),
      shots: z.array(z.object({ line: z.number().int(), shot: z.enum(SHOTS), focus: z.string() })),
    }),
  ),
});
export type DirectorNotes = z.infer<typeof DirectorNotes>;

const Subject = z.object({
  kind: z.enum(SUBJECTS),
  custom: z.string(),
  position: z.enum(POSITIONS),
  motion: z.enum(MOTIONS),
  focus: z.boolean(),
});

export const ScriptPass = z.object({
  moments: z.array(
    z.object({
      line: z.number().int(),
      subjects: z.array(Subject),
      particles: z.enum(PARTICLES),
      event: z.enum(EVENTS),
      intensity: z.number(),
    }),
  ),
  sprites: ModelOutput.shape.sprites,
  unmapped: z.array(z.string()),
});
export type ScriptPass = z.infer<typeof ScriptPass>;

// Structured-output schemas reject numeric bounds; enums stay real so the vocabulary is enforced.
function forModel(schema: z.ZodType): Record<string, unknown> {
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
  return strip(z.toJSONSchema(schema)) as Record<string, unknown>;
}

export const directorJsonSchema = () => forModel(DirectorNotes);
export const scriptJsonSchema = () => forModel(ScriptPass);

const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");

// Tolerant like normalizeOutput: near-miss values are repaired, impossible ones reported, and
// sections are clamped to the song's lines and put in order.
export function normalizeDirector(raw: unknown, lineCount: number): { notes: DirectorNotes; misses: string[] } {
  const misses: string[] = [];
  const r = isRec(raw) ? raw : {};
  const last = Math.max(0, lineCount - 1);
  const clampLine = (v: unknown, d: number) => Math.max(0, Math.min(last, Math.round(num(v, d))));
  const sections = arr(r.sections)
    .filter(isRec)
    .map((s) => {
      const fromLine = clampLine(s.fromLine, 0);
      const toLine = Math.max(fromLine, clampLine(s.toLine, fromLine));
      return {
        label: pick(SECTION_LABELS, s.label, "verse", misses),
        fromLine,
        toLine,
        world: normalizeWorld(s.world, misses),
        transitionIn: pick(TRANSITIONS, s.transitionIn, "dissolve", misses),
        intent: str(s.intent),
        shots: arr(s.shots)
          .filter(isRec)
          .map((x) => ({ line: Math.round(num(x.line, -1)), shot: pick(SHOTS, x.shot, "medium", misses), focus: str(x.focus) }))
          .filter((x) => x.line >= fromLine && x.line <= toLine),
      };
    })
    .sort((a, b) => a.fromLine - b.fromLine)
    .filter((s, i, all) => i === 0 || s.fromLine > all[i - 1].fromLine);
  if (!sections.length) throw new Error("Director's notes had no sections");
  sections[0].fromLine = 0;
  return {
    notes: { logline: str(r.logline), arc: str(r.arc), style: pick(STYLES, r.style, "natural", misses), cast: normalizeCast(r.cast, misses), sections },
    misses,
  };
}

export function normalizeScript(raw: unknown, librarySprites: string[] = []): { script: ScriptPass & { moments: MomentOut[] }; misses: string[] } {
  const misses: string[] = [];
  const r = isRec(raw) ? raw : {};
  const sprites = normalizeSprites(r.sprites).slice(0, 2);
  const known = new Set([...sprites.map((s) => s.name), ...librarySprites]);
  const moments = arr(r.moments).filter(isRec).map((m) => normalizeMoment(m, known, misses));
  const unmapped = arr(r.unmapped).filter((u): u is string => typeof u === "string");
  return { script: { moments, sprites, unmapped: [...unmapped, ...misses] }, misses };
}

// The director owns the structure (sections, worlds, transitions, shots, style, cast); the script
// pass owns what is in each picture. A line the script pass skipped keeps the previous line's
// subjects, so the director's shot change on it still happens.
export function mergePasses(notes: DirectorNotes, script: ScriptPass & { moments: MomentOut[] }): ModelOutput {
  const byLine = new Map<number, MomentOut>();
  for (const m of script.moments) if (!byLine.has(m.line)) byLine.set(m.line, m);
  const sections = notes.sections.map((s, i) => {
    const end = i + 1 < notes.sections.length ? notes.sections[i + 1].fromLine - 1 : s.toLine;
    const shots = new Map(s.shots.map((x) => [x.line, x.shot]));
    const moments: MomentOut[] = [];
    let prev = null as MomentOut | null;
    for (let line = s.fromLine; line <= Math.max(s.toLine, end); line++) {
      const m: MomentOut | null = byLine.get(line) ?? (prev ? { ...prev, event: "none" as const } : null);
      if (!m) continue;
      const shot = shots.get(line) ?? m.shot;
      moments.push({ ...m, line, shot });
      prev = m;
    }
    return { label: s.label, fromLine: s.fromLine, toLine: Math.max(s.toLine, end), world: s.world, transitionIn: s.transitionIn, moments };
  });
  return { style: notes.style, cast: notes.cast, sections, sprites: script.sprites, unmapped: script.unmapped };
}

// The plan as the script pass reads it.
export function renderNotes(notes: DirectorNotes, lines: { t: number; text: string }[]): string {
  const out = [`Director's plan`, `Logline: ${notes.logline}`, `Arc: ${notes.arc}`, ""];
  for (const s of notes.sections) {
    const w = s.world;
    out.push(`Section ${s.label}, lines ${s.fromLine}-${s.toLine}: ${w.setting}, ${w.timeOfDay}, ${w.weather}, ${w.mood}. ${s.intent}`);
    const shots = new Map(s.shots.map((x) => [x.line, x]));
    for (let l = s.fromLine; l <= s.toLine; l++) {
      const sh = shots.get(l);
      out.push(`  [${l}] ${lines[l]?.text ?? ""}${sh ? `  →  ${sh.shot}: ${sh.focus}` : ""}`);
    }
  }
  return out.join("\n");
}
