import type { AgentAdapter } from "../spawn";

export const gemini: AgentAdapter = {
  name: "gemini",
  buildCommand(): string[] {
    return ["gemini"];
  },
  stdin: true,
};
