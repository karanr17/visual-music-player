# Visual Music Player — Spec

A web music player that **pictures what a song means**. An LLM reads the lyrics once and writes a
*scene script*; a procedural pixel-art engine draws that script in sync with playback; the music
itself drives how alive the scene is. Abstract "audio-reactive" shapes are explicitly *not* the goal —
meaning and feeling are.

## 1. Platform

- Static site, no backend. Vite + TypeScript, no UI framework (the core is a canvas loop).
- Exception, dev-time only: the Vite dev server hosts a local **Claude Code bridge** (`vite.config.ts`,
  `POST /api/claude-code`) that runs `claude -p --json-schema …` so scene generation bills the user's
  Claude subscription instead of API credits. It is same-origin only (custom header + Origin check) and
  runs with tools, MCP, slash commands and settings files disabled, from an empty temp directory.
- Target: desktop Chromium first. Local-file playback must also work in Firefox and Safari.
- Personal / portfolio use: user supplies their own Claude API key, stored only in their browser.

## 2. Audio sources

| Phase | Source | Notes |
|---|---|---|
| 1 | Local files | Drag-drop (files and `.lrc` sidecars) or a remembered folder (File System Access API). Artist/title/duration from tags via `music-metadata`. |
| 3 | Spotify, via tab-audio capture | Spotify plays in another tab; `getDisplayMedia({audio})` captures it. Spotify Web API (PKCE, no backend) supplies current track + progress for lyrics and sync. Chromium desktop only. |

Spotify's Web Playback SDK exposes no audio samples (DRM), and its Audio Analysis / Audio Features
endpoints are unavailable to new apps (Nov 2024), so it cannot be the analysis source.

## 3. Lyrics

- Sources, in order: a local `.lrc` sidecar (it was placed there on purpose and matches that exact
  recording), then **LRCLIB** (`lrclib.net`, free, no key). Sidecars pair by exact base name, else by
  the lyric file's own `[ti]`/`[ar]` tags or name words appearing in the track; one audio + one `.lrc`
  dropped together always pair. Ripped titles ("Artist - Song (Official Video)(MP3_128K)", VEVO
  channels) are cleaned before lookup.
- Synced (LRC) lyrics are used directly. Enhanced LRC word times (`<mm:ss.xx>`) are honoured; otherwise
  word times are interpolated across the line by character length.
- Plain (unsynced) lyrics are spread across the track as a rough fallback and flagged as unsynced.
- Per-song lyric offset in 0.1 s steps (`[` / `]`), persisted.
- Captions are a toggle (`L`). When on they render as kinetic pixel typography: words pop in on their
  timestamps.

## 4. Meaning → scene script

- Providers, in auto order: the Claude subscription via the Claude Code bridge, then an API key
  (browser-direct), then local Ollama. Model selectable — default `claude-haiku-5-5`. One call per
  song; result cached.
- The model returns a structured object constrained to a **closed vocabulary** (structured outputs),
  so every scene is drawable. It also returns `unmapped`: concepts it wanted but could not express.
  These are aggregated so the library can grow where it matters.
- Granularity: **a section sets a world; each line evolves it.**
  - Section world: `setting`, `timeOfDay`, `weather`, `mood` (palette), `camera`.
  - Line moment: visible `subjects` (kind, position, motion), `particles`, a one-shot `event`,
    `intensity`.
  - Section `transitionIn` intent: how we arrive in this world from the previous one.
- Each moment marks one **focus** subject, the thing the line is about: drawn at 2× with a stronger
  backlight, like a close-up. Concrete lyric images are shown literally where the vocabulary allows.
- **Model-drawn sprites:** when a central image isn't in the vocabulary, the model draws it (≤4 per song,
  12–32 px, a hex palette, rows of palette indices, "." transparent) and uses it as `kind: "custom"`.
  Sprites go into a shared library (IndexedDB) offered to later songs for reuse; each script embeds the
  sprites it uses so exports stay self-contained.
- Heavy themes (violence, drugs, self-harm, sex) are pictured through metaphor and atmosphere, never
  depicted literally.
- Style family per song (synthwave, lofi, noir, storybook, metal, dream, natural), overridable.
- No lyrics → the model gets title, artist and a per-segment energy summary and builds scenes from those.
- A per-song free-text **scene prompt** can steer or override interpretation.
- The cached script is the product's real artifact: editable as raw JSON (`E`), validated on save,
  exportable/importable as one file.

### Compiled scene script (cached, editable)

```ts
SceneScript {
  version: 1
  trackKey: string
  source: "claude" | "ollama" | "ambient" | "manual"
  style: StyleFamily
  sections: [{
    label, start, end,           // seconds
    world: { setting, timeOfDay, weather, mood, camera },
    transitionIn, transitionDuration,
    moments: [{ t, subjects: [{ kind, position, motion }], particles, event, intensity }]
  }]
  unmapped: string[]
}
```

The model is asked for line *indices*, never timestamps; times are compiled from the lyrics on our
side so the model can't drift the sync.

## 5. Rendering

- Scenes are authored in a 320×180 logical space; the framebuffer is 2× that (640×360,
  `Uint32Array` → `ImageData`), so shapes, gradients and motion land on half-pixels while sprite
  art keeps its chunky pixels. Scaled up with `image-rendering: pixelated`, letterboxed.
- 60 fps, dropping to 30 when a frame averages over 11 ms. The render clock runs locally and
  eases toward `audio.currentTime` (never steps backwards); energy and onset are interpolated
  between envelope hops so nothing they drive judders.
- Camera parallax applies to subjects as well as backdrop layers, so figures stay planted on the
  ground while the camera drifts.
- Road and river are depth settings: there, walk/drift move along the road (figures seen from
  behind, cars from the rear) and the road scrolls by a travel distance integrated from per-moment
  speeds (empty road or a car = driving, a walker = walking pace, someone standing = stopped).
- Fully procedural building blocks: dithered sky gradients (Bayer 4×4), noise terrain, water,
  cities, forests, deserts, rooms, roads, space, rivers, flower fields, a club (sweeping beams, lit
  dance floor), rooftops; light rays at dawn/dusk; fireworks and floating hearts; silhouette sprites (figures, couples, birds,
  hearts, flowers, candles, fire, cars, boats, houses…); particle systems (rain, snow, fog, petals,
  embers, fireflies, sparkles, leaves, bubbles, ash).
- Style family = palette rules + post-process (posterize, scanlines, grain, tint).
- Characters are people, not stick figures: a skeleton (so poses animate) dressed with
  shaded limbs, torso, skirt/dress, shoes, a head with one of six hairstyles, and a face (eyes,
  mouth, cheeks) once the head is big enough to read. The scene script carries a `cast`
  (lead = narrator, partner = the "you", child) with gender, age, skin, hair, outfit and colours,
  so the same people appear all song; crowds get stable random looks. Facing: front when
  standing, profile when walking sideways, back when walking down a road.
- One light model for every subject (`lighting.ts`): sky-tinted ambient plus a key light from
  the sun/moon side, so things are shaded toward the light and dim and cool at night; distant
  subjects take atmospheric haze; grounded subjects cast a soft contact shadow away from the
  light. Common objects are drawn from materials (`objects.ts`: leafy trees, houses with lit
  windows and chimney smoke, painted cars with glass and spinning wheels, lamps, benches, boats,
  sunflowers and flowers, doors, dogs, cats, lighthouse); remaining ASCII sprites and
  Claude-drawn sprites are auto-shaded from normals estimated off their silhouette.
- Looks (render-time, switch instantly from the player bar or settings): Auto (Claude's per-song
  style), the mood styles, and art styles — ukiyo-e (woodblock palette, ink outlines, washi
  paper), impressionist (oriented brush dabs following a flow field), watercolour (bleed, pooled
  edges, paper), Game Boy (4 greens, logical-res dither), 8-bit NES (NES palette), comic (bold
  palette, halftone, ink). Palette looks snap via a 32³ LUT, fall back to a flattened original
  where the palette lacks a hue, and replace soft subject backlights with a light rim.
- Reference look: the listener drops an image; a median-cut palette and its colour cast recolour
  every frame. Optionally (default on) the artwork is also shown to Claude when it writes the
  scenes, so places, light and mood follow it; that is cached as a separate generator
  (`model+ref:<id>`). The bridge passes images via `--input-format stream-json`.
- Interpolating motion: walkers' stride phase comes from distance covered (feet plant), they walk
  between positions at a steady pace and face their direction; rooted objects crossfade between
  positions; focus close-ups ease in and out of 2× size.
- Captions render on their own pixel layer at 2× scene resolution so non-Latin scripts stay legible.

## 6. Transitions

- **Between sections**, by intent:
  - Same setting → no cut: parameters blend (sky colours, time of day, weather intensity, light).
  - `pan_up/down/left/right` → camera move with parallax through the shared sky or horizon.
  - `zoom_in` → push into the frame centre, resolving into the next world.
  - `time_shift`, `weather_shift` → parameter blend (falls back to `dissolve` if settings differ).
  - `dissolve` → organic patch dissolve (soft noise threshold with a little ordered dither). `fade_black`, `flash`, `crossfade` as stated.
  - The transition finishes exactly at the section boundary and starts `transitionDuration` before
    it, i.e. in the build-up. Phase 2 snaps the landing to the nearest downbeat.
- **Within a section**, line moments diff against the previous moment: subjects that persist stay,
  new ones fade/grow in over ~0.6 s, removed ones fade out; particle systems cross-ramp.

## 7. Music → energy (live)

| Signal | Drives |
|---|---|
| Loudness | Motion speed: wind, rain, drift |
| Beats | Light flashes, camera bump, pulsing |
| Bass | Weight / slow camera sway |
| Highs | Sparkle and particle density |
| Silence | The scene settles |

Phase 1 uses an offline loudness envelope (decoded once per file). Phase 2 adds live Web Audio
analysis (AnalyserNode bands + onset/beat tracking) and beat-snapped transitions.

## 8. Sync & playback

- The audio element's playback position is the single clock (interpolated between its updates).
  Scene state is a pure function of time, so pause/seek/rate never drift.
- Seeking jumps straight to the correct state with a short dissolve from the previous frame.
- By default a new song waits for its scenes before playing (setting "Wait for scenes"; the status chip
  offers "play now"). With waiting off, an ambient scene plays until the script arrives, then fades in.
  Only the next queued track is generated in the background, to limit plan usage.
- Scene scripts are cached per model, and the player bar has a model picker, so different models'
  readings of the same song can be compared; switching back to a cached model is instant.

## 9. Storage

- `localStorage`: settings (API key, model, provider, captions, style override).
- IndexedDB: scene scripts (key = artist|title|duration + lyrics hash), per-song lyric offset and
  scene prompt, the remembered folder handle, unmapped-concept counts.
- Export / import of all scene scripts (and per-song overrides) as a single JSON file.

## 10. Controls

`Space` play/pause · `←/→` seek 5 s · `Shift+←/→` previous/next track · `L` captions · `F` fullscreen ·
`E` scene editor · `[` / `]` lyric offset −/+0.1 s

## 11. Phases

1. Local playback, library, lyrics, meaning → scene script (Claude/Ollama/ambient), cache, procedural
   renderer, section/line transitions, captions, editor, settings. Offline loudness envelope.
2. Live audio features (bands, onsets, beat tracker) driving the scene; beat-snapped transitions.
3. Spotify mode: tab-audio capture + Web API now-playing for lyrics and sync.
4. Offline analysis CLI (Demucs stems, librosa beats/sections, Basic Pitch melody, Whisper word
   timing) emitting a richer timeline; optional "illustrated" mode with generated per-section images.
