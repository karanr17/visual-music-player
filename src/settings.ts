import { DEFAULT_ANALYSIS_URL } from "./analysis/client";
import type { Reactivity } from "./audio/rhythm";
import type { Style } from "./scene/vocab";

export type Provider = "auto" | "claude-code" | "claude" | "ollama" | "off";

export interface Settings {
  apiKey: string;
  model: string;
  provider: Provider;
  ollamaUrl: string;
  ollamaModel: string;
  captions: boolean;
  styleOverride: Style | "auto" | "reference";
  // In the reference look, also show the artwork to Claude so the scenes themselves follow it.
  referenceForScenes: boolean;
  waitForScenes: boolean;
  // Off ignores every analysis source, which also gives a with/without comparison of a song.
  useAnalysis: boolean;
  // How strongly the beat moves the picture; needs a beat grid from the audio analysis.
  reactivity: Reactivity;
  // Base URL of music-connector's `mc serve`; empty means don't ask it for audio analysis.
  analysisUrl: string;
}

export const LOOK_LABELS: Record<Style, string> = {
  natural: "Natural",
  synthwave: "Synthwave",
  lofi: "Lo-fi",
  noir: "Noir",
  storybook: "Storybook",
  metal: "Metal",
  dream: "Dream",
  ukiyoe: "Ukiyo-e woodblock",
  impressionist: "Impressionist",
  watercolor: "Watercolour",
  gameboy: "Game Boy",
  nes: "8-bit NES",
  comic: "Comic",
};

export const CLAUDE_MODELS = [
  { id: "claude-haiku-5-5", short: "Haiku 5.5", label: "Claude Haiku 5.5 (fastest)" },
  { id: "claude-sonnet-5-5", short: "Sonnet 5.5", label: "Claude Sonnet 5.5" },
  { id: "claude-opus-5-5", short: "Opus 5.5", label: "Claude Opus 5.5 (best reading of subtext)" },
  { id: "claude-fable-5-1", short: "Fable 5.1", label: "Claude Fable 5.1 (most capable, if your plan includes it)" },
];

export const modelLabel = (id: string) => CLAUDE_MODELS.find((m) => m.id === id)?.short ?? id;

const DEFAULTS: Settings = {
  apiKey: "",
  model: "claude-haiku-5-5",
  provider: "auto",
  ollamaUrl: "http://localhost:11434",
  ollamaModel: "llama3.1",
  captions: true,
  styleOverride: "auto",
  referenceForScenes: true,
  waitForScenes: true,
  useAnalysis: true,
  reactivity: "subtle",
  analysisUrl: DEFAULT_ANALYSIS_URL,
};

const KEY = "vmp.settings";
type Listener = (s: Settings) => void;
const listeners = new Set<Listener>();

function load(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? { ...DEFAULTS, ...JSON.parse(raw) } : { ...DEFAULTS };
  } catch {
    return { ...DEFAULTS };
  }
}

let current = load();

export function getSettings(): Settings {
  return current;
}

export function updateSettings(patch: Partial<Settings>): void {
  current = { ...current, ...patch };
  try {
    localStorage.setItem(KEY, JSON.stringify(current));
  } catch {
    // Private mode / blocked storage: settings still apply for this session.
  }
  for (const l of listeners) l(current);
}

export function onSettings(l: Listener): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}
