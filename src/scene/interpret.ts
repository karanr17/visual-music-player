import Anthropic from "@anthropic-ai/sdk";
import type { Settings } from "../settings";

export interface ImagePart {
  mediaType: "image/jpeg";
  data: string;
}

export class InterpretError extends Error {}
// No provider is usable at all (no key, Ollama not running): the ambient scene stays, not an error.
export class NoProviderError extends InterpretError {}

// One structured-output call. `model` is the Claude model; `ollamaModel` the local one.
export interface ModelRequest {
  system: string;
  prompt: string;
  schema: Record<string, unknown>;
  model: string;
  ollamaModel: string;
  maxTokens: number;
  image?: ImagePart | null;
}

export type ProviderName = "claude" | "ollama";

// What the scene pipeline calls a model through; the eval harness supplies its own.
export type ModelCaller = (req: ModelRequest, signal: AbortSignal) => Promise<{ raw: unknown; provider: ProviderName }>;

async function viaClaude(settings: Settings, req: ModelRequest, signal: AbortSignal): Promise<unknown> {
  // The key is the user's own, kept in their browser; there is no server to proxy through.
  const client = new Anthropic({ apiKey: settings.apiKey, dangerouslyAllowBrowser: true });
  const stream = client.messages.stream(
    {
      model: req.model,
      max_tokens: req.maxTokens,
      system: req.system,
      messages: [
        {
          role: "user",
          content: req.image
            ? [{ type: "image", source: { type: "base64", media_type: req.image.mediaType, data: req.image.data } }, { type: "text", text: req.prompt }]
            : req.prompt,
        },
      ],
      output_config: { format: { type: "json_schema", schema: req.schema }, effort: "medium" },
    },
    { signal },
  );
  const msg = await stream.finalMessage();
  if (msg.stop_reason === "refusal") {
    throw new InterpretError(`Claude declined this song (${msg.stop_details?.category ?? "policy"})`);
  }
  if (msg.stop_reason === "max_tokens") throw new InterpretError("Scene script was cut off (max_tokens)");
  const text = msg.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
  return parseJson(text, "Claude");
}

const BRIDGE = "/api/claude-code";
const BRIDGE_HEADERS = { "content-type": "application/json", "x-vmp-bridge": "1" };

export async function claudeCodeAvailable(): Promise<{ available: boolean; version?: string }> {
  try {
    const res = await fetch(BRIDGE, { headers: BRIDGE_HEADERS });
    return res.ok ? await res.json() : { available: false };
  } catch {
    return { available: false };
  }
}

// Runs through the local Claude Code CLI via the dev server, billed to the user's Claude plan.
async function viaClaudeCode(req: ModelRequest, signal: AbortSignal): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(BRIDGE, {
      method: "POST",
      signal,
      headers: BRIDGE_HEADERS,
      body: JSON.stringify({ system: req.system, prompt: req.prompt, schema: req.schema, model: req.model, image: req.image ?? null }),
    });
  } catch (err) {
    if (signal.aborted) throw err;
    throw new NoProviderError("Claude Code bridge isn't reachable");
  }
  // A static build (no dev server) has no bridge route.
  if (res.status === 404 || res.status === 403) throw new NoProviderError("Claude Code bridge only runs under npm run dev");
  const data = await res.json().catch(() => ({}));
  if (res.status === 503) throw new NoProviderError(data.error ?? "Claude Code CLI not found");
  if (!res.ok) throw new InterpretError(`Claude Code: ${data.error ?? res.status}`);
  return data.output;
}

function parseJson(text: string, who: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new InterpretError(`${who} returned text that isn't JSON`);
  }
}

async function viaOllama(settings: Settings, req: ModelRequest, signal: AbortSignal): Promise<unknown> {
  const url = settings.ollamaUrl.replace(/\/$/, "");
  let res: Response;
  try {
    res = await fetch(`${url}/api/chat`, {
      method: "POST",
      signal,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: req.ollamaModel,
        stream: false,
        format: req.schema,
        messages: [
          { role: "system", content: req.system },
          { role: "user", content: req.prompt },
        ],
      }),
    });
  } catch (err) {
    if (signal.aborted) throw err;
    throw new NoProviderError(`Ollama isn't reachable at ${url}`);
  }
  if (!res.ok) throw new InterpretError(`Ollama ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return parseJson(data.message?.content ?? "", "Ollama");
}

// The player's providers in Auto order: the Claude subscription (via Claude Code) first, then
// API credits, then local Ollama.
export function providerCaller(settings: Settings): ModelCaller {
  return async (req, signal) => {
    const { provider } = settings;
    if (provider === "off") throw new NoProviderError("Scene generation is turned off");
    const attempts: [boolean, () => Promise<unknown>, ProviderName][] = [
      [provider === "auto" || provider === "claude-code", () => viaClaudeCode(req, signal), "claude"],
      [(provider === "auto" || provider === "claude") && !!settings.apiKey, () => viaClaude(settings, req, signal), "claude"],
      [provider === "auto" || provider === "ollama", () => viaOllama(settings, req, signal), "ollama"],
    ];
    let firstRealError: unknown = null;
    let lastUnavailable: NoProviderError | null = null;
    for (const [enabled, run, name] of attempts) {
      if (!enabled) continue;
      try {
        return { raw: await run(), provider: name };
      } catch (err) {
        if (signal.aborted) throw err;
        if (err instanceof NoProviderError) lastUnavailable = err;
        else {
          firstRealError ??= err;
          console.warn("[interpret] provider failed, trying the next one", err);
        }
      }
    }
    // A provider that actually failed explains more than one that simply wasn't running.
    if (firstRealError) throw firstRealError;
    throw lastUnavailable ?? new NoProviderError("No scene provider available: run under npm run dev with Claude Code, add an API key, or run Ollama");
  };
}
