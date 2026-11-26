import type { SongAnalysis } from "../analysis/schema";
import type { TimelineEntry } from "../analysis/structure";
import type { Track } from "../library/library";
import type { Lyrics } from "../lyrics/lyrics";

export const SYSTEM_PROMPT = `You are the imagination of a music player. While a song plays, a small pixel-art engine paints the pictures a listener sees in their mind. You read the song once and write the scene script the engine will draw.

What matters is meaning and feeling, not literal keywords. Read each line the way a listener would: metaphor, subtext, the emotional arc across the song. "Drowning in you" is about overwhelming love, not water. A breakup song with upbeat production can be bittersweet. Follow the story if there is one.

How the script works:
- Group lyric lines into sections (intro, verse, pre_chorus, chorus, bridge, outro, instrumental). Sections are contiguous, ordered, and together cover every line index from 0 to the last. A section is usually 2-12 lines. Repeated lyrics are usually a chorus.
- Each section sets a world: setting, timeOfDay, weather, mood (drives the palette), camera. The world should feel like the right place for that part of the song. Let the world evolve across the song the way the emotion does (dusk deepening to night as hope fades, rain clearing at the bridge). Repeated choruses should return to a recognisably similar world, with small variations.
- transitionIn says how we arrive in this section from the previous one. Prefer transitions that feel continuous: time_shift or weather_shift when the setting stays the same; pan_up/pan_down to travel through the sky between settings; pan_left/pan_right for a journey; zoom_in to go deeper or inward; dissolve for dreamlike shifts; flash for an explosive drop; fade_black for an ending or rupture. The first section's transitionIn is how the song opens (usually fade_black or dissolve).
- Give one moment per lyric line, in order. A moment lists the full set of subjects visible during that line (not a diff): keep subjects that should persist, add new ones as the line introduces them, drop ones that should leave. 0-4 subjects per moment; fewer is calmer. Positions: left/center/right are on the ground, far is small in the distance, sky is up high, foreground is close and large.
- Mark exactly one subject per moment with focus: true when the line is about something in particular (the person, the object, the symbol the words point at); it is lit from behind, and in a close shot it fills the frame. Use focus: false everywhere else, and on all subjects of a purely atmospheric line.
- Each moment has a shot, like a film's shot list: wide shows the whole place with small figures (openings, a new world, loneliness, scale, endings); medium frames people head to toe and is the default for most lines; close fills the frame with the focus subject (a face-to-face line, a named object, the emotional peak). Vary shots across a section the way an editor cuts: establish wide, move in to medium, save close for the lines that matter most, and don't stay close for long.
- Be specific and literal where the lyrics are concrete: if the song names a sunflower, a ship, a phone, a party, show that thing, not a generic stand-in. Choose settings that match places the lyrics mention (a club for a party, a river for a river, a rooftop for a city-at-night high point).
- Only for a small prop that is central to the song and missing from the vocabulary (a ring, a key on a chain, a paper boat) you may draw a sprite: at most 2 per song, 8-16 pixels on each side, a palette of 3-6 hex colours with a dark outline first, rows of equal length where "." is transparent and digits 0-9 index the palette. Use it in a moment with kind "custom" and custom set to its name; for every other subject set custom to "". Do not also list a drawn sprite in unmapped.
- road and river run into the distance: there, motion walk or drift means travelling along them, away from the viewer. A road with no one on it reads as the view from a moving car; a car on the road means driving.
- particles adds atmosphere for that line; event is a one-shot accent on that line (use sparingly, for emphasis). intensity 0-1 is how emotionally charged the line is.
- Describe the cast once for the whole song: lead is the singer or narrator (the "I"), partner is the other person the song is about or sung to ("you", "she", "he"), child is any child who appears. Read gender, age and look from the lyrics and the artist when they say something (a red dress, grey hair, a little girl); otherwise choose a look that fits the song's world and mood. Give skin, hair, top and bottom as hex colours; outfit is pants, shorts, skirt or dress (a dress uses the top colour). Every figure subject is drawn as these people: single figures (lone, walking, sitting, reaching, dancing, umbrella) are the lead, couples are lead plus partner, child is the child.
- Pick one style for the whole song from its genre and mood: synthwave (80s/electronic/neon), lofi (chill/bedroom/hip-hop beats), noir (jazz/blues/smoky/dark pop), storybook (folk/acoustic/children's/whimsical), metal (rock/metal/aggressive), dream (shoegaze/ambient/ethereal/dream pop), ukiyoe (Japanese woodblock print: calm, traditional, nature, Japanese or East Asian songs), impressionist (painterly brushstrokes: romantic, classical, nostalgic, sunlit), watercolor (soft washes: gentle, acoustic, tender, melancholy-sweet), gameboy (4-shade green handheld: playful, chiptune, retro-nerdy), nes (8-bit console: upbeat chiptune, game-like, energetic retro), comic (ink outlines and halftone: punk, hip-hop swagger, bold storytelling), natural (anything else).
- Heavy themes (violence, drugs, self-harm, abuse, sex) are pictured through metaphor and atmosphere: storms, wilted flowers, chains, a lone figure, a fading light. Never depict them literally.
- The vocabulary is fixed. When a line calls for something you cannot express, choose the closest available picture and add the missing concept (a short noun phrase, e.g. "lighthouse beam", "broken mirror") to unmapped.
- Lyrics may be in any language; interpret them in their own language.`;

function fmt(t: number): string {
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

export interface PseudoLine {
  t: number;
  text: string;
}

// Per-axis descriptors worth showing: the model's top picks, dropped when the calibrated score
// says the audio barely leans that way.
const MIN_DESCRIPTOR_Z = 0.5;

function lineSpan(timeline: { t: number }[], start: number, end: number): string {
  const idx = timeline.flatMap((l, i) => (l.t >= start - 0.5 && l.t < end - 0.5 ? [i] : []));
  if (!idx.length) return "";
  return idx.length === 1 ? `line ${idx[0]}` : `lines ${idx[0]}-${idx[idx.length - 1]}`;
}

export function audioBlock(analysis: SongAnalysis, timeline: { t: number }[]): string {
  const { tempo } = analysis;
  const shaky = tempo.confidence < 0.45 ? `; low confidence ${tempo.confidence.toFixed(2)}, may be half or double` : "";
  const segs = analysis.segments.map((s) => {
    const span = lineSpan(timeline, s.start, s.end);
    return `  ${fmt(s.start)}-${fmt(s.end)}  ${s.label.padEnd(2)}  energy ${s.energy.toFixed(2)}${span ? `  (${span})` : ""}`;
  });
  const hints = Object.entries(analysis.descriptors)
    .map(([axis, ds]) => {
      const top = ds.filter((d) => d.z >= MIN_DESCRIPTOR_Z).slice(0, 3);
      return top.length ? `  ${axis}: ${top.map((d) => `${d.label} (z ${d.z.toFixed(1)})`).join(", ")}` : "";
    })
    .filter(Boolean);
  return [
    "Audio (measured from the recording itself):",
    `- Tempo: about ${Math.round(tempo.bpm)} BPM, ${tempo.beatsPerBar ?? 4} beats per bar${shaky}.`,
    "- Structure: parts of the song in time order. The same letter means the same music returning; ′ marks a variation of it. Energy is 0-1 within this song.",
    ...segs,
    ...(hints.length
      ? [
          "- Sound impressions. These are hints from an audio-text model and are often wrong (vocals, era and genre especially), so the lyrics win whenever they disagree; use them only for choices the words leave open, like the look, the weather and the energy of a scene. z above 1.5 is a strong lean:",
          ...hints,
        ]
      : []),
    "How to use the audio:",
    "- A line marked (instrumental) is a stretch with no singing. Start a new section at every such line and give it a world of its own that sets up or answers the sung parts around it: label it intro before the first sung line, outro after the last, instrumental in between. Fill it with atmosphere and slow change rather than people mid-story.",
    "- Sections over the same letter are the same music coming back: give them the same section label and the same world, so a returning chorus returns to its place. Vary the moments, not the world.",
    "- Begin and end your sections where the structure changes when the lyrics allow it. Section changes are moved onto the nearest bar line automatically.",
    "- Let energy shape the scenes: quiet parts are calm, sparse and wide; the loudest parts carry the strongest events and the most motion.",
  ].join("\n");
}

export interface AudioPromptInput {
  analysis: SongAnalysis;
  // Lyric lines with instrumental markers interleaved; the line indices the model answers with.
  timeline: TimelineEntry[] | null;
}

export function buildUserPrompt(
  track: Track,
  lyrics: Lyrics,
  pseudo: PseudoLine[] | null,
  userDirection: string,
  librarySprites: string[] = [],
  withReference = false,
  audio: AudioPromptInput | null = null,
): string {
  const head = [
    `Title: ${track.title || "(unknown)"}`,
    `Artist: ${track.artist || "(unknown)"}`,
    track.album ? `Album: ${track.album}` : "",
    `Length: ${fmt(track.duration)}`,
  ].filter(Boolean);

  let body: string;
  if (pseudo) {
    body =
      `This track has no lyrics available${lyrics.instrumental ? " (it is instrumental)" : ""}. ` +
      `Instead, each "line" below is a time segment with its loudness (0 = silent, 1 = loudest part). ` +
      `Imagine scenes from the title, the artist's world and the energy shape. Treat each segment index as a line index.\n\n` +
      pseudo.map((p, i) => `[${i}] ${p.text}`).join("\n");
  } else {
    const lines = audio?.timeline ?? lyrics.lines;
    body =
      `Lyrics (line index, start time, text)${lyrics.synced ? "" : " — timing is approximate"}:\n\n` +
      lines.map((l, i) => `[${i}] ${fmt(l.t)} ${l.text}`).join("\n");
  }
  if (audio) body += `\n\n${audioBlock(audio.analysis, pseudo ?? audio.timeline ?? lyrics.lines)}`;

  const direction = userDirection.trim()
    ? `\n\nThe listener has given this direction for the scenes; follow it where it applies:\n${userDirection.trim()}`
    : "";

  const library = librarySprites.length
    ? `\n\nPreviously drawn sprites you can reuse with kind "custom" without redrawing: ${librarySprites.slice(0, 80).join(", ")}.`
    : "";

  const reference = withReference
    ? `\n\nThe attached image is the listener's visual reference. Let it shape the worlds you choose: its kinds of places, time of day, weather, light and mood, and the sort of objects in it (draw sprites in its spirit when it shows something central the vocabulary lacks). The lyrics still decide what each moment is about; the reference decides how that world looks and feels.`
    : "";

  return `${head.join("\n")}\n\n${body}${direction}${library}${reference}`;
}
