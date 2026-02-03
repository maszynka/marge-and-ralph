/**
 * Generic agent spawner.
 *
 * Launches a CLI tool (claude, amp, codex, gemini) as a subprocess,
 * pipes a prompt via stdin, and streams stdout back.
 */

import { type Signal, SignalParser } from "./signals";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AgentAdapter {
  name: string;
  /** Build the command array to execute. */
  buildCommand(): string[];
  /** Whether the prompt is sent via stdin (true) or as an argument (false). */
  stdin: boolean;
}

export interface SpawnOptions {
  adapter: AgentAdapter;
  prompt: string;
  cwd?: string;
  env?: Record<string, string>;
  /** Called for each signal detected in stdout. */
  onSignal?: (signal: Signal) => void;
  /** Called for each raw line of output (before signal parsing). */
  onOutput?: (line: string) => void;
  /** Timeout in milliseconds. 0 = no timeout. Default: 0. */
  timeout?: number;
}

export interface AgentResult {
  exitCode: number;
  stdout: string;
  signals: Signal[];
}

// ---------------------------------------------------------------------------
// Spawn
// ---------------------------------------------------------------------------

export async function spawnAgent(opts: SpawnOptions): Promise<AgentResult> {
  const { adapter, prompt, cwd, env, onSignal, onOutput, timeout = 0 } = opts;
  const cmd = adapter.buildCommand();

  const proc = Bun.spawn(cmd, {
    cwd: cwd ?? process.cwd(),
    env: { ...process.env, ...env },
    stdin: adapter.stdin ? "pipe" : "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });

  // Pipe prompt to stdin
  if (adapter.stdin && proc.stdin) {
    proc.stdin.write(prompt);
    proc.stdin.end();
  }

  // Read stdout line-by-line, parse signals
  const parser = new SignalParser();
  const signals: Signal[] = [];
  const outputLines: string[] = [];

  const readStream = async (stream: ReadableStream<Uint8Array> | null, isStdout: boolean) => {
    if (!stream) return;
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        if (isStdout) {
          outputLines.push(line);
          onOutput?.(line);

          const signal = parser.feed(line);
          if (signal) {
            signals.push(signal);
            onSignal?.(signal);
          }
        } else {
          // stderr — pass through to parent stderr
          process.stderr.write(line + "\n");
        }
      }
    }

    // Handle remaining buffer
    if (buffer.length > 0 && isStdout) {
      outputLines.push(buffer);
      onOutput?.(buffer);
      const signal = parser.feed(buffer);
      if (signal) {
        signals.push(signal);
        onSignal?.(signal);
      }
    }
  };

  // Set up timeout
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  if (timeout > 0) {
    timeoutId = setTimeout(() => {
      proc.kill();
    }, timeout);
  }

  // Read stdout and stderr in parallel
  await Promise.all([
    readStream(proc.stdout, true),
    readStream(proc.stderr, false),
  ]);

  const exitCode = await proc.exited;

  if (timeoutId) clearTimeout(timeoutId);

  return {
    exitCode,
    stdout: outputLines.join("\n"),
    signals,
  };
}
