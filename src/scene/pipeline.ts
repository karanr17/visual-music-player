import type { SongAnalysis } from "../analysis/schema";
import { buildTimeline, segmentLines } from "../analysis/structure";
import type { Envelope } from "../audio/envelope";
import type { Track } from "../library/library";
import type { Lyrics } from "../lyrics/lyrics";
import { compile, pseudoLines, type CompileAudio } from "./compile";
import { DIRECTOR_PROMPT, directorJsonSchema, mergePasses, normalizeDirector, normalizeScript, renderNotes, SCRIPT_PROMPT, scriptJsonSchema, type DirectorNotes } from "./director";
import type { ImagePart, ModelCaller, ProviderName } from "./interpret";
import { normalizeOutput, outputJsonSchema } from "./normalize";
import { buildUserPrompt, SYSTEM_PROMPT, type AudioPromptInput } from "./prompt";
import type { ModelOutput, SceneScript } from "./schema";

export interface PipelineInput {
  track: Track;
  lyrics: Lyrics;
  analysis: SongAnalysis | null;
  envelope: Envelope | null;
  userDirection: string;
  librarySprites: string[];
  image: ImagePart | null;
}

export interface PipelineConfig {
  twoPass: boolean;
  // The script pass (and the single pass) runs on these; the director on the director models.
  model: string;
  directorModel: string;
  ollamaModel: string;
  ollamaDirectorModel: string;
}

export interface PreparedLines {
  // What the model numbers: lyric lines with instrumental markers, or time segments without lyrics.
  lines: { t: number; text: string }[];
  pseudo: { t: number; text: string }[] | null;
  audio: AudioPromptInput | null;
  compileAudio: CompileAudio | null;
}

export function prepareLines(lyrics: Lyrics, analysis: SongAnalysis | null, envelope: Envelope | null, duration: number): PreparedLines {
  const hasLyrics = lyrics.lines.length > 0;
  const timeline = hasLyrics && analysis ? buildTimeline(lyrics.lines, analysis) : null;
  const pseudo = hasLyrics ? null : analysis ? segmentLines(analysis) : pseudoLines(envelope, duration);
  const lines = timeline ?? pseudo ?? lyrics.lines;
  return {
    lines,
    pseudo,
    audio: analysis ? { analysis, timeline } : null,
    compileAudio: analysis ? { analysis, instrumental: lines.map((_, i) => timeline?.[i]?.lyric === null) } : null,
  };
}

export interface PipelineResult {
  output: ModelOutput;
  provider: ProviderName;
  notes: DirectorNotes | null;
  // Set when the director pass failed and the song fell back to a single pass.
  directorError?: string;
  prepared: PreparedLines;
}

const DIRECTOR_TOKENS = 16000;
const SCRIPT_TOKENS = 32000;

async function singlePass(input: PipelineInput, cfg: PipelineConfig, call: ModelCaller, signal: AbortSignal, prepared: PreparedLines, basePrompt: string) {
  const { raw, provider } = await call(
    { system: SYSTEM_PROMPT, prompt: basePrompt, schema: outputJsonSchema(), model: cfg.model, ollamaModel: cfg.ollamaModel, maxTokens: SCRIPT_TOKENS, image: input.image },
    signal,
  );
  const { output, repaired } = normalizeOutput(raw, input.librarySprites);
  if (repaired.length) console.warn("[scenes] values outside the vocabulary were replaced:", repaired);
  return { output, provider, notes: null, prepared };
}

export async function runPipeline(input: PipelineInput, cfg: PipelineConfig, call: ModelCaller, signal: AbortSignal): Promise<PipelineResult> {
  const prepared = prepareLines(input.lyrics, input.analysis, input.envelope, input.track.duration);
  const base = (library: string[]) => buildUserPrompt(input.track, input.lyrics, prepared.pseudo, input.userDirection, library, !!input.image, prepared.audio);
  if (!cfg.twoPass) return singlePass(input, cfg, call, signal, prepared, base(input.librarySprites));

  let notes: DirectorNotes;
  try {
    const { raw } = await call(
      {
        system: DIRECTOR_PROMPT,
        prompt: base([]),
        schema: directorJsonSchema(),
        model: cfg.directorModel,
        ollamaModel: cfg.ollamaDirectorModel || cfg.ollamaModel,
        maxTokens: DIRECTOR_TOKENS,
        image: input.image,
      },
      signal,
    );
    notes = normalizeDirector(raw, prepared.lines.length).notes;
  } catch (err) {
    if (signal.aborted) throw err;
    console.warn("[scenes] director pass failed; writing the script in one pass", err);
    return { ...(await singlePass(input, cfg, call, signal, prepared, base(input.librarySprites))), directorError: err instanceof Error ? err.message : String(err) };
  }

  const library = input.librarySprites.length
    ? `\n\nPreviously drawn sprites you can reuse with kind "custom": ${input.librarySprites.slice(0, 80).join(", ")}.`
    : "";
  const { raw, provider } = await call(
    {
      system: SCRIPT_PROMPT,
      prompt: `Title: ${input.track.title || "(unknown)"}\nArtist: ${input.track.artist || "(unknown)"}\n\n${renderNotes(notes, prepared.lines)}${library}\n\nWrite a moment for every line index from 0 to ${prepared.lines.length - 1}.`,
      schema: scriptJsonSchema(),
      model: cfg.model,
      ollamaModel: cfg.ollamaModel,
      maxTokens: SCRIPT_TOKENS,
    },
    signal,
  );
  const { script, misses } = normalizeScript(raw, input.librarySprites);
  if (misses.length) console.warn("[scenes] values outside the vocabulary were replaced:", misses);
  return { output: mergePasses(notes, script), provider, notes, prepared };
}

export function compileResult(r: PipelineResult, duration: number, trackKey: string): SceneScript {
  return compile(r.output, r.prepared.lines.map((l) => l.t), duration, trackKey, r.provider, r.prepared.compileAudio);
}
