import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Runs one structured-output request through the local Claude Code CLI, billed to the user's
// Claude plan. Used by the dev server's bridge and by the scene eval harness.

const TIMEOUT_MS = 4 * 60_000;
// Empty working dir so no project CLAUDE.md or auto-memory is pulled into the prompt.
const WORKDIR = join(tmpdir(), "visual-music-player-claude");

export interface BridgeRequest {
  system: string;
  prompt: string;
  schema: unknown;
  model: string;
  image?: { mediaType: string; data: string } | null;
}

export function claudeVersion(): string | null {
  const r = spawnSync("claude", ["--version"], { encoding: "utf8", timeout: 10_000 });
  return r.status === 0 ? r.stdout.trim() : null;
}

const BRIDGE_LOG = join(WORKDIR, "bridge.log");

export function log(msg: string): void {
  try {
    mkdirSync(WORKDIR, { recursive: true });
    appendFileSync(BRIDGE_LOG, `${new Date().toISOString()} ${msg}\n`);
  } catch {
    // Diagnostics only.
  }
}

export function runClaude(input: BridgeRequest, signal?: AbortSignal): Promise<{ output: unknown; costUsd?: number; ms: number }> {
  mkdirSync(WORKDIR, { recursive: true });
  // Images can only be passed as a structured user message, which requires stream-json on both ends.
  const withImage = !!input.image;
  const args = [
    "-p",
    ...(withImage ? ["--input-format", "stream-json", "--output-format", "stream-json", "--verbose"] : ["--output-format", "json"]),
    "--json-schema", JSON.stringify(input.schema),
    "--model", input.model,
    "--effort", "medium",
    "--system-prompt", input.system,
    "--tools", "",
    "--no-session-persistence",
    "--strict-mcp-config",
    "--disable-slash-commands",
    "--setting-sources", "",
  ];
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const child = spawn("claude", args, { cwd: WORKDIR, stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error("Claude Code took longer than 4 minutes"));
    }, TIMEOUT_MS);
    // An abort (the browser closing the request on a track change or regenerate) stops spending usage on it.
    signal?.addEventListener("abort", () => {
      if (child.exitCode === null) child.kill("SIGTERM");
    });
    child.stdout.on("data", (c) => (out += c));
    child.stderr.on("data", (c) => (err += c));
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(new Error(`Couldn't start Claude Code: ${e.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      let parsed: { is_error?: boolean; result?: string; structured_output?: unknown; total_cost_usd?: number } | null = null;
      try {
        const line = withImage ? out.trim().split("\n").reverse().find((l) => l.includes('"type":"result"')) : out;
        parsed = line ? JSON.parse(line) : null;
      } catch {
        // Fall through: non-JSON output means the CLI failed before producing a result.
      }
      if (!parsed) return reject(new Error(err.trim() || out.trim() || `Claude Code exited with code ${code}`));
      if (parsed.is_error || parsed.structured_output === undefined) {
        return reject(new Error(parsed.result || "Claude Code returned no structured output"));
      }
      resolve({ output: parsed.structured_output, costUsd: parsed.total_cost_usd, ms: Date.now() - started });
    });
    if (withImage) {
      const content = [
        { type: "image", source: { type: "base64", media_type: input.image!.mediaType, data: input.image!.data } },
        { type: "text", text: input.prompt },
      ];
      child.stdin.end(JSON.stringify({ type: "user", message: { role: "user", content } }) + "\n");
    } else child.stdin.end(input.prompt);
  });
}

