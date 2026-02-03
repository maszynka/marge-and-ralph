import type { AgentAdapter } from "../spawn";
import { claude } from "./claude";
import { amp } from "./amp";
import { codex } from "./codex";
import { gemini } from "./gemini";

export const adapters: Record<string, AgentAdapter> = {
  claude,
  amp,
  codex,
  gemini,
};

export function getAdapter(name: string): AgentAdapter {
  const adapter = adapters[name];
  if (!adapter) {
    const available = Object.keys(adapters).join(", ");
    throw new Error(`Unknown tool "${name}". Available: ${available}`);
  }
  return adapter;
}
