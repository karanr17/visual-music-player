import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig, type Plugin } from "vite";

// Dev-only bridge that runs scene generation through the local Claude Code CLI, so it
// bills the user's Claude subscription instead of API credits. A static build has no
// bridge; the client then falls back to the API key or Ollama.

const ROUTE = "/api/claude-code";
const TIMEOUT_MS = 4 * 60_000;
// Empty working dir so no project CLAUDE.md or auto-memory is pulled into the prompt.
const WORKDIR = join(tmpdir(), "visual-music-player-claude");

interface BridgeRequest {
  system: string;
  prompt: string;
  schema: unknown;
  model: string;
  image?: { mediaType: string; data: string } | null;
}

function claudeVersion(): string | null {
  const r = spawnSync("claude", ["--version"], { encoding: "utf8", timeout: 10_000 });
  return r.status === 0 ? r.stdout.trim() : null;
}

export const BRIDGE_LOG = join(WORKDIR, "bridge.log");

function log(msg: string): void {
  try {
    mkdirSync(WORKDIR, { recursive: true });
    appendFileSync(BRIDGE_LOG, `${new Date().toISOString()} ${msg}\n`);
  } catch {
    // Diagnostics only.
  }
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

function send(res: ServerResponse, status: number, data: unknown): void {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(data));
}

function runClaude(input: BridgeRequest, req: IncomingMessage): Promise<{ output: unknown; costUsd?: number; ms: number }> {
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
    // The browser aborts (track change, regenerate) close the request; stop spending usage on it.
    req.on("close", () => {
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

function claudeCodeBridge(): Plugin {
  let version: string | null | undefined;
  return {
    name: "claude-code-bridge",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use(ROUTE, async (req, res) => {
        version ??= claudeVersion();
        // The custom header forces a CORS preflight that this server never approves,
        // so other websites can't drive the user's subscription through localhost.
        const origin = req.headers.origin;
        const sameOrigin = !origin || origin === `http://${req.headers.host}`;
        if (req.headers["x-vmp-bridge"] !== "1" || !sameOrigin) return send(res, 403, { error: "Forbidden" });
        if (req.method === "GET") return send(res, 200, { available: !!version, version });
        if (req.method !== "POST") return send(res, 405, { error: "Method not allowed" });
        if (!version) return send(res, 503, { error: "Claude Code CLI not found on PATH" });
        try {
          const input = JSON.parse(await readBody(req)) as BridgeRequest;
          log(`request model=${input.model} prompt=${input.prompt.length} chars${input.image ? " +image" : ""}`);
          const result = await runClaude(input, req);
          log(`ok in ${(result.ms / 1000).toFixed(1)}s`);
          server.config.logger.info(
            `[claude-code] scene script in ${(result.ms / 1000).toFixed(1)}s${result.costUsd ? ` (API-equivalent ≈$${result.costUsd.toFixed(4)}, billed to your plan)` : ""}`,
          );
          send(res, 200, { output: result.output });
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e);
          server.config.logger.warn(`[claude-code] ${message}`);
          log(`error: ${message}`);
          if (!res.writableEnded) send(res, 502, { error: message });
        }
      });
    },
  };
}

export default defineConfig({
  plugins: [claudeCodeBridge()],
});
