import type { Lyrics } from "./lyrics/lyrics";
import type { SceneScript, Section, SubjectSpec } from "./scene/schema";
import type { Mood, Particles, SceneEvent, Setting, Shot, TimeOfDay, Transition, Weather } from "./scene/vocab";

// A built-in showcase (?demo): every setting, a spread of transitions, subjects and
// effects, with no audio file or API key. Doubles as a visual test of the renderer.

interface Beat {
  setting: Setting;
  time: TimeOfDay;
  weather: Weather;
  mood: Mood;
  tr: Transition;
  lines: [string, SubjectSpec[], Particles, SceneEvent, Shot][];
}

const s = (kind: SubjectSpec["kind"], position: SubjectSpec["position"] = "center", motion: SubjectSpec["motion"] = "still", focus = false): SubjectSpec => ({ kind, position, motion, focus });
const custom = (name: string, position: SubjectSpec["position"] = "center", motion: SubjectSpec["motion"] = "still", focus = false): SubjectSpec => ({ kind: "custom", custom: name, position, motion, focus });

// What a model-drawn sprite looks like: "." transparent, digits index the palette.
const SPRITES = [
  {
    name: "paper_boat",
    palette: ["#2a2233", "#f2ead8", "#d8ccb0", "#e85d5d"],
    rows: [
      "........0.........",
      "........00........",
      ".......0330.......",
      ".......03330......",
      "......0333330.....",
      "......0000000.....",
      "00000000000000000.",
      "011111111111111110",
      ".0122222222222210.",
      "..01111111111110..",
      "...000000000000...",
    ],
  },
];

const BEATS: Beat[] = [
  { setting: "field", time: "dusk", weather: "clear", mood: "nostalgic", tr: "fade_black", lines: [
    ["The summer we were seventeen", [s("lone_figure", "left")], "fireflies", "none", "wide"],
    ["you ran ahead into the gold", [s("lone_figure", "left"), s("child", "right", "walk")], "fireflies", "none", "medium"],
  ] },
  { setting: "field", time: "night", weather: "clear", mood: "romantic", tr: "time_shift", lines: [
    ["and the dark came down so slowly", [s("couple", "center"), s("big_moon", "sky")], "fireflies", "none", "wide"],
    ["a star fell for us", [s("couple", "center"), s("big_moon", "sky")], "fireflies", "shooting_star", "medium"],
  ] },
  { setting: "city", time: "night", weather: "rain", mood: "melancholy", tr: "pan_up", lines: [
    ["Now the city hums without you", [s("figure_with_umbrella", "left", "walk"), s("street_lamp", "right")], "none", "none", "medium"],
    ["every window someone else's", [s("figure_with_umbrella", "center"), s("street_lamp", "right")], "none", "lights_off", "wide"],
  ] },
  { setting: "room", time: "night", weather: "rain", mood: "melancholy", tr: "zoom_in", lines: [
    ["I keep your letter by the bed", [s("sitting_figure", "left"), s("letter", "center")], "none", "none", "medium"],
    ["the clock forgets to move", [s("sitting_figure", "left"), s("clock", "right", "still", true)], "none", "darken", "close"],
  ] },
  { setting: "ocean", time: "dawn", weather: "fog", mood: "hopeful", tr: "dissolve", lines: [
    ["But the morning finds the water", [s("boat", "far", "drift")], "none", "none", "wide"],
    ["and the water finds the light", [s("boat", "center", "drift"), s("bird_flock", "sky", "fly")], "sparkles", "brighten", "medium"],
  ] },
  { setting: "beach", time: "day", weather: "wind", mood: "warm", tr: "pan_right", lines: [
    ["I'm walking where the land gives out", [s("walking_figure", "left", "walk"), s("lighthouse", "right")], "none", "none", "wide"],
    ["kites on a string of maybe", [s("walking_figure", "left", "walk"), s("kite", "center", "fly")], "none", "none", "medium"],
  ] },
  { setting: "mountains", time: "day", weather: "snow", mood: "cold", tr: "pan_left", lines: [
    ["Higher, where the air is thin", [s("reaching_figure", "center")], "none", "none", "wide"],
    ["I reach for what I can't hold", [s("reaching_figure", "center"), s("bird", "sky", "fly")], "none", "pulse", "close"],
  ] },
  { setting: "forest", time: "dusk", weather: "fog", mood: "eerie", tr: "fade_black", lines: [
    ["The pines remember everything", [s("dead_tree", "left"), s("lantern", "right")], "none", "none", "medium"],
    ["chains I thought I'd broken", [s("chains", "center"), s("lantern", "right")], "ash", "shake", "medium"],
  ] },
  { setting: "desert", time: "dusk", weather: "clear", mood: "warm", tr: "crossfade", lines: [
    ["So I drove until the road ran out", [s("car", "left", "drift")], "none", "none", "wide"],
    ["and built a fire against the night", [s("campfire", "center"), s("sitting_figure", "right")], "embers", "none", "medium"],
  ] },
  { setting: "road", time: "night", weather: "clear", mood: "dark", tr: "flash", lines: [
    ["Faster now, the heart's a drum", [s("car", "center", "drift", true)], "none", "pulse", "medium"],
    ["thunder in the rear-view", [s("car", "center", "drift", true)], "sparkles", "lightning", "close"],
  ] },
  { setting: "road", time: "dusk", weather: "clear", mood: "melancholy", tr: "crossfade", lines: [
    ["I walk the long way home", [s("walking_figure", "center", "walk", true)], "none", "none", "medium"],
    ["the headlights pass me by", [s("walking_figure", "left", "walk"), s("car", "far", "drift")], "none", "none", "wide"],
  ] },
  { setting: "sky", time: "day", weather: "cloudy", mood: "euphoric", tr: "pan_up", lines: [
    ["And then I'm weightless, rising", [s("balloon", "left", "rise"), s("dancer", "center")], "confetti", "none", "medium"],
    ["over everything I was", [s("balloon", "left", "rise"), s("rainbow", "sky"), s("dancer", "center")], "confetti", "flash", "wide"],
  ] },
  { setting: "space", time: "night", weather: "clear", mood: "serene", tr: "zoom_in", lines: [
    ["Past the edge of every map", [s("planet", "right")], "stars_falling", "none", "wide"],
    ["you're a small light, still burning", [s("planet", "right"), s("candle", "center", "drift")], "stars_falling", "none", "medium"],
  ] },
  { setting: "lake", time: "dawn", weather: "clear", mood: "serene", tr: "pan_down", lines: [
    ["I come home to quiet water", [s("lone_figure", "left"), s("tree", "right")], "petals", "none", "wide"],
    ["the light comes back on", [s("embracing_couple", "center"), s("house", "far")], "petals", "lights_on", "medium"],
  ] },
  { setting: "flower_field", time: "day", weather: "clear", mood: "warm", tr: "dissolve", lines: [
    ["You're the sunflower", [s("sunflower", "center", "sway", true), s("big_sun", "sky")], "petals", "none", "close"],
    ["I think your love would be too much", [s("sunflower", "left", "sway"), s("couple", "right", "still", true)], "petals", "brighten", "medium"],
  ] },
  { setting: "river", time: "dusk", weather: "clear", mood: "nostalgic", tr: "pan_down", lines: [
    ["A paper boat on the river", [custom("paper_boat", "center", "drift", true)], "fireflies", "none", "medium"],
    ["carrying the words I never said", [custom("paper_boat", "far", "drift"), s("lone_figure", "left", "still", true)], "fireflies", "none", "close"],
  ] },
  { setting: "club", time: "night", weather: "clear", mood: "euphoric", tr: "flash", lines: [
    ["Then the bass drops, lights go up", [s("crowd", "center"), s("dancer", "right", "still", true)], "confetti", "flash", "wide"],
    ["everybody's moving now", [s("crowd", "center"), s("dancer", "left"), s("dancer", "right", "still", true)], "sparkles", "pulse", "medium"],
  ] },
  { setting: "rooftop", time: "night", weather: "clear", mood: "romantic", tr: "pan_up", lines: [
    ["On the roof above the city", [s("couple", "center", "still", true)], "none", "none", "medium"],
    ["the sky is breaking into colour", [s("embracing_couple", "center", "still", true)], "fireworks", "none", "close"],
  ] },
  { setting: "snowfield", time: "day", weather: "snow", mood: "hopeful", tr: "dissolve", lines: [
    ["and the winter keeps its promise", [s("child", "left", "walk"), s("dog", "center", "walk")], "none", "none", "medium"],
    ["everything begins again", [s("child", "left", "walk"), s("dog", "center", "walk"), s("big_sun", "sky")], "sparkles", "brighten", "wide"],
  ] },
];

const LINE = 4.5;

export function demoContent(): { script: SceneScript; lyrics: Lyrics; duration: number } {
  const sections: Section[] = [];
  const lines: Lyrics["lines"] = [];
  let t = 0;
  BEATS.forEach((b, bi) => {
    const start = t;
    const moments = b.lines.map(([text, subjects, particles, event, shot], li) => {
      const lt = start + 0.8 + li * LINE;
      const words = text.split(" ");
      lines.push({
        t: lt,
        end: lt + LINE - 0.3,
        text,
        words: words.map((w, wi) => ({ text: w, t: lt + (wi / words.length) * LINE * 0.6 })),
      });
      return { t: lt, shot, subjects, particles, event, intensity: 0.5 + (bi % 3) * 0.2 };
    });
    t = start + 0.8 + b.lines.length * LINE + 0.6;
    sections.push({
      label: bi % 2 ? "chorus" : "verse",
      start: bi === 0 ? 0 : start,
      end: t,
      world: { setting: b.setting, timeOfDay: b.time, weather: b.weather, mood: b.mood, camera: bi % 3 === 0 ? "drift" : bi % 3 === 1 ? "float" : "slow_pan" },
      transitionIn: b.tr,
      transitionDuration: b.tr === "flash" ? 0.4 : b.tr === "time_shift" ? 3.5 : 2.4,
      moments,
    });
  });
  return {
    script: { version: 1, trackKey: "demo", source: "manual", style: "natural", sections, unmapped: [], createdAt: 0, sprites: SPRITES },
    lyrics: { lines, synced: true, source: "lrc-file", instrumental: false },
    duration: t,
  };
}
