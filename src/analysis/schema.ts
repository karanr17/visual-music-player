import { z } from "zod";

// Mirror of music-connector's SongAnalysis v1 (pydantic is the source of truth; the vendored
// JSON Schema in schema/ is checked against this by src/analysis/schema.test.ts).
// Minor versions only add optional fields, and z.object strips unknown keys, so any 1.x file parses.

export const SUPPORTED_MAJOR = 1;

const Descriptor = z.object({
  label: z.string(),
  cos: z.number(),
  z: z.number(),
});

const Descriptors = z.record(z.string(), z.array(Descriptor));

const Analyzer = z.object({
  name: z.literal("music-connector").optional(),
  version: z.string(),
  model: z.string(),
  calibration: z.string(),
});

const Source = z.object({
  sha256: z.string(),
  fileName: z.string().nullable().optional(),
  durationS: z.number(),
  sampleRate: z.number().int(),
});

const Tempo = z.object({
  bpm: z.number(),
  confidence: z.number().min(0).max(1),
  beatsPerBar: z.number().int().optional(),
});

const Energy = z.object({
  frameRate: z.number(),
  loudnessDb: z.number(),
  rms: z.array(z.number()),
  low: z.array(z.number()),
  mid: z.array(z.number()),
  high: z.array(z.number()),
});

const Segment = z.object({
  start: z.number(),
  end: z.number(),
  label: z.string(),
  group: z.string(),
  variant: z.number().int().optional(),
  similarity: z.number().nullable().optional(),
  boundaryStrength: z.number().min(0).max(1),
  energy: z.number().min(0).max(1),
  descriptors: Descriptors.optional(),
});

const Windows = z.object({
  windowS: z.number(),
  hopS: z.number(),
  starts: z.array(z.number()),
  descriptors: z.array(Descriptors),
});

const NearestSong = z.object({
  songId: z.number().int(),
  title: z.string(),
  artist: z.string().nullable(),
  cosine: z.number(),
});

export const SongAnalysis = z.object({
  schemaVersion: z.string().regex(/^1\.\d+$/),
  analyzer: Analyzer,
  source: Source,
  tempo: Tempo,
  beats: z.array(z.number()),
  downbeats: z.array(z.number()),
  onsets: z.array(z.number()),
  energy: Energy,
  segments: z.array(Segment),
  descriptors: Descriptors,
  windows: Windows.nullable().optional(),
  nearest: z.array(NearestSong).nullable().optional(),
});

export type SongAnalysis = z.infer<typeof SongAnalysis>;
export type AnalysisSegment = z.infer<typeof Segment>;
export type AnalysisDescriptor = z.infer<typeof Descriptor>;
