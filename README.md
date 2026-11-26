# Visual Music Player

A web music player that pictures what a song *means*. An LLM reads the lyrics once and writes a
scene script; a procedural pixel-art engine draws that script in sync with playback, and the music
drives how alive the scene is. The design and roadmap live in [SPEC.md](SPEC.md).

Static site: Vite + TypeScript, no UI framework, no backend.

![Before and after: the ?demo reel on main (left) and with sprite-sheet people, shot framing and a caption-safe area (right)](docs/before-after.gif)

*Left: `main` before Phase 1. Right: sprite-sheet people with planted feet, shot framing, and
subjects kept above the captions and player bar. Both sides are `?demo&t=…&freeze` frames at
12 fps.*

## Features

- Local-file playback: drag-drop audio files (and `.lrc` sidecars) or remember a folder.
- Lyrics from a local `.lrc` sidecar or [LRCLIB](https://lrclib.net), with word timing and a
  per-song offset.
- Scene scripts from Claude (subscription or API key) or a local Ollama model, constrained to a
  closed vocabulary so every scene is drawable, and cached per song and model.
- 13 looks (natural, synthwave, lo-fi, noir, storybook, Game Boy, ukiyo-e, …), or a palette taken from
  a reference image.
- People drawn from LPC sprite sheets (walk, idle, sit, reach and dance cycles), recoloured from the
  song's cast, with feet that stay planted while walking.
- A shot per lyric line (wide, medium or close) that sets subject size and where the horizon sits,
  and keeps people above the captions and player bar.
- Kinetic pixel captions, section transitions, and a JSON scene editor with export/import.
- A built-in `?demo` showcase that needs no audio files and no LLM.

## Run it

Requires Node.js 22 (see `.nvmrc`; Vite 8 needs 20.19+ or 22.12+) and a desktop Chromium browser.
Firefox and Safari can play local files but lack the folder picker.

```sh
git clone https://github.com/karanr17/visual-music-player.git
cd visual-music-player
npm ci
npm run dev
```

Open the URL Vite prints (usually <http://localhost:5173>) and drop an audio file onto the page.

Other scripts:

| Command | What it does |
|---|---|
| `npm run typecheck` | `tsc --noEmit` |
| `npm run build` | typecheck, then a static build into `dist/` |
| `npm run preview` | serve the built `dist/` |
| `scripts/check-secrets.sh` | the no-secrets check CI runs (add `--history` to scan every commit) |
| `node scripts/build-characters.mjs <lpc>` | rebuild the character atlas from a checkout of the LPC generator (see [CREDITS.md](CREDITS.md)) |

## The `?demo` showcase

Open <http://localhost:5173/?demo> to play a built-in reel that walks through every setting and a
spread of transitions, subjects and weather, with captions. It uses a hand-written scene script, so
it works offline with no provider configured.

| Parameter | Effect |
|---|---|
| `t=<seconds>` | start at that point in the reel |
| `freeze` | hold that frame (useful for screenshots) |
| `style=<name>` | force a look: `natural`, `synthwave`, `lofi`, `noir`, `storybook`, `metal`, `dream`, `ukiyoe`, `impressionist`, `watercolor`, `gameboy`, `nes`, `comic` |

Example: `/?demo&t=70&freeze&style=gameboy`.

## Scene providers

Pick one in **Settings → Scene imagination**. In *Auto* the player tries them in this order:

1. **Claude subscription via Claude Code** (dev server only). `npm run dev` adds a local bridge
   (`/api/claude-code` in `vite.config.ts`) that runs the `claude` CLI, so generation bills your
   Claude plan instead of API credits. Install [Claude Code](https://claude.com/claude-code) and log in;
   the settings dialog shows whether the CLI was found. The bridge accepts same-origin requests only
   and runs the CLI with tools, MCP and settings files disabled. A static build has no bridge.
2. **Claude API key.** Paste a key into the settings dialog. It is stored in this browser's
   `localStorage` and sent only to `api.anthropic.com`.
3. **Ollama** (local). Set the URL and model in the settings dialog (defaults
   `http://localhost:11434`, `llama3.1`). Start Ollama with `OLLAMA_ORIGINS=*` (or this page's
   origin) so it accepts browser requests.

Choose *Off* to get ambient scenes with no LLM at all.

### Keys stay out of the repo

The app never reads a key from a file: keys are entered in the UI at runtime. If you keep keys in a
local `.env` for your own tooling, `.env*` is gitignored. CI runs `scripts/check-secrets.sh`, which
fails the build if an API key pattern, an email address, an env file, or a listening-history export
(Google Takeout, Spotify streaming history) is committed.

## Keyboard

| Key | Action |
|---|---|
| Space | play / pause |
| ← / → | seek 5 s (Shift: previous / next track) |
| `L` | toggle captions |
| `F` | fullscreen |
| `E` | open the scene editor |
| `[` / `]` | lyric offset −/+ 0.1 s |

## License and credits

Code: [MIT](LICENSE). The character sprites are third-party art under their own licences (OGA-BY
3.0, CC-BY 3.0 or CC0) by the Liberated Pixel Cup artists; see [CREDITS.md](CREDITS.md) for the
authors, licences and per-file credits.
