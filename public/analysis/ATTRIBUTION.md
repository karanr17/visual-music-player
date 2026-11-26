# Example analyses: sources and credits

Precomputed `SongAnalysis` v1 files for three songs whose licences allow hosting, for the visual
player's hosted demo. The audio is **not** in this repository; download it from the links below.
Each JSON's `source.sha256` is the SHA-256 of the MP3 exactly as downloaded from that link, so a
player can check it has the matching file.

All three are licensed **CC BY 3.0** (https://creativecommons.org/licenses/by/3.0/). Reuse needs
credit to everyone listed for that song. The analyses themselves are derived data from this
project and carry no extra restrictions beyond those of the songs.

| Analysis | Song | Credits | Audio | Lyrics |
|---|---|---|---|---|
| `where-the-moon-shines-bright.analysis.json` | *Where the Moon Shines Bright* (2020) | Remix by Kara Square (mindmapthat), from "Debate This!" by Mr_Yesterday (D A Ayer, words and vocals) and Stefan Kartenberg (JeffSpeed68) | [ccMixter page](https://ccmixter.org/files/mindmapthat/62227), [MP3](https://ccmixter.org/content/mindmapthat/mindmapthat_-_Where_the_Moon_Shines_Bright_1.mp3) | CC BY, published with the [a cappella](https://ccmixter.org/files/Mr_Yesterday/60918) |
| `unbury-your-heart.analysis.json` | *Unbury Your Heart* | Remix by Siobhan Dakay (SiobhanD); lyrics, music and vocals by Madam Snowflake | [ccMixter page](https://ccmixter.org/files/SiobhanD/57378), [MP3](https://ccmixter.org/content/SiobhanD/SiobhanD_-_Unbury_Your_Heart_1.mp3) | CC BY, published with the [a cappella](https://ccmixter.org/files/snowflake/56386) |
| `waking-me-softly.analysis.json` | *Waking Me Softly Featuring SnowFlake* | Ghost_k (Ghost Kollective); lyrics and vocals by Madam Snowflake | [ccMixter page](https://ccmixter.org/files/Ghost_k/39570), [MP3](https://ccmixter.org/content/Ghost_k/Ghost_k_-_Waking_Me_Softly_Featuring_SnowFlake.mp3) | CC BY, published with the [a cappella](https://ccmixter.org/files/snowflake/39574) |

ccMixter serves the MP3s only with a `Referer` from the song's page, so download them from the
page in a browser (or send that header). The lyrics are in each a cappella's description; there
are no timed LRC files, so the player will need to time them itself.

Known misses in these files (see the README quality table for the general picture):
- *Where the Moon Shines Bright*: tempo 148 BPM, double the tagged 73 BPM; `tempo.confidence` is
  0.31, which flags it.
- *Unbury Your Heart*: top vocal descriptor is "male vocals"; the singer is a woman (female
  vocals ranks second). Top genre is "funk"; the uploader tags it reggae.
- *Waking Me Softly*: 70 BPM against a tagged 134 (about half).
