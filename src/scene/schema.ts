import { z } from "zod";
import {
  AGES, CAMERAS, EVENTS, GENDERS, HAIRSTYLES, MOODS, MOTIONS, OUTFITS, PARTICLES, POSITIONS, SECTION_LABELS,
  SETTINGS, SHOTS, STYLES, SUBJECTS, TIMES, TRANSITIONS, WEATHERS,
} from "./vocab";

// kind "custom" names a sprite the model drew (see sprites); "" otherwise.
const Subject = z.object({
  kind: z.enum(SUBJECTS),
  custom: z.string(),
  position: z.enum(POSITIONS),
  motion: z.enum(MOTIONS),
  focus: z.boolean(),
});

// Pixel art drawn by the model: each row is a string, "." transparent, digits index the palette.
const Sprite = z.object({
  name: z.string(),
  palette: z.array(z.string()),
  rows: z.array(z.string()),
});

// How a person in the song looks; colours are hex. Figures in every scene are drawn from this.
const Appearance = z.object({
  gender: z.enum(GENDERS),
  age: z.enum(AGES),
  skin: z.string(),
  hair: z.string(),
  hairStyle: z.enum(HAIRSTYLES),
  top: z.string(),
  bottom: z.string(),
  outfit: z.enum(OUTFITS),
});

// lead: the singer / narrator ("I"); partner: the other person ("you", "she", "he"); child: any child.
const Cast = z.object({ lead: Appearance, partner: Appearance, child: Appearance });

const World = z.object({
  setting: z.enum(SETTINGS),
  timeOfDay: z.enum(TIMES),
  weather: z.enum(WEATHERS),
  mood: z.enum(MOODS),
  camera: z.enum(CAMERAS),
});

// What the model returns. Every field is required (no optionals) so structured outputs
// can't silently omit something; "none" values carry absence instead.
export const ModelOutput = z.object({
  style: z.enum(STYLES),
  cast: Cast,
  sections: z.array(
    z.object({
      label: z.enum(SECTION_LABELS),
      fromLine: z.number().int(),
      toLine: z.number().int(),
      world: World,
      transitionIn: z.enum(TRANSITIONS),
      moments: z.array(
        z.object({
          line: z.number().int(),
          shot: z.enum(SHOTS),
          subjects: z.array(Subject),
          particles: z.enum(PARTICLES),
          event: z.enum(EVENTS),
          intensity: z.number(),
        }),
      ),
    }),
  ),
  sprites: z.array(Sprite),
  unmapped: z.array(z.string()),
});
export type ModelOutput = z.infer<typeof ModelOutput>;

// Stored subjects tolerate the fields older cached scripts don't have.
const StoredSubject = Subject.extend({ custom: z.string().optional(), focus: z.boolean().optional() });

// shot is optional for scripts cached before it existed; the renderer defaults to medium.
const Moment = z.object({
  t: z.number(),
  shot: z.enum(SHOTS).optional(),
  subjects: z.array(StoredSubject),
  particles: z.enum(PARTICLES),
  event: z.enum(EVENTS),
  intensity: z.number().min(0).max(1),
});

export const SceneScript = z.object({
  version: z.literal(1),
  trackKey: z.string(),
  source: z.enum(["claude", "ollama", "ambient", "manual"]),
  style: z.enum(STYLES),
  sections: z
    .array(
      z.object({
        label: z.enum(SECTION_LABELS),
        start: z.number(),
        end: z.number(),
        world: World,
        transitionIn: z.enum(TRANSITIONS),
        transitionDuration: z.number().min(0).max(8),
        moments: z.array(Moment),
        // Recurrence group from the audio analysis ("A", "B", …): sections that share one are the
        // same music, and the renderer lays out their world identically.
        recurrence: z.string().optional(),
      }),
    )
    .min(1),
  unmapped: z.array(z.string()),
  createdAt: z.number(),
  model: z.string().optional(),
  sprites: z.array(Sprite).optional(),
  cast: Cast.optional(),
  // The director pass's reading of the song, kept for the editor and for comparing runs.
  direction: z.object({ logline: z.string(), arc: z.string(), model: z.string() }).optional(),
});
export type SceneScript = z.infer<typeof SceneScript>;
export type Section = SceneScript["sections"][number];
export type WorldSpec = z.infer<typeof World>;
export type SubjectSpec = z.infer<typeof StoredSubject>;
export type SpriteSpec = z.infer<typeof Sprite>;
export type AppearanceSpec = z.infer<typeof Appearance>;
export type CastSpec = z.infer<typeof Cast>;
export type MomentSpec = z.infer<typeof Moment>;
