// The closed vocabulary the model may use. Every value here must be drawable by src/render;
// adding a value means adding its renderer, or the model will pick something we can't show.

export const STYLES = [
  "natural", "synthwave", "lofi", "noir", "storybook", "metal", "dream",
  "ukiyoe", "impressionist", "watercolor", "gameboy", "nes", "comic",
] as const;

export const SETTINGS = [
  "city", "ocean", "beach", "forest", "mountains", "desert", "field",
  "sky", "space", "room", "road", "snowfield", "lake", "river", "flower_field", "club", "rooftop",
] as const;

export const TIMES = ["dawn", "day", "dusk", "night"] as const;

export const WEATHERS = ["clear", "cloudy", "rain", "storm", "snow", "fog", "wind"] as const;

export const MOODS = [
  "warm", "cold", "melancholy", "romantic", "hopeful", "dark", "euphoric", "nostalgic", "eerie", "serene",
] as const;

export const CAMERAS = ["static", "drift", "slow_pan", "float"] as const;

// How close the camera is for a moment: wide sets the place, medium frames people head to toe,
// close fills the frame with the focus subject.
export const SHOTS = ["wide", "medium", "close"] as const;

export const TRANSITIONS = [
  "crossfade", "dissolve", "fade_black", "flash", "pan_up", "pan_down", "pan_left", "pan_right",
  "zoom_in", "time_shift", "weather_shift",
] as const;

export const SECTION_LABELS = [
  "intro", "verse", "pre_chorus", "chorus", "bridge", "outro", "instrumental",
] as const;

export const SUBJECTS = [
  "lone_figure", "walking_figure", "couple", "embracing_couple", "dancer", "crowd", "child",
  "figure_with_umbrella", "reaching_figure", "sitting_figure",
  "bird", "bird_flock", "butterfly", "cat", "dog", "whale",
  "heart", "broken_heart", "flower", "wilted_flower", "rose", "tree", "dead_tree",
  "candle", "campfire", "lantern", "street_lamp",
  "car", "train", "boat", "house", "lighthouse", "window_light", "door", "bench",
  "balloon", "kite", "big_moon", "big_sun", "planet", "clock", "key", "letter",
  "guitar", "crown", "chains", "mask", "ladder", "bridge", "rainbow", "sunflower", "ship", "phone",
  "record_player", "factory", "volcano", "cow",
  "custom",
] as const;

export const POSITIONS = ["left", "center", "right", "far", "sky", "foreground"] as const;

export const MOTIONS = ["still", "walk", "rise", "fall", "sway", "fly", "drift", "spin"] as const;

export const PARTICLES = [
  "none", "fireflies", "petals", "embers", "sparkles", "leaves", "bubbles", "ash", "confetti", "stars_falling",
  "fireworks", "hearts",
] as const;

export const EVENTS = [
  "none", "lightning", "shooting_star", "pulse", "flash", "darken", "brighten", "shake", "lights_on", "lights_off",
] as const;

export const GENDERS = ["female", "male", "neutral"] as const;
export const AGES = ["child", "teen", "adult", "elder"] as const;
export const HAIRSTYLES = ["short", "long", "ponytail", "curly", "bun", "bald"] as const;
export const OUTFITS = ["pants", "shorts", "skirt", "dress"] as const;

export type Style = (typeof STYLES)[number];
export type Setting = (typeof SETTINGS)[number];
export type TimeOfDay = (typeof TIMES)[number];
export type Weather = (typeof WEATHERS)[number];
export type Mood = (typeof MOODS)[number];
export type Camera = (typeof CAMERAS)[number];
export type Shot = (typeof SHOTS)[number];
export type Transition = (typeof TRANSITIONS)[number];
export type SectionLabel = (typeof SECTION_LABELS)[number];
export type SubjectKind = (typeof SUBJECTS)[number];
export type Position = (typeof POSITIONS)[number];
export type Motion = (typeof MOTIONS)[number];
export type Particles = (typeof PARTICLES)[number];
export type SceneEvent = (typeof EVENTS)[number];
