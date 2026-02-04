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
import { showStatus } from "./state/status";
import { runCodeReview } from "./code-review/reviewer";
import { runFigmaMode } from "./figma/figma-mode.js";

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

interface CliArgs {
  command: string | null; // plan, execute, verify, status, init, debug, resume, optimize, cr, figma
  tool: string;
  model: string | null;
  phase: number | null;
  maxIterations: number;
  noResearch: boolean;
  noVerify: boolean;
  gapsOnly: boolean;
  dryRun: boolean;
  rest: string[]; // remaining positional args (e.g., debug description, target dir)
  // Code review specific flags
  branch: string | null;
  pr: string | null;
  dod: string | null;
  criteria: string[];
  sandbox: boolean;
  keepWorktree: boolean;
  output: string | null;
  // Figma specific flags
  selector: string | null;
  path: string | null;
  pixelThreshold: number | null;
  config: string | null; // --config <file> for figma.json
  yes: boolean; // -y to skip prompts
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
    // Code review specific
    branch: null,
    pr: null,
    dod: null,
    criteria: [],
    sandbox: false,
    keepWorktree: false,
    output: null,
    // Figma specific
    selector: null,
    path: null,
    pixelThreshold: null,
    config: null,
    yes: false,
  };

  const commands = new Set(["plan", "execute", "verify", "status", "init", "debug", "resume", "optimize", "cr", "figma"]);
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
    } else if ((arg === "--branch" || arg === "-b") && i + 1 < argv.length) {
      args.branch = argv[++i];
    } else if (arg.startsWith("--branch=")) {
      args.branch = arg.slice(9);
    } else if (arg.startsWith("-b=")) {
      args.branch = arg.slice(3);
    } else if ((arg === "--pr" || arg === "-p") && i + 1 < argv.length) {
      args.pr = argv[++i];
    } else if (arg.startsWith("--pr=")) {
      args.pr = arg.slice(5);
    } else if (arg.startsWith("-p=")) {
      args.pr = arg.slice(3);
    } else if (arg === "--dod" && i + 1 < argv.length) {
      args.dod = argv[++i];
    } else if (arg.startsWith("--dod=")) {
      args.dod = arg.slice(6);
    } else if (arg === "--criteria" && i + 1 < argv.length) {
      args.criteria.push(argv[++i]);
    } else if (arg.startsWith("--criteria=")) {
      args.criteria.push(arg.slice(11));
    } else if (arg === "--sandbox") {
      args.sandbox = true;
    } else if (arg === "--keep-worktree") {
      args.keepWorktree = true;
    } else if (arg === "--output" && i + 1 < argv.length) {
      args.output = argv[++i];
    } else if (arg.startsWith("--output=")) {
      args.output = arg.slice(9);
    } else if (arg === "--selector" && i + 1 < argv.length) {
      args.selector = argv[++i];
    } else if (arg.startsWith("--selector=")) {
      args.selector = arg.slice(11);
    } else if (arg === "--path" && i + 1 < argv.length) {
      args.path = argv[++i];
    } else if (arg.startsWith("--path=")) {
      args.path = arg.slice(7);
    } else if (arg === "--pixel-threshold" && i + 1 < argv.length) {
      args.pixelThreshold = parseFloat(argv[++i]);
    } else if (arg.startsWith("--pixel-threshold=")) {
      args.pixelThreshold = parseFloat(arg.slice(18));
    } else if (arg === "--config" && i + 1 < argv.length) {
      args.config = argv[++i];
    } else if (arg.startsWith("--config=")) {
      args.config = arg.slice(9);
    } else if (arg === "-y" || arg === "--yes") {
      args.yes = true;
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
  ./marge.sh cr <pr-url|branch>          Run code review on PR or branch
  ./marge.sh figma <figma-url>           Convert Figma design to code

CODE REVIEW COMMAND:
  ./marge.sh cr <pr-url>                 Review a PR by URL (GitHub or GitLab)
  ./marge.sh cr <branch>                 Review a branch (auto-detect PR)
  ./marge.sh cr --pr <url>               Explicit PR URL flag
  ./marge.sh cr --branch <name>          Explicit branch name flag
  ./marge.sh cr <input> --dod <path>     Custom Definition of Done file
  ./marge.sh cr <input> --criteria <c>   Add review criteria (repeatable)
  ./marge.sh cr <input> --sandbox        Run in Docker sandbox
  ./marge.sh cr <input> --keep-worktree  Keep git worktree after review
  ./marge.sh cr <input> --output <dir>   Custom output directory

OPTIMIZE COMMAND:
  ./marge.sh optimize                    Optimize current directory
  ./marge.sh optimize /path/to/code      Optimize target directory
  ./marge.sh optimize . --dry-run        Discovery only (no changes)
  ./marge.sh optimize . --tool gemini    Use different AI tool
  ./marge.sh optimize . 15               Override iteration count

FIGMA COMMAND:
  ./marge.sh figma <figma-url>           Convert Figma design to code
  ./marge.sh figma                       Use figma.json config (with prompt)
  ./marge.sh figma -y                    Use figma.json config (no prompt)
  ./marge.sh figma --config <file>       Use custom config file
  ./marge.sh figma <url> --selector <s>  CSS selector for visual comparison
  ./marge.sh figma <url> --pixel-threshold <n>  Pixel diff threshold (0-1, default: 0.02)

OPTIONS:
  --tool <name>           Agent tool: claude, amp, codex, gemini (default: claude)
  --model <id>            Model override (e.g., claude-opus-4-20250514)
  --phase <N>             Target phase number
  --no-research           Skip research phase
  --no-verify             Skip verification
  --gaps-only             Execute only gap-closure plans
  --dry-run               Discovery only, don't execute changes (optimize)
  -b, --branch <name>     Branch name for code review
  -p, --pr <url>          PR URL for code review
  --dod <path>            Custom DoD file for code review
  --criteria <text>       Review criteria (can be used multiple times)
  --sandbox               Run code review in Docker sandbox
  --keep-worktree         Keep git worktree after code review
  --output <dir>          Custom output directory for review artifacts
  --selector <selector>   CSS selector for Figma visual comparison
  --path <url>            Figma file URL or file key
  --pixel-threshold <n>   Pixel diff threshold for Figma (0-1, default: 0.02)

MODES:
  Ralph mode:    prd.json detected → iterative user story loop
  Full mode:     project.json detected → plan → execute → verify orchestration
  Optimize:      Analyze and improve existing codebase
  Code Review:   Review PRs or branches with AI agent
  Figma:         Convert Figma designs to pixel-perfect code
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

      case "status": {
        const projectPath = join(process.cwd(), "project.json");
        showStatus(projectPath);
        return;
      }

      case "cr": {
        // Determine input: --pr flag or --branch flag or first positional arg
        let input: string | undefined;
        if (args.pr) {
          input = args.pr;
        } else if (args.branch) {
          input = args.branch;
        } else if (args.rest.length > 0) {
          input = args.rest[0];
        }

        if (!input) {
          console.error("[marge] Error: 'cr' command requires a PR URL or branch name");
          console.error("Usage: ./marge.sh cr <pr-url|branch> [options]");
          console.error("  or: ./marge.sh cr --pr <url> [options]");
          console.error("  or: ./marge.sh cr --branch <name> [options]");
          process.exit(1);
        }

        await runCodeReview({
          input,
          dodFile: args.dod || undefined,
          criteria: args.criteria.length > 0 ? args.criteria.join("\n") : undefined,
          sandbox: args.sandbox ? "docker" : "none",
          keepWorktree: args.keepWorktree,
          outputDir: args.output || undefined,
          tool: args.tool,
          maxIterations: args.maxIterations,
        });
        return;
      }

      case "figma": {
        // Check for figma.json config file
        const configPath = args.config || join(process.cwd(), "figma.json");
        let configFromFile: {
          figmaUrl?: string;
          selector?: string;
          path?: string;
          tool?: string;
          pixelThreshold?: number;
        } = {};

        if (existsSync(configPath)) {
          try {
            const configContent = await Bun.file(configPath).text();
            configFromFile = JSON.parse(configContent);

            // If no -y flag and no CLI args provided, ask user
            if (!args.yes && !args.path && args.rest.length === 0) {
              console.log(`[marge] Found ${configPath}:`);
              console.log(`  figmaUrl: ${configFromFile.figmaUrl || "(not set)"}`);
              console.log(`  selector: ${configFromFile.selector || "(not set)"}`);
              console.log(`  path: ${configFromFile.path || "(not set)"}`);
              console.log(`  tool: ${configFromFile.tool || "claude"}`);
              console.log(`  pixelThreshold: ${configFromFile.pixelThreshold || 0.02}`);
              console.log("");

              // Simple prompt using readline
              const readline = await import("readline");
              const rl = readline.createInterface({
                input: process.stdin,
                output: process.stdout,
              });

              const answer = await new Promise<string>((resolve) => {
                rl.question("Use this config? [Y/n]: ", (ans) => {
                  rl.close();
                  resolve(ans.trim().toLowerCase());
                });
              });

              if (answer === "n" || answer === "no") {
                console.log("[marge] Aborted. Pass parameters via CLI or edit figma.json");
                process.exit(0);
              }
            } else if (!args.yes && (args.path || args.rest.length > 0)) {
              // CLI args provided, they take priority (no prompt needed)
              console.log(`[marge] Using CLI args (figma.json found but CLI takes priority)`);
            } else if (args.yes) {
              console.log(`[marge] Using ${configPath} (-y flag)`);
            }
          } catch (e) {
            console.error(`[marge] Error reading ${configPath}:`, e);
            process.exit(1);
          }
        }

        // Merge: CLI args take priority over config file
        const figmaUrl = args.path || (args.rest.length > 0 ? args.rest[0] : undefined) || configFromFile.figmaUrl;
        const selector = args.selector || configFromFile.selector;
        const codePath = configFromFile.path; // only from config, --path is for figmaUrl
        const tool = args.tool !== "claude" ? args.tool : (configFromFile.tool || "claude");
        const pixelThreshold = args.pixelThreshold || configFromFile.pixelThreshold;

        if (!figmaUrl) {
          console.error("[marge] Error: 'figma' command requires a Figma file URL");
          console.error("");
          console.error("Usage:");
          console.error("  ./marge.sh figma <figma-url> [options]");
          console.error("  ./marge.sh figma              # uses figma.json if exists");
          console.error("  ./marge.sh figma -y           # uses figma.json without prompt");
          console.error("");
          console.error("Options:");
          console.error("  --selector <css>        CSS selector for visual comparison");
          console.error("  --pixel-threshold <n>   Pixel diff threshold (0-1, default: 0.02)");
          console.error("  --config <file>         Custom config file (default: figma.json)");
          console.error("  -y, --yes               Skip confirmation prompt");
          console.error("");
          console.error("Or create figma.json:");
          console.error(`  {
    "figmaUrl": "https://figma.com/file/xxx?node-id=1:234",
    "selector": ".my-component",
    "path": "./src/components",
    "tool": "claude",
    "pixelThreshold": 0.02
  }`);
          process.exit(1);
        }

        await runFigmaMode({
          figmaUrl,
          selector: selector || undefined,
          path: codePath || undefined,
          pixelThreshold: pixelThreshold || undefined,
          tool,
        });
        return;
      }

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

    case "full": {
      const projectPath = join(process.cwd(), "project.json");
      showStatus(projectPath);
      break;
    }

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
