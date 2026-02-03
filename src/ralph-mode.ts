/**
 * Ralph-compatible mode.
 *
 * When prd.json exists, runs the classic ralph loop:
 *   for i in 1..N: spawn agent → check for COMPLETE → next
 *
 * Equivalent to ralph.sh but in TypeScript with multi-tool support.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, copyFileSync } from "fs";
import { join, dirname } from "path";
import { getAdapter } from "./agents/adapters";
import { spawnAgent } from "./agents/spawn";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface PrdJson {
  project: string;
  branchName?: string;
  description?: string;
  userStories: Array<{
    id: string;
    title: string;
    passes: boolean;
    priority: number;
    [key: string]: unknown;
  }>;
}

export interface RalphOptions {
  tool: string;
  maxIterations: number;
  prdPath: string;
  promptDir: string;
}

// ---------------------------------------------------------------------------
// Archive previous run (if branch changed)
// ---------------------------------------------------------------------------

function archivePreviousRun(prdPath: string): void {
  const dir = dirname(prdPath);
  const progressPath = join(dir, "progress.txt");
  const lastBranchPath = join(dir, ".last-branch");
  const archiveDir = join(dir, "archive");

  if (!existsSync(prdPath) || !existsSync(lastBranchPath)) return;

  try {
    const prd: PrdJson = JSON.parse(readFileSync(prdPath, "utf-8"));
    const lastBranch = readFileSync(lastBranchPath, "utf-8").trim();
    const currentBranch = prd.branchName ?? "";

    if (currentBranch && lastBranch && currentBranch !== lastBranch) {
      const date = new Date().toISOString().slice(0, 10);
      const folderName = lastBranch.replace(/^ralph\//, "");
      const archFolder = join(archiveDir, `${date}-${folderName}`);

      console.log(`Archiving previous run: ${lastBranch}`);
      mkdirSync(archFolder, { recursive: true });

      if (existsSync(prdPath)) copyFileSync(prdPath, join(archFolder, "prd.json"));
      if (existsSync(progressPath)) copyFileSync(progressPath, join(archFolder, "progress.txt"));

      console.log(`   Archived to: ${archFolder}`);

      // Reset progress
      writeFileSync(progressPath, `# Ralph Progress Log\nStarted: ${new Date().toISOString()}\n---\n`);
    }
  } catch {
    // Silently ignore archive errors
  }
}

// ---------------------------------------------------------------------------
// Build prompt
// ---------------------------------------------------------------------------

function buildPrompt(tool: string, promptDir: string): string {
  // Try tool-specific prompt first, then generic
  const toolPrompt = join(promptDir, `ralph-${tool}.md`);
  const genericPrompt = join(promptDir, "ralph-claude.md");

  if (existsSync(toolPrompt)) return readFileSync(toolPrompt, "utf-8");
  if (existsSync(genericPrompt)) return readFileSync(genericPrompt, "utf-8");

  throw new Error(`No ralph prompt found. Expected: ${toolPrompt} or ${genericPrompt}`);
}

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------

export async function runRalphMode(opts: RalphOptions): Promise<void> {
  const { tool, maxIterations, prdPath, promptDir } = opts;
  const adapter = getAdapter(tool);
  const dir = dirname(prdPath);

  // Archive if branch changed
  archivePreviousRun(prdPath);

  // Track current branch
  try {
    const prd: PrdJson = JSON.parse(readFileSync(prdPath, "utf-8"));
    if (prd.branchName) {
      writeFileSync(join(dir, ".last-branch"), prd.branchName);
    }
  } catch {
    // ignore
  }

  // Init progress file
  const progressPath = join(dir, "progress.txt");
  if (!existsSync(progressPath)) {
    writeFileSync(progressPath, `# Ralph Progress Log\nStarted: ${new Date().toISOString()}\n---\n`);
  }

  const prompt = buildPrompt(tool, promptDir);

  console.log(`Starting Ralph - Tool: ${tool} - Max iterations: ${maxIterations}`);

  for (let i = 1; i <= maxIterations; i++) {
    console.log("");
    console.log("===============================================================");
    console.log(`  Ralph Iteration ${i} of ${maxIterations} (${tool})`);
    console.log("===============================================================");

    const result = await spawnAgent({
      adapter,
      prompt,
      cwd: process.cwd(),
      onOutput: (line) => process.stdout.write(line + "\n"),
      onSignal: (signal) => {
        if (signal.type === "COMPLETE") {
          console.log("");
          console.log("Ralph completed all tasks!");
          console.log(`Completed at iteration ${i} of ${maxIterations}`);
        }
      },
    });

    // Check for completion (via signal or legacy <promise> tag)
    const hasComplete =
      result.signals.some((s) => s.type === "COMPLETE") ||
      result.stdout.includes("<promise>COMPLETE</promise>");

    if (hasComplete) {
      process.exit(0);
    }

    console.log(`Iteration ${i} complete. Continuing...`);
    await Bun.sleep(2000);
  }

  console.log("");
  console.log(`Ralph reached max iterations (${maxIterations}) without completing all tasks.`);
  console.log(`Check ${progressPath} for status.`);
  process.exit(1);
}
