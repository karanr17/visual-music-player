# Demo song: sources and credits

[`docs/analysis-comparison.mp4`](../analysis-comparison.mp4) and the files here use
**"Unbury Your Heart"**, remix by Siobhan Dakay (SiobhanD); lyrics, music and vocals by Madam
Snowflake. Licensed [CC BY 3.0](https://creativecommons.org/licenses/by/3.0/).

- Song: <https://ccmixter.org/files/SiobhanD/57378> (the audio is not in this repository; download
  it from that page).
- Lyrics: published by Madam Snowflake with the a cappella, <https://ccmixter.org/files/snowflake/56386>.
- [`unbury-your-heart.lrc`](unbury-your-heart.lrc): those lyrics, timed to the remix by this project
  (word timings from Whisper, corrected by hand). Drop it next to the MP3 to get captions.
- The analysis is [`public/analysis/unbury-your-heart.analysis.json`](../../public/analysis/unbury-your-heart.analysis.json),
  produced by music-connector; the player finds it by the MP3's SHA-256, so the downloaded file
  works with no server running.

The scene scripts in the video were written by Claude Sonnet 5.5 through the Claude Code bridge,
once without and once with the analysis.
