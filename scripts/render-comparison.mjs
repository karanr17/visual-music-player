#!/usr/bin/env node
// Renders one scene script, or two side by side, for a song into an mp4 with its audio.
// Frames come from the player's ?capture mode, so they are exactly what the renderer draws at
// each time, not a screen recording.
//
//   npm i --no-save playwright && npm run dev   (in another terminal)
//   node scripts/render-comparison.mjs --audio song.mp3 --lrc song.lrc --analysis song.analysis.json \
//     --left without.json --right with.json --from 0 --to 140 --out docs/comparison.mp4
//
// Each side can set --{left,right}-reactivity (off / subtle / strong, default subtle) and
// --{left,right}-analysis (whether that side sees --analysis; by default only the right does).
// Leave out --right for a single picture; --mute drops the audio track.
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
    "left-reactivity": { type: "string", default: "subtle" },
    "right-reactivity": { type: "string", default: "subtle" },
    "left-analysis": { type: "boolean", default: false },
    "right-analysis": { type: "boolean", default: true },
    mute: { type: "boolean", default: false },
    from: { type: "string", default: "0" },
    to: { type: "string" },
    fps: { type: "string", default: "12" },
    url: { type: "string", default: "http://localhost:5173" },
    out: { type: "string", default: "comparison.mp4" },
  },
});
for (const k of ["audio", "left", "to"]) if (!a[k]) throw new Error(`--${k} is required`);

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

async function side(name, scriptPath, title, analysisPath, reactivity) {
  await page.goto(`${a.url}/?capture`);
  await page.waitForFunction(() => "vmpCapture" in window);
  const input = {
    script: JSON.parse(readFileSync(scriptPath, "utf8")),
    lrc: a.lrc ? readFileSync(a.lrc, "utf8") : undefined,
    analysis: analysisPath ? JSON.parse(readFileSync(analysisPath, "utf8")) : undefined,
    audioUrl: "/__capture/audio",
    title,
    reactivity,
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

const left = await side("left", a.left, a["left-title"], a["left-analysis"] ? a.analysis : null, a["left-reactivity"]);
const right = a.right ? await side("right", a.right, a["right-title"], a["right-analysis"] ? a.analysis : null, a["right-reactivity"]) : null;
await browser.close();

const inputs = ["-framerate", String(fps), "-i", join(left, "%05d.png")];
if (right) inputs.push("-framerate", String(fps), "-i", join(right, "%05d.png"));
const audioIdx = right ? 2 : 1;
if (!a.mute) inputs.push("-ss", String(from), "-t", String(to - from), "-i", a.audio);
const ff = spawnSync(
  "ffmpeg",
  [
    "-y", "-loglevel", "error",
    ...inputs,
    "-filter_complex", right ? "[0][1]hstack=inputs=2,pad=iw+8:ih:4:0:black[v]" : "[0]null[v]",
    "-map", "[v]",
    ...(a.mute ? ["-an"] : ["-map", `${audioIdx}:a`, "-c:a", "aac", "-b:a", "96k", "-shortest"]),
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "30", "-preset", "slow", "-tune", "animation",
    "-movflags", "+faststart",
    resolve(a.out),
  ],
  { stdio: "inherit" },
);
rmSync(work, { recursive: true, force: true });
process.exit(ff.status ?? 1);
