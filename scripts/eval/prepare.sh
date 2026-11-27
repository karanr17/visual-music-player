#!/usr/bin/env bash
# Builds the scene-eval inputs (timed lyrics + SongAnalysis per song) outside the repo.
#   scripts/eval/prepare.sh <music-connector checkout> [audio dir] [out dir]
# Needs the eval audio described in music-connector's README (~/music-connector-eval-audio).
set -euo pipefail
MC=${1:?music-connector checkout}
AUDIO=${2:-$HOME/music-connector-eval-audio}
OUT=${3:-$AUDIO/player-eval}
HERE=$(cd "$(dirname "$0")" && pwd)
mkdir -p "$OUT"
while read -r id file; do
  [ -z "$id" ] && continue
  mkdir -p "$OUT/$id"
  src="$AUDIO/$file"
  [ -s "$OUT/$id/lyrics.json" ] || "$MC/.venv/bin/python" "$HERE/transcribe.py" "$src" > "$OUT/$id/lyrics.json"
  [ -s "$OUT/$id/analysis.json" ] || (cd "$MC" && uv run mc analyze "$src" -o "$OUT/$id/analysis.json")
  echo "$id done"
done < "$HERE/songs.txt"
