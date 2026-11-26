# Credits and third-party assets

Everything in this repository is MIT-licensed ([LICENSE](LICENSE)) **except the files listed
here**, which keep their own licences. Add a row whenever an asset from outside the project is
committed, and never commit an asset whose licence forbids redistribution in a public repository.

| Asset | Files | Licence | Source |
|---|---|---|---|
| LPC character sprites (people) | `src/render/chars/atlas.png` (built from the layers below) | OGA-BY 3.0, CC-BY 3.0 or CC0, per layer | [Universal LPC Spritesheet Character Generator](https://github.com/LiberatedPixelCup/Universal-LPC-Spritesheet-Character-Generator) at `86a3719` (2026-11-20) |
| Pixelify Sans font | loaded from Google Fonts at runtime, not committed | SIL OFL 1.1 | [Google Fonts](https://fonts.google.com/specimen/Pixelify+Sans) |

Everything else you see (skies, terrain, water, weather, the sunflower, cars, the club, the
custom sprites in the demo) is drawn procedurally by code in `src/render`.

## LPC character sprites

The people are built from Liberated Pixel Cup (LPC) character layers by the artists below.

**Sprites by:** Stephen Challener (Redshrike), Johannes Sjölund (wulax), Matthew Krohn (makrohn),
Pierre Vigier (pvigier), Benjamin K. Smith (BenCreating), Eliza Wyatt (ElizaWy), bluecarrot16,
David Conway Jr. (JaidynReiman), Evert, TheraHedwig, MuffinElZangano, Durrani, Nila122, kheftel,
Manuel Riecke (MrBeast), Joe White, thecilekli and Ahmad3366. Sprites contributed as part of the
Liberated Pixel Cup project from OpenGameArt.org: <https://opengameart.org/content/lpc-collection>.

- **Licence:** most layers are offered under several licences; this project uses each one under
  **OGA-BY 3.0** (<https://static.opengameart.org/OGA-BY-3.0.txt>), **CC-BY 3.0**
  (<https://creativecommons.org/licenses/by/3.0/>) or **CC0**, as the table shows. No layer is used
  under CC-BY-SA or GPL, and `scripts/build-characters.mjs` refuses any layer that doesn't offer
  one of those three.
- **Detailed per-file credits** (authors, licences and original OpenGameArt URLs, verbatim from the
  generator's `CREDITS.csv`): [src/render/chars/CREDITS.csv](src/render/chars/CREDITS.csv).
- **Changes made:** frames were cropped to a 50×56 cell; only the walk, idle, sit, emote and
  spellcast animations were kept; colours were replaced by indices into a 6-step shading ramp so the
  renderer can recolour each layer from the song's cast (skin, hair, clothes). The dance and reach
  cycles are sequences of these authored frames. Sheets that have no entry in the generator's
  `CREDITS.csv` were left out.
- **Rebuild:** `node scripts/build-characters.mjs <path to a checkout of the generator>`.

| Layer (`spritesheets/…`) | Licence we use | Also offered | Authors |
|---|---|---|---|
| `body/bodies/male` | OGA-BY 3.0 | CC-BY-SA 3.0, GPL 3.0 | bluecarrot16, JaidynReiman, Benjamin K. Smith (BenCreating), Evert, Eliza Wyatt (ElizaWy), TheraHedwig, MuffinElZangano, Durrani, Johannes Sjölund (wulax), Stephen Challener (Redshrike) |
| `body/bodies/female` | OGA-BY 3.0 | CC-BY-SA 3.0, GPL 3.0 | Benjamin K. Smith (BenCreating), bluecarrot16, TheraHedwig, Evert, MuffinElZangano, Durrani, Pierre Vigier (pvigier), ElizaWy, Matthew Krohn (makrohn), Johannes Sjölund (wulax), Stephen Challener (Redshrike) |
| `body/bodies/child` | OGA-BY 3.0 | CC-BY-SA 3.0, GPL 3.0 | bluecarrot16, Benjamin K. Smith (BenCreating), ElizaWy, MuffinElZangano, Durrani, Nila122, kheftel, Stephen Challener (Redshrike) |
| `head/heads/human/child` | OGA-BY 3.0 | CC-BY 3.0, GPL 3.0 | Stephen Challener (Redshrike), kheftel, bluecarrot16 |
| `head/heads/human/female_elderly` | OGA-BY 3.0 | CC-BY 3.0 | Benjamin K. Smith (BenCreating), Eliza Wyatt (ElizaWy), Stephen Challener (Redshrike) |
| `head/heads/human/female` | OGA-BY 3.0 | CC-BY-SA 3.0, GPL 3.0 | bluecarrot16, Benjamin K. Smith (BenCreating), Stephen Challener (Redshrike) |
| `head/heads/human/male_elderly` | OGA-BY 3.0 | CC-BY 3.0 | Benjamin K. Smith (BenCreating), Eliza Wyatt (ElizaWy), Stephen Challener (Redshrike) |
| `head/heads/human/male` | OGA-BY 3.0 | CC-BY-SA 3.0, GPL 3.0 | bluecarrot16, Benjamin K. Smith (BenCreating), Stephen Challener (Redshrike) |
| `hair/extensions/ponytails/topknot_short/child` | OGA-BY 3.0+ | CC-BY 3.0+, CC-BY-SA 3.0, GPL 3.0 | JaidynReiman |
| `hair/curly_short/adult` | OGA-BY 3.0 | – | ElizaWy |
| `hair/jewfro/child` | OGA-BY 3.0+ | CC-BY 3.0+, CC-BY-SA 3.0, GPL 3.0 | JaidynReiman |
| `hair/balding/adult` | OGA-BY 3.0 | – | ElizaWy |
| `hair/parted_side_bangs/child` | OGA-BY 3.0+ | CC-BY 3.0+, CC-BY-SA 3.0, GPL 3.0 | JaidynReiman |
| `hair/plain/adult` | OGA-BY 3.0 | CC-BY-SA 3.0, GPL 3.0 | JaidynReiman, Manuel Riecke (MrBeast), Joe White |
| `hair/relm_short/child` | OGA-BY 3.0+ | CC-BY 3.0+, GPL 3.0 | JaidynReiman |
| `hair/bangs_bun/adult` | CC0 | – | ElizaWy, bluecarrot16 |
| `hair/high_ponytail/adult/fg` | OGA-BY 3.0 | – | JaidynReiman, ElizaWy, bluecarrot16 |
| `hair/high_ponytail/adult/bg` | OGA-BY 3.0 | – | JaidynReiman, ElizaWy, bluecarrot16 |
| `hair/long_straight/adult` | CC0 | – | JaidynReiman, thecilekli, bluecarrot16 |
| `hair/wavy/child` | OGA-BY 3.0 | CC-BY-SA 3.0, GPL 2.0, GPL 3.0 | Nila122 |
| `torso/clothes/shirt/child` | OGA-BY 3.0 | CC-BY-SA 3.0, GPL 3.0 | Nila122 |
| `torso/clothes/longsleeve/longsleeve2/male` | OGA-BY 3.0 | – | ElizaWy, JaidynReiman, Stephen Challener (Redshrike), Johannes Sjölund (wulax) |
| `torso/clothes/longsleeve/longsleeve2/female` | OGA-BY 3.0 | – | ElizaWy, JaidynReiman, Stephen Challener (Redshrike), Johannes Sjölund (wulax) |
| `torso/clothes/shortsleeve/tshirt/male` | OGA-BY 3.0 | – | ElizaWy, JaidynReiman, Stephen Challener (Redshrike), Johannes Sjölund (wulax) |
| `torso/clothes/shortsleeve/tshirt/female` | OGA-BY 3.0 | – | ElizaWy, JaidynReiman, Stephen Challener (Redshrike), Johannes Sjölund (wulax) |
| `legs/pants/child` | OGA-BY 3.0 | CC-BY-SA 3.0, GPL 3.0 | Nila122 |
| `legs/pants/male` | OGA-BY 3.0 | GPL 3.0, CC-BY-SA 3.0 | bluecarrot16, JaidynReiman, ElizaWy, Matthew Krohn (makrohn), Johannes Sjölund (wulax), Stephen Challener (Redshrike) |
| `legs/pants/thin` | OGA-BY 3.0 | GPL 3.0, CC-BY-SA 3.0 | bluecarrot16, JaidynReiman, ElizaWy, Joe White, Matthew Krohn (makrohn), Johannes Sjölund (wulax), Stephen Challener (Redshrike) |
| `legs/shorts/shorts/male` | OGA-BY 3.0 | GPL 3.0 | JaidynReiman, ElizaWy, Bluecarrot16, Johannes Sjölund (wulax), Stephen Challener (Redshrike) |
| `legs/shorts/shorts/thin` | OGA-BY 3.0 | – | ElizaWy, JaidynReiman, Johannes Sjölund (wulax), Stephen Challener (Redshrike) |
| `legs/skirts/child` | OGA-BY 3.0 | CC-BY-SA 3.0, GPL 3.0 | Nila122 |
| `legs/skirts/plain/male` | OGA-BY 3.0 | CC-BY-SA 3.0, GPL 3.0 | bluecarrot16, Pierre Vigier (pvigier), Johannes Sjölund (wulax), Ahmad3366, JaidynReiman |
| `legs/skirts/plain/thin` | OGA-BY 3.0 | CC-BY-SA 3.0, GPL 3.0 | bluecarrot16, Pierre Vigier (pvigier), Johannes Sjölund (wulax), Ahmad3366, JaidynReiman |
| `feet/shoes/basic/male` | OGA-BY 3.0 | CC-BY-SA 3.0, GPL 3.0 | JaidynReiman, bluecarrot16, Johannes Sjölund (wulax) |
| `feet/shoes/basic/thin` | OGA-BY 3.0 | CC-BY-SA 3.0, GPL 3.0 | JaidynReiman, Joe White, Johannes Sjölund (wulax) |
