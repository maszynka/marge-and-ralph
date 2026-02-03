import type { AgentAdapter } from "../spawn";

export const codex: AgentAdapter = {
  name: "codex",
  buildCommand(): string[] {
    return ["codex", "--full-auto", "--quiet"];
  },
  stdin: true,
};
