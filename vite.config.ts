import type { IncomingMessage, ServerResponse } from "node:http";
import { defineConfig, type Plugin } from "vite";
import { claudeVersion, log, runClaude, type BridgeRequest } from "./bridge/claude-cli";

// Dev-only bridge that runs scene generation through the local Claude Code CLI, so it
// bills the user's Claude subscription instead of API credits. A static build has no
// bridge; the client then falls back to the API key or Ollama.

const ROUTE = "/api/claude-code";

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
          const abort = new AbortController();
          // The browser aborts (track change, regenerate) close the request.
          req.on("close", () => abort.abort());
          const result = await runClaude(input, abort.signal);
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
