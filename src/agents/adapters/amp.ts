import type { AgentAdapter } from "../spawn";

export const amp: AgentAdapter = {
  name: "amp",
  buildCommand(): string[] {
    return ["amp", "--dangerously-allow-all"];
  },
  stdin: true,
};
