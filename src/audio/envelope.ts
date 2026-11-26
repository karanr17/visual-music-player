// Offline loudness envelope, decoded once per file. Phase 1 stand-in for live analysis:
// cheap, exact on seek, and gives the no-lyrics prompt an energy shape to read.

export interface Envelope {
  hop: number;
  values: Float32Array;
}

const HOP = 0.05;

export async function computeEnvelope(file: File): Promise<Envelope | null> {
  try {
    const ctx = new OfflineAudioContext(1, 1, 22050);
    const audio = await ctx.decodeAudioData(await file.arrayBuffer());
    const hopSamples = Math.round(audio.sampleRate * HOP);
    const frames = Math.ceil(audio.length / hopSamples);
    const values = new Float32Array(frames);
    const chans = Array.from({ length: audio.numberOfChannels }, (_, c) => audio.getChannelData(c));
    let peak = 1e-6;
    for (let f = 0; f < frames; f++) {
      const from = f * hopSamples;
      const to = Math.min(audio.length, from + hopSamples);
      let sum = 0;
      for (const ch of chans) for (let i = from; i < to; i += 2) sum += ch[i] * ch[i];
      const rms = Math.sqrt(sum / Math.max(1, ((to - from) / 2) * chans.length));
      values[f] = rms;
      if (rms > peak) peak = rms;
    }
    // Normalise against a high percentile, not the max, so one transient doesn't flatten the song.
    const sorted = Float32Array.from(values).sort();
    const ref = Math.max(sorted[Math.floor(sorted.length * 0.97)] ?? peak, 1e-6);
    for (let f = 0; f < frames; f++) values[f] = Math.min(1, values[f] / ref);
    return { hop: HOP, values };
  } catch (err) {
    console.warn("[envelope] decode failed", err);
    return null;
  }
}

function smoothedAt(env: Envelope, i: number): number {
  // Light smoothing over ±2 frames keeps visuals from flickering on every hop.
  let sum = 0;
  let n = 0;
  for (let k = -2; k <= 2; k++) {
    const v = env.values[i + k];
    if (v !== undefined) {
      sum += v;
      n++;
    }
  }
  return n ? sum / n : 0.4;
}

// Interpolated between hops: a stepped 20 Hz value makes anything it drives judder at 60 fps.
export function energyAt(env: Envelope | null, t: number): number {
  if (!env || t < 0) return 0.4;
  const f = Math.min(env.values.length - 1, t / env.hop);
  const i = Math.floor(f);
  const a = smoothedAt(env, i);
  return a + (smoothedAt(env, Math.min(env.values.length - 1, i + 1)) - a) * (f - i);
}

function rawOnset(env: Envelope, i: number): number {
  const now = env.values[i] ?? 0;
  let past = 0;
  for (let k = 1; k <= 6; k++) past += env.values[i - k] ?? now;
  return Math.max(0, now - past / 6);
}

// Energy jumps relative to the recent past (a crude onset proxy), held with an exponential
// decay so a hit eases out instead of snapping back on the next hop.
export function onsetAt(env: Envelope | null, t: number): number {
  if (!env || t < 0) return 0;
  const f = t / env.hop;
  const i = Math.floor(f);
  let best = 0;
  for (let k = 0; k < 8; k++) best = Math.max(best, rawOnset(env, i - k) * Math.exp(-((f - (i - k)) * env.hop) / 0.12));
  return best;
}

export function energySegments(env: Envelope | null, duration: number, seg = 12): { start: number; end: number; energy: number }[] {
  const out: { start: number; end: number; energy: number }[] = [];
  for (let s = 0; s < duration; s += seg) {
    const end = Math.min(duration, s + seg);
    let sum = 0;
    let n = 0;
    for (let t = s; t < end; t += 0.5) {
      sum += energyAt(env, t);
      n++;
    }
    out.push({ start: s, end, energy: n ? sum / n : 0.4 });
  }
  return out;
}
