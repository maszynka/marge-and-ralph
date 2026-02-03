#!/usr/bin/env bun
/**
 * marge_and_ralph CLI
 *
 * Auto-detects mode:
 *   - prd.json exists  → ralph-compatible loop
 *   - project.json exists → full orchestration
 *   - neither → show help
 *
 * Usage:
 *   ./marge.sh                          # auto-detect mode
 *   ./marge.sh --tool claude 20         # ralph mode, 20 iterations
 *   ./marge.sh plan [--phase N]         # full: plan a phase
 *   ./marge.sh execute [--phase N]      # full: execute a phase
 *   ./marge.sh verify [--phase N]       # full: verify a phase
 *   ./marge.sh status                   # show progress
 *   ./marge.sh init                     # interactive project setup
 */

import { existsSync } from "fs";
import { join, resolve } from "path";
import { runRalphMode } from "./ralph-mode";
import { runPlanningLoop } from "./planning/planner";
import { runOptimizer } from "./optimization/optimizer";
import { runExecutor } from "./execution/executor";
import { runVerifier } from "./verification/verifier";

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

interface CliArgs {
  command: string | null; // plan, execute, verify, status, init, debug, resume, optimize
  tool: string;
  model: string | null;
  phase: number | null;
  maxIterations: number;
  noResearch: boolean;
  noVerify: boolean;
  gapsOnly: boolean;
  dryRun: boolean;
  rest: string[]; // remaining positional args (e.g., debug description, target dir)
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    command: null,
    tool: "claude",
    model: null,
    phase: null,
    maxIterations: 10,
    noResearch: false,
    noVerify: false,
    gapsOnly: false,
    dryRun: false,
    rest: [],
  };

  const commands = new Set(["plan", "execute", "verify", "status", "init", "debug", "resume", "optimize"]);
  let i = 0;

  while (i < argv.length) {
    const arg = argv[i];

    if (arg === "--tool" && i + 1 < argv.length) {
      args.tool = argv[++i];
    } else if (arg.startsWith("--tool=")) {
      args.tool = arg.slice(7);
    } else if (arg === "--model" && i + 1 < argv.length) {
      args.model = argv[++i];
    } else if (arg.startsWith("--model=")) {
      args.model = arg.slice(8);
    } else if (arg === "--phase" && i + 1 < argv.length) {
      args.phase = parseInt(argv[++i], 10);
    } else if (arg.startsWith("--phase=")) {
      args.phase = parseInt(arg.slice(8), 10);
    } else if (arg === "--no-research") {
      args.noResearch = true;
    } else if (arg === "--no-verify") {
      args.noVerify = true;
    } else if (arg === "--gaps-only" || arg === "--gaps") {
      args.gapsOnly = true;
    } else if (arg === "--dry-run") {
      args.dryRun = true;
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else if (!arg.startsWith("--") && commands.has(arg) && !args.command) {
      args.command = arg;
    } else if (!arg.startsWith("--") && /^\d+$/.test(arg)) {
      // Bare number → max iterations (ralph compat)
      args.maxIterations = parseInt(arg, 10);
    } else {
      args.rest.push(arg);
    }

    i++;
  }

  return args;
}

// ---------------------------------------------------------------------------
// Help
// ---------------------------------------------------------------------------

function printHelp(): void {
  console.log(`
marge_and_ralph — AI Agent Orchestrator

USAGE:
  ./marge.sh                              Auto-detect mode (prd.json or project.json)
  ./marge.sh --tool claude 20            Ralph mode: 20 iterations with Claude
  ./marge.sh plan [--phase N]            Plan a phase
  ./marge.sh execute [--phase N]         Execute a phase (waves + verify)
  ./marge.sh verify [--phase N]          Verify phase goal
  ./marge.sh status                      Show progress
  ./marge.sh init                        Interactive project setup
  ./marge.sh debug "description"         Systematic debugging
  ./marge.sh resume                      Restore from last session
  ./marge.sh optimize [path]             Optimize existing codebase

OPTIMIZE COMMAND:
  ./marge.sh optimize                    Optimize current directory
  ./marge.sh optimize /path/to/code      Optimize target directory
  ./marge.sh optimize . --dry-run        Discovery only (no changes)
  ./marge.sh optimize . --tool gemini    Use different AI tool
  ./marge.sh optimize . 15               Override iteration count

OPTIONS:
  --tool <name>        Agent tool: claude, amp, codex, gemini (default: claude)
  --model <id>         Model override (e.g., claude-opus-4-20250514)
  --phase <N>          Target phase number
  --no-research        Skip research phase
  --no-verify          Skip verification
  --gaps-only          Execute only gap-closure plans
  --dry-run            Discovery only, don't execute changes (optimize)

MODES:
  Ralph mode:    prd.json detected → iterative user story loop
  Full mode:     project.json detected → plan → execute → verify orchestration
  Optimize:      Analyze and improve existing codebase
`);
}

// ---------------------------------------------------------------------------
// Mode detection
// ---------------------------------------------------------------------------

function detectMode(): "ralph" | "full" | "none" {
  if (existsSync(join(process.cwd(), "prd.json"))) return "ralph";
  if (existsSync(join(process.cwd(), "project.json"))) return "full";
  return "none";
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  // Skip first two args: bun and script path
  const rawArgs = process.argv.slice(2);
  const args = parseArgs(rawArgs);

  // If explicit command given, route to full mode
  if (args.command) {
    const scriptDir = import.meta.dir;

    switch (args.command) {
      case "plan": {
        await runPlanningLoop({
          tool: args.tool,
          maxIterations: args.maxIterations,
          projectPath: join(process.cwd(), "project.json"),
          promptDir: join(scriptDir, "prompts"),
        });
        return;
      }

      case "optimize": {
        const targetDir = args.rest[0] || process.cwd();
        await runOptimizer({
          tool: args.tool,
          targetDir: resolve(targetDir),
          promptDir: join(scriptDir, "prompts"),
          maxIterations: args.maxIterations !== 10 ? args.maxIterations : undefined,
          dryRun: args.dryRun,
        });
        return;
      }

      case "execute": {
        await runExecutor({
          tool: args.tool,
          phase: args.phase,
          projectPath: join(process.cwd(), "project.json"),
          promptDir: join(scriptDir, "prompts"),
          noVerify: args.noVerify,
        });
        return;
      }

      case "verify": {
        await runVerifier({
          tool: args.tool,
          phase: args.phase,
          projectPath: join(process.cwd(), "project.json"),
          promptDir: join(scriptDir, "prompts"),
        });
        return;
      }

      case "status":
      case "init":
      case "debug":
      case "resume":
        console.log(`[marge] Command '${args.command}' — full orchestration mode`);
        console.log("[marge] Not yet implemented. Coming in Phase 4-6.");
        console.log("[marge] Available now: ./marge.sh plan, ./marge.sh execute, ./marge.sh verify");
        process.exit(1);
    }
    return;
  }

  // Auto-detect mode
  const mode = detectMode();

  switch (mode) {
    case "ralph": {
      const scriptDir = import.meta.dir;
      await runRalphMode({
        tool: args.tool,
        maxIterations: args.maxIterations,
        prdPath: join(process.cwd(), "prd.json"),
        promptDir: join(scriptDir, "prompts"),
      });
      break;
    }

    case "full":
      console.log("[marge] Detected project.json — full orchestration mode");
      console.log("[marge] Full orchestration not yet implemented. Coming in Phase 3-6.");
      process.exit(1);
      break;

    case "none":
      console.log("[marge] No prd.json or project.json found in current directory.");
      console.log("");
      console.log("To get started:");
      console.log("  1. Ralph mode: Create prd.json (see prd.json.example)");
      console.log("  2. Full mode:  ./marge.sh init");
      console.log("");
      printHelp();
      process.exit(1);
  }
}

main().catch((err) => {
  console.error("[marge] Fatal error:", err.message);
  process.exit(1);
});
