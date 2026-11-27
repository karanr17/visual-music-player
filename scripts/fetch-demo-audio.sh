#!/usr/bin/env bash
# Downloads the three CC BY 3.0 demo songs from ccMixter into public/audio/ (gitignored) and
# checks each against the SHA-256 its bundled analysis records. The Pages workflow runs this
# before building; run it locally to try the demo songs under `npm run dev`.
# ccMixter only serves the MP3s with a Referer from the song's page.
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p public/audio
while read -r slug page url sha; do
  out="public/audio/$slug.mp3"
  if [[ ! -s "$out" ]] || [[ "$(shasum -a 256 "$out" | cut -d' ' -f1)" != "$sha" ]]; then
    curl -fsSL --retry 3 -e "$page" -o "$out" "$url"
  fi
  got=$(shasum -a 256 "$out" | cut -d' ' -f1)
  if [[ "$got" != "$sha" ]]; then
    echo "$slug: SHA-256 $got does not match the bundled analysis ($sha)" >&2
    exit 1
  fi
  echo "$slug ok"
done <<'LIST'
unbury-your-heart https://ccmixter.org/files/SiobhanD/57378 https://ccmixter.org/content/SiobhanD/SiobhanD_-_Unbury_Your_Heart_1.mp3 0e42c0c61f39c3b520c150d3bf4a8d6263c93afa7203fe91175c96366972b6d5
waking-me-softly https://ccmixter.org/files/Ghost_k/39570 https://ccmixter.org/content/Ghost_k/Ghost_k_-_Waking_Me_Softly_Featuring_SnowFlake.mp3 e7e1299aa78a82c89be1863501f3ece036a0ff1cfc6c9e9a6097d5d3af883baf
where-the-moon-shines-bright https://ccmixter.org/files/mindmapthat/62227 https://ccmixter.org/content/mindmapthat/mindmapthat_-_Where_the_Moon_Shines_Bright_1.mp3 b4706a23127429bfca06f4dac349556ac4ca80198ff651e38c82457324e35830
LIST
