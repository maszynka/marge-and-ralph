/**
 * Agent monitor — wraps spawnAgent with higher-level event handling.
 *
 * Provides a convenient interface for the orchestrator to react to
 * agent signals (task completions, checkpoints, blocks, etc.).
 */

import { type Signal, type SignalType } from "./signals";
import { type AgentAdapter, type AgentResult, spawnAgent } from "./spawn";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SignalHandler = (signal: Signal) => void | Promise<void>;

export interface MonitorOptions {
  adapter: AgentAdapter;
  prompt: string;
  cwd?: string;
  env?: Record<string, string>;
  timeout?: number;
  /** Print agent output to parent stdout in real-time. Default: true. */
  passthrough?: boolean;
  /** Signal handlers by type. */
  handlers?: Partial<Record<SignalType, SignalHandler>>;
  /** Catch-all handler for any signal. */
  onAnySignal?: SignalHandler;
}

// ---------------------------------------------------------------------------
// Monitor
// ---------------------------------------------------------------------------

export async function monitorAgent(opts: MonitorOptions): Promise<AgentResult> {
  const {
    adapter,
    prompt,
    cwd,
    env,
    timeout,
    passthrough = true,
    handlers = {},
    onAnySignal,
  } = opts;

  return spawnAgent({
    adapter,
    prompt,
    cwd,
    env,
    timeout,
    onOutput: passthrough
      ? (line) => process.stdout.write(line + "\n")
      : undefined,
    onSignal: async (signal) => {
      onAnySignal?.(signal);
      const handler = handlers[signal.type];
      if (handler) await handler(signal);
    },
  });
}
