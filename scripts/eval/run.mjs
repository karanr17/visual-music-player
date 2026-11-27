#!/usr/bin/env node
// Scene-script eval. Runs the TypeScript harness through Vite so it uses the player's own code.
//
//   node scripts/eval/run.mjs generate --arm two-v1 --mode two
//   node scripts/eval/run.mjs generate --arm baseline --mode legacy --baseline-root ../main-checkout
//   node scripts/eval/run.mjs judge --arm two-v1
//   node scripts/eval/run.mjs report --arms baseline,two-v1
//
// See scripts/eval/harness.ts for the options and docs/eval/README.md for the method.

import { createServer } from "vite";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const root = resolve(fileURLToPath(import.meta.url), "../../..");
const opts = (r) => ({ root: r, configFile: false, server: { middlewareMode: true, hmr: false }, appType: "custom", logLevel: "error" });
const server = await createServer(opts(root));
const argv = process.argv.slice(2);
const bi = argv.indexOf("--baseline-root");
const baseline = bi >= 0 ? await createServer(opts(resolve(argv[bi + 1]))) : null;
try {
  const h = await server.ssrLoadModule("/scripts/eval/harness.ts");
  await h.main(argv, { root, baseline: baseline ? (p) => baseline.ssrLoadModule(p) : null });
} finally {
  await server.close();
  await baseline?.close();
}
