import type { WorldSpec } from "../scene/schema";
import type { Mood, TimeOfDay, Weather } from "../scene/vocab";
import { clamp, lerp, mix, scale, type RGB } from "./fb";

export interface Palette {
  skyTop: RGB;
  skyBot: RGB;
  far: RGB;
  mid: RGB;
  near: RGB;
  water: RGB;
  light: RGB;
  accent: RGB;
  cloud: RGB;
  fog: RGB;
  sun: RGB;
}

// Everything a world needs that can be interpolated, so same-setting transitions
// (time_shift, weather_shift) are a parameter blend instead of a cut.
export interface WorldParams {
  pal: Palette;
  stars: number;
  sunAlpha: number;
  moonAlpha: number;
  celestialX: number;
  celestialY: number;
  lights: number;
  rain: number;
  snow: number;
  fog: number;
  cloud: number;
  wind: number;
  storm: number;
  daylight: number;
}

type TimeBase = Omit<Palette, "water" | "cloud" | "fog" | "accent"> & {
  stars: number;
  sun: RGB;
  sunAlpha: number;
  moonAlpha: number;
  cx: number;
  cy: number;
  daylight: number;
};

const TIME: Record<TimeOfDay, TimeBase> = {
  night: {
    skyTop: [6, 8, 26], skyBot: [32, 34, 74], far: [28, 28, 56], mid: [16, 16, 38], near: [6, 6, 16],
    light: [255, 206, 120], sun: [230, 230, 255], stars: 1, sunAlpha: 0, moonAlpha: 1, cx: 0.72, cy: 0.18, daylight: 0,
  },
  dusk: {
    skyTop: [38, 28, 86], skyBot: [250, 128, 86], far: [96, 58, 108], mid: [58, 34, 76], near: [20, 12, 30],
    light: [255, 196, 110], sun: [255, 170, 80], stars: 0.25, sunAlpha: 1, moonAlpha: 0, cx: 0.7, cy: 0.56, daylight: 0.45,
  },
  dawn: {
    skyTop: [86, 116, 186], skyBot: [255, 192, 150], far: [124, 112, 152], mid: [82, 72, 112], near: [36, 30, 52],
    light: [255, 220, 160], sun: [255, 214, 150], stars: 0.08, sunAlpha: 1, moonAlpha: 0, cx: 0.26, cy: 0.52, daylight: 0.6,
  },
  day: {
    skyTop: [64, 136, 226], skyBot: [176, 218, 248], far: [112, 150, 176], mid: [64, 112, 92], near: [30, 62, 46],
    light: [255, 240, 200], sun: [255, 248, 210], stars: 0, sunAlpha: 1, moonAlpha: 0, cx: 0.62, cy: 0.16, daylight: 1,
  },
};

const MOOD: Record<Mood, { tint: RGB; amount: number; accent: RGB; bright: number }> = {
  warm: { tint: [255, 150, 60], amount: 0.22, accent: [255, 120, 60], bright: 1 },
  cold: { tint: [70, 130, 255], amount: 0.3, accent: [140, 200, 255], bright: 0.92 },
  melancholy: { tint: [90, 100, 140], amount: 0.38, accent: [150, 160, 200], bright: 0.82 },
  romantic: { tint: [255, 90, 150], amount: 0.28, accent: [255, 70, 120], bright: 1 },
  hopeful: { tint: [255, 222, 120], amount: 0.2, accent: [255, 210, 90], bright: 1.08 },
  dark: { tint: [40, 10, 30], amount: 0.4, accent: [200, 30, 50], bright: 0.6 },
  euphoric: { tint: [255, 70, 220], amount: 0.3, accent: [90, 255, 220], bright: 1.12 },
  nostalgic: { tint: [230, 168, 110], amount: 0.32, accent: [240, 150, 90], bright: 0.95 },
  eerie: { tint: [70, 255, 150], amount: 0.24, accent: [140, 255, 120], bright: 0.78 },
  serene: { tint: [120, 200, 220], amount: 0.2, accent: [170, 230, 240], bright: 1 },
};

const WEATHER: Record<Weather, { rain: number; snow: number; fog: number; cloud: number; wind: number; storm: number; grey: number }> = {
  clear: { rain: 0, snow: 0, fog: 0, cloud: 0.1, wind: 0.1, storm: 0, grey: 0 },
  cloudy: { rain: 0, snow: 0, fog: 0.05, cloud: 0.8, wind: 0.25, storm: 0, grey: 0.25 },
  rain: { rain: 0.7, snow: 0, fog: 0.15, cloud: 0.9, wind: 0.3, storm: 0, grey: 0.4 },
  storm: { rain: 1, snow: 0, fog: 0.2, cloud: 1, wind: 0.8, storm: 1, grey: 0.55 },
  snow: { rain: 0, snow: 0.8, fog: 0.15, cloud: 0.7, wind: 0.2, storm: 0, grey: 0.2 },
  fog: { rain: 0, snow: 0, fog: 0.6, cloud: 0.4, wind: 0.05, storm: 0, grey: 0.3 },
  wind: { rain: 0, snow: 0, fog: 0, cloud: 0.4, wind: 1, storm: 0, grey: 0.1 },
};

const GREY: RGB = [120, 124, 134];

export function worldParams(w: WorldSpec): WorldParams {
  // Fallbacks keep one bad value (hand-edited script, older cache) from crashing the render loop.
  const t = TIME[w.timeOfDay] ?? TIME.night;
  const m = MOOD[w.mood] ?? MOOD.serene;
  const we = WEATHER[w.weather] ?? WEATHER.clear;
  const tone = (c: RGB): RGB => scale(mix(mix(c, m.tint, m.amount), mix(GREY, c, 0.5), we.grey), m.bright * (1 - we.storm * 0.3));
  const skyBot = tone(t.skyBot);
  const near = tone(t.near);
  return {
    pal: {
      skyTop: tone(t.skyTop),
      skyBot,
      far: tone(t.far),
      mid: tone(t.mid),
      near,
      water: mix(skyBot, near, 0.55),
      light: mix(t.light, m.accent, 0.2),
      accent: m.accent,
      cloud: mix(mix(skyBot, [255, 255, 255], 0.35 + t.daylight * 0.3), GREY, we.grey),
      fog: mix(skyBot, [200, 200, 210], 0.3),
      sun: mix(t.sun, m.tint, 0.15),
    },
    stars: t.stars * (1 - we.cloud * 0.8),
    sunAlpha: t.sunAlpha * (1 - we.cloud * 0.7),
    moonAlpha: t.moonAlpha * (1 - we.cloud * 0.6),
    celestialX: t.cx,
    celestialY: t.cy,
    lights: 1 - t.daylight * 0.85,
    rain: we.rain,
    snow: we.snow,
    fog: we.fog,
    cloud: we.cloud,
    wind: we.wind,
    storm: we.storm,
    daylight: t.daylight,
  };
}

function lerpPal(a: Palette, b: Palette, k: number): Palette {
  const out = {} as Palette;
  for (const key of Object.keys(a) as (keyof Palette)[]) out[key] = mix(a[key], b[key], k);
  return out;
}

export function lerpParams(a: WorldParams, b: WorldParams, k: number): WorldParams {
  k = clamp(k);
  const out = { pal: lerpPal(a.pal, b.pal, k) } as WorldParams;
  for (const key of Object.keys(a) as (keyof WorldParams)[]) {
    if (key !== "pal") (out[key] as number) = lerp(a[key] as number, b[key] as number, k);
  }
  return out;
}
