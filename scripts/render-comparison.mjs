#!/usr/bin/env node
// Renders two scene scripts for the same song side by side, with the song's audio, into an mp4.
// Frames come from the player's ?capture mode, so they are exactly what the renderer draws at
// each time, not a screen recording.
//
//   npm i --no-save playwright && npm run dev   (in another terminal)
//   node scripts/render-comparison.mjs --audio song.mp3 --lrc song.lrc --analysis song.analysis.json \
//     --left without.json --right with.json --from 0 --to 140 --out docs/comparison.mp4
//
// A scene script JSON is what the editor (E) shows, or one entry of "Export all scripts".

import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

const { values: a } = parseArgs({
  options: {
    audio: { type: "string" },
    lrc: { type: "string" },
    analysis: { type: "string" },
    left: { type: "string" },
    right: { type: "string" },
    "left-title": { type: "string", default: "Without analysis" },
    "right-title": { type: "string", default: "With SongAnalysis" },
    from: { type: "string", default: "0" },
    to: { type: "string" },
    fps: { type: "string", default: "12" },
    url: { type: "string", default: "http://localhost:5173" },
    out: { type: "string", default: "comparison.mp4" },
  },
});
for (const k of ["audio", "left", "right", "to"]) if (!a[k]) throw new Error(`--${k} is required`);

const { chromium } = await import("playwright");
const from = Number(a.from);
const to = Number(a.to);
const fps = Number(a.fps);
const work = join(tmpdir(), `vmp-comparison-${process.pid}`);
mkdirSync(work, { recursive: true });

// The installed Chrome avoids a separate Playwright browser download.
const browser = await chromium.launch({ channel: "chrome" }).catch(() => chromium.launch());
const page = await browser.newPage();
// The audio is handed to the page through a routed URL so it never has to be served or committed.
await page.route("**/__capture/audio", (r) => r.fulfill({ body: readFileSync(a.audio), contentType: "audio/mpeg" }));

async function side(name, scriptPath, title, analysisPath) {
  await page.goto(`${a.url}/?capture`);
  await page.waitForFunction(() => "vmpCapture" in window);
  const input = {
    script: JSON.parse(readFileSync(scriptPath, "utf8")),
    lrc: a.lrc ? readFileSync(a.lrc, "utf8") : undefined,
    analysis: analysisPath ? JSON.parse(readFileSync(analysisPath, "utf8")) : undefined,
    audioUrl: "/__capture/audio",
    title,
  };
  await page.evaluate((i) => window.vmpCapture.load(i), input);
  const dir = join(work, name);
  mkdirSync(dir, { recursive: true });
  const n = Math.round((to - from) * fps);
  for (let f = 0; f < n; f++) {
    const url = await page.evaluate((t) => window.vmpCapture.frame(t), from + f / fps);
    writeFileSync(join(dir, `${String(f).padStart(5, "0")}.png`), Buffer.from(url.split(",")[1], "base64"));
    if (f % 120 === 0) process.stdout.write(`${name} ${f}/${n}\n`);
  }
  return dir;
}

const left = await side("left", a.left, a["left-title"], null);
const right = await side("right", a.right, a["right-title"], a.analysis);
await browser.close();

const ff = spawnSync(
  "ffmpeg",
  [
    "-y", "-loglevel", "error",
    "-framerate", String(fps), "-i", join(left, "%05d.png"),
    "-framerate", String(fps), "-i", join(right, "%05d.png"),
    "-ss", String(from), "-t", String(to - from), "-i", a.audio,
    "-filter_complex", "[0][1]hstack=inputs=2,pad=iw+8:ih:4:0:black[v]",
    "-map", "[v]", "-map", "2:a",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "30", "-preset", "slow", "-tune", "animation",
    "-c:a", "aac", "-b:a", "96k", "-shortest", "-movflags", "+faststart",
    resolve(a.out),
  ],
  { stdio: "inherit" },
);
rmSync(work, { recursive: true, force: true });
process.exit(ff.status ?? 1);
