# Vocabulary roadmap

What scene scripts asked for and the renderer couldn't draw, from the `unmapped` log of the scene
eval (4 pipelines × 10 CC BY songs, [docs/eval](eval/README.md)), grouped by what it would take to
add. Counts are pipeline-song pairs that asked for it (at most 4 per song), after cleaning (notes
and line numbers stripped; names already in the vocabulary dropped).

The player also keeps its own count in the browser (Settings → Scene library → "Concepts the
vocabulary couldn't show"). That log is per listener and stays in their browser, so it isn't
summarised here; it is the place to look for a library's own gaps.

Regenerate the list with `node scripts/eval/run.mjs unmapped --arms baseline,two-v1,two-v2,single-sonnet`.

## Added in this change

Small pixel-art subjects (an ASCII sprite each in `src/render/sprites.ts`), chosen because they
came up across pipelines or songs and cost a few lines each:

| Subject | Asked for as | Count |
|---|---|---|
| `record_player` | record player, needle | 6 |
| `factory` (with drifting smoke) | factory, factories, smoke trail | 3 |
| `volcano` | volcano, Vesuvius volcano, cooling volcano | 4 |
| `cow` | cows, barn | 4 |

## Next: cheap (an ASCII sprite or a small procedural object)

| Concept | Asked for as | Count | Notes |
|---|---|---|---|
| hammer / tools | hammer | 3 | Symbolic small object, like `key` |
| webcam | webcam | 3 | `phone` covers most of it; a laptop sprite would cover "screen" lyrics too |
| speakers | bass speakers, strobe lights, dance floor | 3 | Club furniture; `club` setting could draw them itself |
| truck | truck | 1 | Variant of `car` with a box trailer |
| barrel / fuel pump | barrel, diesel barrel, fuel pump | 3 | Street props |
| hill | hill, hills on the horizon, hilltop road | 4 | A `hills` setting or a low far ridge in `field` |
| ruins | ruined city, ruined wall, toppled street lamp, cracked ground | 4 | A `ruins` setting would also serve post-disaster songs |

## Later: renderer features, not subjects

| Concept | Asked for as | Count | What it needs |
|---|---|---|---|
| Shadows | figure's long shadow, shadow stretching across the road | 2 | Long cast shadows from the light direction (the lighting model already has one) |
| Poses | lying down, running, head bowed, clasped hands, bare feet | 7 | More clips in the character atlas (the LPC sheets have hurt/lie and run cycles) |
| Gestures between people | hand on chest, hand holding a letter, partner sitting beside | 3 | Holding an object, sitting pairs: needs relations between subjects |
| Water features | forest stream, lake shore, swimming branch | 4 | Small water in `forest` / `field`, objects floating on water |
| Light effects | lamp flicker, clouds parting, burning sky, mist, misty dawn | 5 | Per-subject flicker, and sky events beyond the current `brighten`/`darken` |

## Not worth adding

One-off, song-specific requests the closest picture already covers: blue suede shoes, falling
bean pods, a ghost of the blues, a pen, a sky hole.
