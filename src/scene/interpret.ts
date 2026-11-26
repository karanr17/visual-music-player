import Anthropic from "@anthropic-ai/sdk";
import type { Settings } from "../settings";
import { normalizeOutput, outputJsonSchema } from "./normalize";
import { SYSTEM_PROMPT } from "./prompt";
import type { ModelOutput } from "./schema";

export interface ImagePart {
  mediaType: "image/jpeg";
  data: string;
}

export class InterpretError extends Error {}
// No provider is usable at all (no key, Ollama not running): the ambient scene stays, not an error.
export class NoProviderError extends InterpretError {}

async function viaClaude(settings: Settings, userPrompt: string, signal: AbortSignal, library: string[], image: ImagePart | null): Promise<ModelOutput> {
  // The key is the user's own, kept in their browser; there is no server to proxy through.
  const client = new Anthropic({ apiKey: settings.apiKey, dangerouslyAllowBrowser: true });
  const stream = client.messages.stream(
    {
      model: settings.model,
      max_tokens: 32000,
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: image
            ? [{ type: "image", source: { type: "base64", media_type: image.mediaType, data: image.data } }, { type: "text", text: userPrompt }]
            : userPrompt,
        },
      ],
      output_config: { format: { type: "json_schema", schema: outputJsonSchema() }, effort: "medium" },
    },
    { signal },
  );
  const msg = await stream.finalMessage();
  if (msg.stop_reason === "refusal") {
    throw new InterpretError(`Claude declined this song (${msg.stop_details?.category ?? "policy"})`);
  }
  if (msg.stop_reason === "max_tokens") throw new InterpretError("Scene script was cut off (max_tokens)");
  const text = msg.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
  return parseOutput(parseJson(text, "Claude"), "Claude", library);
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
async function viaClaudeCode(settings: Settings, userPrompt: string, signal: AbortSignal, library: string[], image: ImagePart | null): Promise<ModelOutput> {
  let res: Response;
  try {
    res = await fetch(BRIDGE, {
      method: "POST",
      signal,
      headers: BRIDGE_HEADERS,
      body: JSON.stringify({ system: SYSTEM_PROMPT, prompt: userPrompt, schema: outputJsonSchema(), model: settings.model, image }),
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
  return parseOutput(data.output, "Claude Code", library);
}

function parseJson(text: string, who: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new InterpretError(`${who} returned text that isn't JSON`);
  }
}

function parseOutput(raw: unknown, who: string, library: string[]): ModelOutput {
  const { output, repaired } = normalizeOutput(raw, library);
  if (repaired.length) console.warn(`[interpret] ${who} used values outside the vocabulary; replaced:`, repaired);
  return output;
}

async function viaOllama(settings: Settings, userPrompt: string, signal: AbortSignal, library: string[]): Promise<ModelOutput> {
  const url = settings.ollamaUrl.replace(/\/$/, "");
  let res: Response;
  try {
    res = await fetch(`${url}/api/chat`, {
      method: "POST",
      signal,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: settings.ollamaModel,
        stream: false,
        format: outputJsonSchema(),
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: userPrompt },
        ],
      }),
    });
  } catch (err) {
    if (signal.aborted) throw err;
    throw new NoProviderError(`Ollama isn't reachable at ${url}`);
  }
  if (!res.ok) throw new InterpretError(`Ollama ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return parseOutput(parseJson(data.message?.content ?? "", "Ollama"), "Ollama", library);
}

export async function interpret(
  settings: Settings,
  userPrompt: string,
  signal: AbortSignal,
  library: string[] = [],
  image: ImagePart | null = null,
): Promise<{ output: ModelOutput; provider: "claude" | "ollama" }> {
  const { provider } = settings;
  if (provider === "off") throw new NoProviderError("Scene generation is turned off");
  // Auto order: the Claude subscription (via Claude Code) first, then API credits, then local Ollama.
  const attempts: [boolean, () => Promise<ModelOutput>, "claude" | "ollama"][] = [
    [provider === "auto" || provider === "claude-code", () => viaClaudeCode(settings, userPrompt, signal, library, image), "claude"],
    [(provider === "auto" || provider === "claude") && !!settings.apiKey, () => viaClaude(settings, userPrompt, signal, library, image), "claude"],
    [provider === "auto" || provider === "ollama", () => viaOllama(settings, userPrompt, signal, library), "ollama"],
  ];
  let firstRealError: unknown = null;
  let lastUnavailable: NoProviderError | null = null;
  for (const [enabled, run, name] of attempts) {
    if (!enabled) continue;
    try {
      return { output: await run(), provider: name };
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
}
