# Scene-script eval

Does planning a song with a director model before writing its scene script give better scenes?
This compares the single-pass prompt on `main` with the two-pass pipeline over two prompt
iterations, plus a single pass on the stronger model as an ablation. An LLM judge scores each
script against [rubric.md](rubric.md).

## Results

10 songs, 2 judge samples per script (Claude Opus 5.5 as judge). Scores are 1-10; "Overall" is
the mean of the four criteria; "± judge gap" is the mean difference between the two judge samples
of the same script, i.e. how much the judge disagrees with itself.

| Pipeline | Overall (± judge gap) | Fit | Structure | Variety | Render | Settings | Shot changes | Empty moments | Unmapped | s / song | API-equiv $ / song |
|---|---|---|---|---|---|---|---|---|---|---|---|
| baseline: `main`, one pass, Haiku 5.5 | 6.22 ± 0.35 | **6.5** | 6.0 | 5.5 | 6.8 | 3.8 | 0.66 | 0 | 1.3 | 96 | 0.013 |
| two-pass v1: Sonnet 5.5 director + Haiku 5.5 script | 6.16 ± 0.23 | 6.3 | 5.9 | 6.0 | 6.5 | 4.0 | 0.73 | 0.01 | 6.3 | 96 | 0.108 |
| two-pass v2 (revised prompts, repair pass) | 6.22 ± 0.25 | 6.2 | 6.1 | 5.7 | **7.0** | 4.4 | 0.68 | 0 | 2.4 | 115 | 0.110 |
| ablation: one pass, Sonnet 5.5 | **6.26** ± 0.28 | 6.4 | **6.2** | **6.1** | 6.4 | 4.2 | 0.67 | 0 | 2.2 | 38 | 0.093 |

Paired by song against the baseline (overall score):

| Pipeline | Mean difference | SD of differences | Better / worse / same |
|---|---|---|---|
| two-pass v1 | −0.06 | 1.09 | 5 / 3 / 2 |
| two-pass v2 | 0.00 | 0.43 | 4 / 4 / 2 |
| one pass, Sonnet | +0.04 | 0.49 | 3 / 4 / 3 |

Judge-free columns come from the compiled scripts: distinct settings per song, the share of
consecutive moments that change shot size, moments with nothing in them, and concepts left
unmapped. Time is wall-clock for the model calls; cost is the API-equivalent the Claude Code CLI
reports (the runs used a Claude subscription, not API credits).

## What it shows

- **No pipeline is measurably better overall.** All four land within 0.1 of each other, which is
  smaller than the judge's disagreement with itself (0.23-0.35) and far smaller than the spread
  between songs. With 10 songs, a real difference would need to be around half a point to show.
- **The split changes the profile, not the total.** v2 scores best on renderability (7.0, and the
  most consistent: SD 0.22 across songs), uses more settings and fewer empty frames, but reads the
  lyrics a little less well than the baseline (fit 6.2 against 6.5): the director's plan passes
  through a cheaper model that sometimes realises it generically.
- **v1 → v2 fixed real failures.** v1 lost 3 points on one long song (65 lines) because the script
  model stopped writing moments halfway, leaving three minutes on one picture; v2 asks again for
  missing lines. v1's unmapped log was mostly noise (settings and weather listed as missing,
  notes with line numbers); v2 filters it (6.3 → 2.4 entries per song). The judge's other v1
  complaints (sparse single-subject frames, negations pictured literally, sunny choruses in a
  doom song, invented children) went into the v2 prompts; renderability rose 0.5, fit didn't.
- **The stronger model alone is as good, and cheaper than two passes.** One pass on Sonnet ties
  the others, is the fastest (38 s against 96-115 s) and costs less than the two-pass pipeline.
  The baseline is by far the cheapest.

Given these numbers the player defaults to a single pass, as on `main`, and keeps the two-pass
pipeline as an opt-in (**Settings → Plan first**, director model configurable) for listeners who
want the most renderable scripts. Picking Sonnet as the script model gives the one-pass-Sonnet row.

## Method

- **Songs**: 10 CC BY songs from ccMixter with vocals (8 from music-connector's eval set, 2 from
  its calibration set; the list is [scripts/eval/songs.txt](../../scripts/eval/songs.txt), credits
  in the music-connector eval-audio README). Audio, lyrics and per-song outputs stay outside the
  repo.
- **Inputs**: a SongAnalysis per song from `mc analyze`, and timed lines from Whisper
  (`whisper-small.en` word timestamps grouped into lines, [transcribe.py](../../scripts/eval/transcribe.py));
  the demo song uses its hand-timed LRC. Whisper mishears words and sometimes loops; a first run
  on unfiltered transcripts had four songs with dozens of identical lines and was discarded.
  Every pipeline gets exactly the same inputs.
- **Pipelines**: the baseline runs `main`'s own code (`--mode legacy --baseline-root`), so it is
  the shipped prompt, not a reconstruction. v1 is commit 4892644; v2 is this branch.
- **Judge**: Claude Opus 5.5, a model none of the pipelines uses, with the rubric as its system
  prompt. It sees the song (title, artist, lines with times, the structure letters and energy) and
  the script as a shot list, never which pipeline wrote it. Two independent samples per script.
- **Limits**: one judge model (an LLM judge can prefer some styles of output), 10 songs,
  machine-transcribed lyrics, and a judge that reads a text description of the script rather than
  watching it. Use the table to compare pipelines, not as an absolute quality score.

## Re-running

```sh
scripts/eval/prepare.sh <music-connector checkout>          # inputs → ~/music-connector-eval-audio/player-eval
node scripts/eval/run.mjs generate --arm baseline --mode legacy --baseline-root <checkout of main>
node scripts/eval/run.mjs generate --arm two-v2 --mode two   # --director, --model to change models
node scripts/eval/run.mjs generate --arm single-sonnet --mode single --model claude-sonnet-5-5
node scripts/eval/run.mjs judge --arm two-v2                 # --samples 2, --judge claude-opus-5-5
node scripts/eval/run.mjs report --arms baseline,two-v2,single-sonnet   # writes results.json/.md here
node scripts/eval/run.mjs unmapped --arms baseline,two-v2    # concept counts for vocab-roadmap.md
```

Each model call goes through the local Claude Code CLI (`bridge/claude-cli.ts`), so it bills a
Claude subscription. The eval above (four arms, 80 judge calls) came to about $7.40
API-equivalent, and about $12 with the discarded first run.
