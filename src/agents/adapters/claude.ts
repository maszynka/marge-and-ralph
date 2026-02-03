import type { AgentAdapter } from "../spawn";

export const claude: AgentAdapter = {
  name: "claude",
  buildCommand(): string[] {
    return ["claude", "--dangerously-skip-permissions", "--print"];
  },
  stdin: true,
};
