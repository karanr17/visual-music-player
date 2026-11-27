import { afterEach, describe, expect, it, vi } from "vitest";
import { NoProviderError, providerCaller, type ModelRequest } from "./interpret";
import type { Settings } from "../settings";

const req: ModelRequest = { system: "", prompt: "", schema: {}, model: "claude-haiku-5-5", ollamaModel: "llama3.1", maxTokens: 10 };
const settings = { provider: "claude-code", apiKey: "" } as Settings;

afterEach(() => vi.unstubAllGlobals());

describe("Claude Code bridge", () => {
  // GitHub Pages answers the bridge's POST with 405 and an HTML page.
  it("reads a static host's 405 as no bridge, not a failed generation", async () => {
    vi.stubGlobal("fetch", async () => new Response("<html>405</html>", { status: 405, headers: { "content-type": "text/html" } }));
    await expect(providerCaller(settings)(req, new AbortController().signal)).rejects.toBeInstanceOf(NoProviderError);
  });

  it("still reports a real bridge error", async () => {
    vi.stubGlobal("fetch", async () => Response.json({ error: "rate limited" }, { status: 502 }));
    const err = await providerCaller(settings)(req, new AbortController().signal).catch((e) => e);
    expect(err).not.toBeInstanceOf(NoProviderError);
    expect(String(err.message)).toContain("rate limited");
  });
});
