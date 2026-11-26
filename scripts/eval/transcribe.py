"""Times a song's sung lines for the scene eval: Whisper word timestamps, grouped into lines.

Run with a Python that has torch, transformers and librosa (music-connector's venv has them):
  python scripts/eval/transcribe.py song.mp3 > lyrics.json

The lines are approximate (misheard words, merged phrases). That is fine for comparing scene
pipelines, since every pipeline gets the same lines, but don't treat them as the real lyrics.
"""

import json
import sys

import librosa
from transformers import pipeline

WINDOW_S = 25
# A pause this long, or this many words, ends a line.
GAP_S = 0.9
MAX_WORDS = 9

y, sr = librosa.load(sys.argv[1], sr=16000, mono=True)
asr = pipeline("automatic-speech-recognition", model="openai/whisper-small.en", device="mps")
words = []
# Fixed windows instead of the pipeline's chunking: its word timestamps break across chunks.
for k in range(0, len(y), WINDOW_S * sr):
    out = asr({"raw": y[k : k + WINDOW_S * sr], "sampling_rate": sr}, return_timestamps="word")
    chunk = []
    for c in out["chunks"]:
        a, b = c["timestamp"]
        if a is None:
            continue
        chunk.append([k / sr + a, k / sr + (b if b is not None else a + 0.3), c["text"].strip()])
    # Whisper pins a window's first word to the window start when music precedes it; move it
    # to just before the next word.
    if len(chunk) > 1 and chunk[0][0] == k / sr and chunk[1][0] - chunk[0][0] > 1.5:
        chunk[0][0] = chunk[1][0] - 0.4
    words.extend(chunk)

PRONOUN_I = {"I", "I'm", "I've", "I'll", "I'd"}


def starts_line(prev, w, n):
    if w[0] - prev[1] > GAP_S or n >= MAX_WORDS or prev[2][-1:] in ".?!,":
        return True
    # Whisper capitalises where it hears a new sentence; "I" is capitalised everywhere.
    return n >= 3 and w[2][:1].isupper() and w[2].strip(",.?!") not in PRONOUN_I


lines, cur = [], []
for w in words:
    if cur and starts_line(cur[-1], w, len(cur)):
        lines.append(cur)
        cur = []
    cur.append(w)
if cur:
    lines.append(cur)
json.dump([{"t": round(l[0][0], 2), "text": " ".join(w[2] for w in l)} for l in lines if len(l) > 1], sys.stdout, indent=1)
