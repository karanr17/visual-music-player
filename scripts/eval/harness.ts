import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { runClaude } from "../../bridge/claude-cli";
import { SongAnalysis } from "../../src/analysis/schema";
import type { Track } from "../../src/library/library";
import { parseLrc, type Lyrics } from "../../src/lyrics/lyrics";
import type { ModelCaller } from "../../src/scene/interpret";
import { cleanUnmapped } from "../../src/scene/director";
import { compileResult, runPipeline } from "../../src/scene/pipeline";
import type { SceneScript } from "../../src/scene/schema";

// Inputs live outside the repo (scripts/eval/prepare.sh builds them): per song an analysis.json
// and a lyrics.json of timed lines. Outputs (scripts, judge scores with their reasons) also stay
// outside the repo; `report` writes only the aggregate numbers into docs/eval/.

const DEFAULT_INPUTS = join(homedir(), "music-connector-eval-audio", "player-eval");
const SCRIPT_MODEL = "claude-haiku-5-5";
const DIRECTOR_MODEL = "claude-sonnet-5-5";
const JUDGE_MODEL = "claude-opus-5-5";
const HAND_TIMED: Record<string, string> = { "57378": "unbury-your-heart.lrc" };
const CRITERIA = ["fit", "structure", "variety", "render"] as const;
type Criterion = (typeof CRITERIA)[number];

interface Song {
  id: string;
  title: string;
  artist: string;
  analysis: SongAnalysis;
  lyrics: Lyrics;
}

interface CallLog {
  role: string;
  model: string;
  ms: number;
  costUsd?: number;
}

interface GenRecord {
  id: string;
  arm: string;
  script?: SceneScript;
  notes?: unknown;
  directorError?: string;
  error?: string;
  calls: CallLog[];
}

interface JudgeSample {
  scores: Record<Criterion, number>;
  reasons: Record<Criterion, string>;
  costUsd?: number;
}

type Loader = (path: string) => Promise<Record<string, any>>;

const fmt = (t: number) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, "0")}`;

function loadSongs(root: string, inputs: string): Song[] {
  const sources = new Map<string, { title: string; artist: string }>();
  for (const f of ["ccmixter/sources.json", "calibration/ccmixter/sources.json"]) {
    const p = join(inputs, "..", f);
    if (existsSync(p)) for (const s of JSON.parse(readFileSync(p, "utf8"))) sources.set(String(s.id ?? s.file?.match(/\d+/)?.[0]), { title: s.title, artist: s.artist });
  }
  const ids = readFileSync(join(root, "scripts/eval/songs.txt"), "utf8").split("\n").map((l) => l.trim().split(/\s+/)[0]).filter(Boolean);
  return ids.flatMap((id) => {
    const dir = join(inputs, id);
    if (!existsSync(join(dir, "analysis.json")) || !existsSync(join(dir, "lyrics.json"))) {
      console.warn(`skipping ${id}: inputs missing in ${dir}`);
      return [];
    }
    const analysis = SongAnalysis.parse(JSON.parse(readFileSync(join(dir, "analysis.json"), "utf8")));
    const meta = sources.get(id) ?? { title: id, artist: "" };
    // A hand-timed LRC beats the Whisper lines when there is one (the demo song has one).
    const lrc = join(root, "docs/demo", HAND_TIMED[id] ?? "-");
    const raw: { t: number; text: string }[] = JSON.parse(readFileSync(join(dir, "lyrics.json"), "utf8"));
    const lines = existsSync(lrc)
      ? parseLrc(readFileSync(lrc, "utf8"), analysis.source.durationS)
      : raw.map((l, i) => ({ t: l.t, end: raw[i + 1]?.t ?? l.t + 4, text: l.text, words: [] }));
    return [{ id, ...meta, analysis, lyrics: { lines, synced: true, source: "lrc-file" as const, instrumental: false } }];
  });
}

function trackOf(s: Song): Track {
  return { id: s.id, file: new File([], `${s.id}.mp3`), title: s.title, artist: s.artist, album: "", duration: s.analysis.source.durationS };
}

function caller(calls: CallLog[]): ModelCaller {
  return async (req, signal) => {
    const r = await runClaude({ system: req.system, prompt: req.prompt, schema: req.schema, model: req.model }, signal);
    calls.push({ role: req.system.startsWith("You are the director") ? "director" : "script", model: req.model, ms: r.ms, costUsd: r.costUsd });
    return { raw: r.output, provider: "claude" };
  };
}

// The single-pass pipeline exactly as the given checkout (e.g. main) has it.
async function legacyGenerate(load: Loader, song: Song, model: string, calls: CallLog[]): Promise<SceneScript> {
  const structure = await load("/src/analysis/structure.ts");
  const prompt = await load("/src/scene/prompt.ts");
  const normalize = await load("/src/scene/normalize.ts");
  const compile = await load("/src/scene/compile.ts");
  const { lines } = song.lyrics;
  const timeline = structure.buildTimeline(lines, song.analysis);
  const userPrompt = prompt.buildUserPrompt(trackOf(song), song.lyrics, null, "", [], false, { analysis: song.analysis, timeline });
  const r = await runClaude({ system: prompt.SYSTEM_PROMPT, prompt: userPrompt, schema: normalize.outputJsonSchema(), model });
  calls.push({ role: "single", model, ms: r.ms, costUsd: r.costUsd });
  const { output } = normalize.normalizeOutput(r.output, []);
  const lineTimes = timeline.map((l: { t: number }) => l.t);
  return compile.compile(output, lineTimes, song.analysis.source.durationS, song.id, "claude", {
    analysis: song.analysis,
    instrumental: timeline.map((l: { lyric: number | null }) => l.lyric === null),
  });
}

async function pool<T>(items: T[], n: number, fn: (x: T) => Promise<void>): Promise<void> {
  const queue = [...items];
  await Promise.all(Array.from({ length: n }, async () => {
    for (let x = queue.shift(); x !== undefined; x = queue.shift()) await fn(x);
  }));
}

async function generate(songs: Song[], out: string, arm: string, mode: string, a: Record<string, any>, baseline: Loader | null): Promise<void> {
  mkdirSync(join(out, arm), { recursive: true });
  await pool(songs, Number(a.concurrency), async (song) => {
    const file = join(out, arm, `${song.id}.json`);
    if (existsSync(file) && !JSON.parse(readFileSync(file, "utf8")).error) return;
    const rec: GenRecord = { id: song.id, arm, calls: [] };
    try {
      if (mode === "legacy") {
        if (!baseline) throw new Error("--mode legacy needs --baseline-root");
        rec.script = await legacyGenerate(baseline, song, a.model, rec.calls);
      } else {
        const result = await runPipeline(
          { track: trackOf(song), lyrics: song.lyrics, analysis: song.analysis, envelope: null, userDirection: "", librarySprites: [], image: null },
          { twoPass: mode === "two", model: a.model, directorModel: a.director, ollamaModel: "", ollamaDirectorModel: "" },
          caller(rec.calls),
          new AbortController().signal,
        );
        rec.script = compileResult(result, song.analysis.source.durationS, song.id);
        rec.notes = result.notes;
        rec.directorError = result.directorError;
      }
    } catch (err) {
      rec.error = err instanceof Error ? err.message : String(err);
    }
    writeFileSync(file, JSON.stringify(rec, null, 1));
    console.log(`${arm} ${song.id}: ${rec.error ? `error ${rec.error}` : `${rec.script!.sections.length} sections`} (${rec.calls.map((c) => `${c.role} ${(c.ms / 1000).toFixed(0)}s`).join(", ")})`);
  });
}

// --- Judging ---

const JUDGE_SCHEMA = {
  type: "object",
  properties: Object.fromEntries(
    CRITERIA.map((c) => [c, { type: "object", properties: { reason: { type: "string" }, score: { type: "integer" } }, required: ["reason", "score"], additionalProperties: false }]),
  ),
  required: [...CRITERIA],
  additionalProperties: false,
};

// What the judge sees: the song's lines and structure, then the script as a shot list. Nothing
// says which pipeline wrote it.
export function describeForJudge(song: Song, script: SceneScript): string {
  const lines = song.lyrics.lines;
  const parts = song.analysis.segments.map((s) => `${fmt(s.start)}-${fmt(s.end)} ${s.label} (energy ${s.energy.toFixed(2)})`).join("; ");
  const out = [
    `Song: "${song.title}" by ${song.artist}, ${fmt(song.analysis.source.durationS)}, about ${Math.round(song.analysis.tempo.bpm)} BPM.`,
    `Structure (same letter = the same music returning, ′ = a variation): ${parts}`,
    "",
    "Lines (time, text):",
    ...lines.map((l) => `${fmt(l.t)} ${l.text}`),
    "",
    `Scene script. Look: ${script.style}.`,
  ];
  if (script.cast) {
    const p = (a: NonNullable<SceneScript["cast"]>["lead"]) => `${a.age} ${a.gender}, ${a.hairStyle} hair, ${a.outfit}`;
    out.push(`Cast: lead (the singer) ${p(script.cast.lead)}; partner ${p(script.cast.partner)}.`);
  }
  for (const s of script.sections) {
    const w = s.world;
    out.push("", `Section ${s.label} ${fmt(s.start)}-${fmt(s.end)}${s.recurrence ? ` over part ${s.recurrence}` : ""}: ${w.setting}, ${w.timeOfDay}, ${w.weather}, mood ${w.mood}, camera ${w.camera}; arrives by ${s.transitionIn}.`);
    for (const m of s.moments) {
      const line = [...lines].reverse().find((l) => l.t <= m.t + 0.05);
      const text = line && Math.abs(line.t - m.t) < 0.6 ? `"${line.text}"` : "(no singing)";
      const subjects = m.subjects.length
        ? m.subjects.map((x) => `${x.kind === "custom" ? `drawn sprite ${x.custom}` : x.kind} ${x.position} ${x.motion}${x.focus ? " [focus]" : ""}`).join(", ")
        : "nothing in particular";
      const extra = [m.particles !== "none" ? `particles ${m.particles}` : "", m.event !== "none" ? `event ${m.event}` : ""].filter(Boolean).join(", ");
      out.push(`  ${fmt(m.t)} ${text} → ${m.shot ?? "medium"}: ${subjects}${extra ? `; ${extra}` : ""}`);
    }
  }
  if (script.unmapped.length) out.push("", `Concepts the script couldn't show: ${script.unmapped.join(", ")}`);
  return out.join("\n");
}

async function judge(songs: Song[], out: string, arm: string, root: string, a: Record<string, any>): Promise<void> {
  const rubric = readFileSync(join(root, "docs/eval/rubric.md"), "utf8");
  const system = `You evaluate scene scripts for a music visualizer against this rubric. Be strict and consistent: use the whole scale, and judge only what the script will show.\n\n${rubric}`;
  const jobs = songs.flatMap((song) => Array.from({ length: Number(a.samples) }, (_, k) => ({ song, k })));
  await pool(jobs, Number(a.concurrency), async ({ song, k }) => {
    const gen = join(out, arm, `${song.id}.json`);
    const file = join(out, arm, `${song.id}.judge${k}.json`);
    if (!existsSync(gen) || existsSync(file)) return;
    const rec: GenRecord = JSON.parse(readFileSync(gen, "utf8"));
    if (!rec.script) return;
    const r = await runClaude({ system, prompt: describeForJudge(song, rec.script), schema: JUDGE_SCHEMA, model: a.judge });
    const o = r.output as Record<Criterion, { reason: string; score: number }>;
    const sample: JudgeSample = {
      scores: Object.fromEntries(CRITERIA.map((c) => [c, Math.max(1, Math.min(10, o[c].score))])) as Record<Criterion, number>,
      reasons: Object.fromEntries(CRITERIA.map((c) => [c, o[c].reason])) as Record<Criterion, string>,
      costUsd: r.costUsd,
    };
    writeFileSync(file, JSON.stringify(sample, null, 1));
    console.log(`judge ${arm} ${song.id} #${k}: ${CRITERIA.map((c) => `${c} ${sample.scores[c]}`).join(" ")}`);
  });
}

// --- Report ---

const mean = (xs: number[]) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : NaN);
const sd = (xs: number[]) => {
  const m = mean(xs);
  return xs.length > 1 ? Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1)) : 0;
};

// Cheap, judge-free numbers from the compiled script.
export function scriptMetrics(script: SceneScript) {
  const moments = script.sections.flatMap((s) => s.moments);
  const shots = moments.map((m) => m.shot ?? "medium");
  let runs = 0;
  for (let i = 1; i < shots.length; i++) if (shots[i] !== shots[i - 1]) runs++;
  return {
    sections: script.sections.length,
    settings: new Set(script.sections.map((s) => s.world.setting)).size,
    emptyMoments: moments.filter((m) => !m.subjects.length).length / Math.max(1, moments.length),
    subjectsPerMoment: mean(moments.map((m) => m.subjects.length)),
    shotChanges: runs / Math.max(1, moments.length - 1),
    closeShare: shots.filter((s) => s === "close").length / Math.max(1, shots.length),
    unmapped: script.unmapped.length,
    sprites: (script.sprites ?? []).length,
  };
}

function report(songs: Song[], out: string, arms: string[], root: string): void {
  const result: Record<string, unknown> = {};
  const rows: string[] = [];
  for (const arm of arms) {
    const perSong: Record<string, unknown> = {};
    const crit: Record<Criterion, number[]> = { fit: [], structure: [], variety: [], render: [] };
    const totals: number[] = [];
    // Judge variance: the spread between the two samples of the same script.
    const sampleGaps: number[] = [];
    const metrics: ReturnType<typeof scriptMetrics>[] = [];
    let failures = 0;
    let directorFallbacks = 0;
    const costs: number[] = [];
    const secs: number[] = [];
    for (const song of songs) {
      const gen = join(out, arm, `${song.id}.json`);
      if (!existsSync(gen)) continue;
      const rec: GenRecord = JSON.parse(readFileSync(gen, "utf8"));
      if (!rec.script) {
        failures++;
        continue;
      }
      if (rec.directorError) directorFallbacks++;
      costs.push(rec.calls.reduce((s, c) => s + (c.costUsd ?? 0), 0));
      secs.push(rec.calls.reduce((s, c) => s + c.ms, 0) / 1000);
      const m = scriptMetrics(rec.script);
      metrics.push(m);
      const samples: JudgeSample[] = [];
      for (let k = 0; existsSync(join(out, arm, `${song.id}.judge${k}.json`)); k++) samples.push(JSON.parse(readFileSync(join(out, arm, `${song.id}.judge${k}.json`), "utf8")));
      const songScores = Object.fromEntries(CRITERIA.map((c) => [c, samples.map((s) => s.scores[c])]));
      for (const c of CRITERIA) crit[c].push(...samples.map((s) => s.scores[c]));
      const sampleTotals = samples.map((s) => mean(CRITERIA.map((c) => s.scores[c])));
      totals.push(mean(sampleTotals));
      if (sampleTotals.length > 1) sampleGaps.push(Math.max(...sampleTotals) - Math.min(...sampleTotals));
      perSong[song.id] = { scores: songScores, metrics: m };
    }
    const agg = {
      songs: totals.length,
      failures,
      directorFallbacks,
      judge: Object.fromEntries(CRITERIA.map((c) => [c, { mean: +mean(crit[c]).toFixed(2), sd: +sd(crit[c]).toFixed(2) }])),
      overall: { mean: +mean(totals).toFixed(2), sdAcrossSongs: +sd(totals).toFixed(2), meanSampleGap: +mean(sampleGaps).toFixed(2) },
      metrics: Object.fromEntries(Object.keys(metrics[0] ?? {}).map((k) => [k, +mean(metrics.map((m) => m[k as keyof typeof m])).toFixed(2)])),
      apiEquivalentUsdPerSong: +mean(costs).toFixed(3),
      secondsPerSong: +mean(secs).toFixed(1),
    };
    result[arm] = { ...agg, perSong };
    const j = agg.judge as Record<Criterion, { mean: number; sd: number }>;
    rows.push(
      `| ${arm} | ${agg.overall.mean.toFixed(2)} ± ${agg.overall.meanSampleGap.toFixed(2)} | ${CRITERIA.map((c) => `${j[c].mean.toFixed(1)}`).join(" | ")} | ${agg.metrics.settings} | ${agg.metrics.shotChanges} | ${agg.metrics.emptyMoments} | ${agg.metrics.unmapped} | ${agg.secondsPerSong} | ${agg.apiEquivalentUsdPerSong} |`,
    );
  }
  writeFileSync(join(root, "docs/eval/results.json"), JSON.stringify(result, null, 1) + "\n");
  const table = [
    "| Pipeline | Overall (± judge gap) | Fit | Structure | Variety | Render | Settings | Shot changes | Empty moments | Unmapped | s / song | API-equiv $ / song |",
    "|---|---|---|---|---|---|---|---|---|---|---|---|",
    ...rows,
  ].join("\n");
  writeFileSync(join(root, "docs/eval/results.md"), table + "\n");
  console.log(table);
}

// --- Vocabulary roadmap input ---

function unmapped(songs: Song[], out: string, arms: string[]): void {
  const counts = new Map<string, number>();
  for (const arm of arms) {
    for (const song of songs) {
      const f = join(out, arm, `${song.id}.json`);
      if (!existsSync(f)) continue;
      const rec: GenRecord = JSON.parse(readFileSync(f, "utf8"));
      // Older runs predate cleanUnmapped; clean them the same way so the counts compare.
      for (const u of new Set(cleanUnmapped(rec.script?.unmapped ?? []))) counts.set(u, (counts.get(u) ?? 0) + 1);
    }
  }
  for (const [c, n] of [...counts].sort((x, y) => y[1] - x[1]).slice(0, 80)) console.log(`${n}\t${c}`);
}

export async function main(argv: string[], ctx: { root: string; baseline: Loader | null }): Promise<void> {
  const { positionals, values: a } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      arm: { type: "string" },
      arms: { type: "string" },
      mode: { type: "string", default: "two" },
      model: { type: "string", default: SCRIPT_MODEL },
      director: { type: "string", default: DIRECTOR_MODEL },
      judge: { type: "string", default: JUDGE_MODEL },
      samples: { type: "string", default: "2" },
      concurrency: { type: "string", default: "3" },
      inputs: { type: "string", default: DEFAULT_INPUTS },
      out: { type: "string" },
      only: { type: "string" },
      "baseline-root": { type: "string" },
    },
  });
  const out = a.out ?? join(a.inputs!, "runs");
  let songs = loadSongs(ctx.root, a.inputs!);
  if (a.only) songs = songs.filter((s) => a.only!.split(",").includes(s.id));
  const cmd = positionals[0];
  if (cmd === "generate") await generate(songs, out, a.arm!, a.mode!, a, ctx.baseline);
  else if (cmd === "judge") await judge(songs, out, a.arm!, ctx.root, a);
  else if (cmd === "report") report(songs, out, a.arms!.split(","), ctx.root);
  else if (cmd === "unmapped") unmapped(songs, out, a.arms!.split(","));
  else throw new Error(`unknown command ${cmd}: generate | judge | report | unmapped`);
}
