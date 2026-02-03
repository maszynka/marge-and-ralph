/**
 * Optimizer — main loop for code optimization.
 *
 * Flow:
 * 1. Git workflow (commit+branch / stash / worktree)
 * 2. Load project context (agent.md, CLAUDE.md)
 * 3. Discovery phase — analyze code, estimate iterations
 * 4. User approval — show opportunities, confirm iteration count
 * 5. Execution loop — implement optimizations one by one
 * 6. Summary
 */

import { existsSync, readFileSync } from "fs";
import { join, resolve } from "path";
import * as readline from "readline";
import { getAdapter } from "../agents/adapters";
import { spawnAgent } from "../agents/spawn";
import type { Signal } from "../agents/signals";
import { handleGitWorkflow } from "../git/workflow";
import { loadProjectContext, formatContextForPrompt } from "./context-loader";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface OptimizerOptions {
  tool: string;
  targetDir: string;
  promptDir: string;
  maxIterations?: number; // Override dynamic suggestion
  dryRun?: boolean; // Discovery only
}

interface Opportunity {
  id: string;
  category: string;
  title: string;
  files: string[];
  priority: "HIGH" | "MEDIUM" | "LOW";
  effort: string;
  completed: boolean;
}

interface DiscoveryResult {
  suggestedIterations: number;
  complexity: string;
  opportunities: Opportunity[];
  rawPlan: string;
}

// ---------------------------------------------------------------------------
// Prompt builders
// ---------------------------------------------------------------------------

function loadPrompt(promptDir: string, name: string): string {
  const path = join(promptDir, name);
  if (!existsSync(path)) {
    throw new Error(`Prompt not found: ${path}`);
  }
  return readFileSync(path, "utf-8");
}

function buildDiscoveryPrompt(
  promptDir: string,
  targetDir: string,
  projectContext: string
): string {
  let prompt = loadPrompt(promptDir, "optimizer-discovery.md");
  prompt = prompt.replace("{PROJECT_CONTEXT}", projectContext);
  prompt = prompt.replace("{TARGET_DIR}", targetDir);
  return prompt;
}

function buildExecutePrompt(
  promptDir: string,
  targetDir: string,
  projectContext: string,
  opportunities: Opportunity[],
  completed: string[]
): string {
  let prompt = loadPrompt(promptDir, "optimizer-execute.md");
  prompt = prompt.replace("{PROJECT_CONTEXT}", projectContext);
  prompt = prompt.replace("{TARGET_DIR}", targetDir);

  // Format remaining opportunities
  const remaining = opportunities
    .filter((o) => !o.completed)
    .map((o) => `- [${o.priority}] ${o.id}: ${o.title} (${o.category})`)
    .join("\n");
  prompt = prompt.replace("{OPPORTUNITIES}", remaining || "None remaining");

  // Format completed
  const completedStr = completed.length > 0 ? completed.join("\n") : "None yet";
  prompt = prompt.replace("{COMPLETED}", completedStr);

  return prompt;
}

// ---------------------------------------------------------------------------
// Output parsing
// ---------------------------------------------------------------------------

function parseIterationEstimate(stdout: string): { suggested: number; complexity: string } | null {
  const match = stdout.match(
    /<!-- SIGNAL:ITERATION_ESTIMATE suggested="(\d+)" complexity="(\w+)"[^>]*-->/
  );
  if (match) {
    return {
      suggested: parseInt(match[1], 10),
      complexity: match[2],
    };
  }
  return null;
}

function parseOpportunities(stdout: string): Opportunity[] {
  const opportunities: Opportunity[] = [];

  // Find PLAN_PROPOSAL signal content
  const signalMatch = stdout.match(
    /<!-- SIGNAL:PLAN_PROPOSAL[^>]*-->([\s\S]*?)<!-- \/SIGNAL -->/
  );
  if (!signalMatch) return opportunities;

  const content = signalMatch[1];

  // Parse opportunities - look for numbered items with category
  const itemRegex = /(\d+)\.\s+\*\*\[([^\]]+)\]\*\*\s+([^\n]+)/g;
  let match;
  let currentPriority: "HIGH" | "MEDIUM" | "LOW" = "MEDIUM";

  // Detect priority sections
  const lines = content.split("\n");
  for (const line of lines) {
    if (line.includes("HIGH Priority")) currentPriority = "HIGH";
    else if (line.includes("MEDIUM Priority")) currentPriority = "MEDIUM";
    else if (line.includes("LOW Priority")) currentPriority = "LOW";

    const itemMatch = line.match(/^(\d+)\.\s+\*\*\[([^\]]+)\]\*\*\s+(.+)/);
    if (itemMatch) {
      opportunities.push({
        id: `OPT-${itemMatch[1].padStart(2, "0")}`,
        category: itemMatch[2],
        title: itemMatch[3].trim(),
        files: [],
        priority: currentPriority,
        effort: "medium",
        completed: false,
      });
    }
  }

  return opportunities;
}

function parseTaskComplete(stdout: string): { task: string; commit?: string } | null {
  const match = stdout.match(
    /<!-- SIGNAL:TASK_COMPLETE task="([^"]+)"(?:\s+commit="([^"]+)")?/
  );
  if (match) {
    return { task: match[1], commit: match[2] };
  }
  return null;
}

function parseOptimizationComplete(stdout: string): { improvements: number; summary?: string } | null {
  const match = stdout.match(
    /<!-- SIGNAL:OPTIMIZATION_COMPLETE improvements="(\d+)"(?:\s+summary="([^"]+)")?/
  );
  if (match) {
    return { improvements: parseInt(match[1], 10), summary: match[2] };
  }
  return null;
}

// ---------------------------------------------------------------------------
// User interaction
// ---------------------------------------------------------------------------

function createReadline(): readline.Interface {
  return readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
}

async function prompt(rl: readline.Interface, question: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      resolve(answer.trim());
    });
  });
}

// ---------------------------------------------------------------------------
// Main optimizer loop
// ---------------------------------------------------------------------------

export async function runOptimizer(opts: OptimizerOptions): Promise<void> {
  const { tool, promptDir, dryRun } = opts;
  const targetDir = resolve(opts.targetDir);
  const adapter = getAdapter(tool);
  const rl = createReadline();

  console.log("");
  console.log("═══════════════════════════════════════════════════════════════");
  console.log("  Optimizer — Analyze & Improve Codebase");
  console.log("═══════════════════════════════════════════════════════════════");
  console.log("");
  console.log(`Target: ${targetDir}`);
  console.log(`Tool: ${tool}`);
  console.log("");

  // ---------------------------------------------------------------------------
  // Step 1: Git workflow
  // ---------------------------------------------------------------------------
  const gitResult = await handleGitWorkflow(targetDir, rl);
  const workingDir = gitResult.workingDir;

  if (gitResult.branchName) {
    console.log(`[git] Working on branch: ${gitResult.branchName}`);
  }
  console.log("");

  // ---------------------------------------------------------------------------
  // Step 2: Load project context
  // ---------------------------------------------------------------------------
  console.log("[context] Loading project context...");
  const context = await loadProjectContext(workingDir);
  const contextStr = formatContextForPrompt(context);
  console.log("");

  // ---------------------------------------------------------------------------
  // Step 3: Discovery phase
  // ---------------------------------------------------------------------------
  console.log("═══════════════════════════════════════════════════════════════");
  console.log(`  Discovery Phase — Analyzing with ${tool}`);
  console.log("═══════════════════════════════════════════════════════════════");
  console.log("");

  const discoveryPrompt = buildDiscoveryPrompt(promptDir, workingDir, contextStr);

  const discoveryResult = await spawnAgent({
    adapter,
    prompt: discoveryPrompt,
    cwd: workingDir,
    onOutput: (line) => {
      // Don't print signal tags
      if (!line.includes("<!-- SIGNAL:") && !line.includes("<!-- /SIGNAL")) {
        console.log(line);
      }
    },
  });

  // Parse discovery results
  const estimate = parseIterationEstimate(discoveryResult.stdout);
  const opportunities = parseOpportunities(discoveryResult.stdout);

  if (!estimate || opportunities.length === 0) {
    console.log("");
    console.log("[optimizer] Could not parse discovery results.");
    console.log("[optimizer] The agent may not have found any optimization opportunities.");
    rl.close();
    return;
  }

  // ---------------------------------------------------------------------------
  // Step 4: Show summary and get approval
  // ---------------------------------------------------------------------------
  console.log("");
  console.log("═══════════════════════════════════════════════════════════════");
  console.log("  Optimization Opportunities");
  console.log("═══════════════════════════════════════════════════════════════");
  console.log("");

  const byPriority = {
    HIGH: opportunities.filter((o) => o.priority === "HIGH"),
    MEDIUM: opportunities.filter((o) => o.priority === "MEDIUM"),
    LOW: opportunities.filter((o) => o.priority === "LOW"),
  };

  if (byPriority.HIGH.length > 0) {
    console.log("  HIGH PRIORITY:");
    byPriority.HIGH.forEach((o) => console.log(`    ${o.id}: [${o.category}] ${o.title}`));
  }
  if (byPriority.MEDIUM.length > 0) {
    console.log("  MEDIUM PRIORITY:");
    byPriority.MEDIUM.forEach((o) => console.log(`    ${o.id}: [${o.category}] ${o.title}`));
  }
  if (byPriority.LOW.length > 0) {
    console.log("  LOW PRIORITY:");
    byPriority.LOW.forEach((o) => console.log(`    ${o.id}: [${o.category}] ${o.title}`));
  }

  console.log("");
  console.log(`  Total: ${opportunities.length} opportunities`);
  console.log(`  Suggested iterations: ${estimate.suggested} (${estimate.complexity} complexity)`);
  console.log("");

  if (dryRun) {
    console.log("[optimizer] Dry run — skipping execution.");
    rl.close();
    return;
  }

  const response = await prompt(rl, "(a)ccept / (c)hange count / (q)uit: ");

  if (response.toLowerCase() === "q" || response.toLowerCase() === "quit") {
    console.log("[optimizer] Cancelled.");
    rl.close();
    return;
  }

  let iterations = estimate.suggested;
  if (response.toLowerCase() === "c" || response.toLowerCase() === "change") {
    const countStr = await prompt(rl, `How many iterations? [${estimate.suggested}]: `);
    const parsed = parseInt(countStr, 10);
    if (!isNaN(parsed) && parsed > 0) {
      iterations = parsed;
    }
  }

  // Override if provided in options
  if (opts.maxIterations && opts.maxIterations !== 10) {
    iterations = opts.maxIterations;
  }

  // ---------------------------------------------------------------------------
  // Step 5: Execution loop
  // ---------------------------------------------------------------------------
  const completed: string[] = [];
  let totalImprovements = 0;

  for (let i = 1; i <= iterations; i++) {
    // Check if all done
    const remaining = opportunities.filter((o) => !o.completed);
    if (remaining.length === 0) {
      console.log("");
      console.log("[optimizer] All opportunities completed!");
      break;
    }

    console.log("");
    console.log("═══════════════════════════════════════════════════════════════");
    console.log(`  Iteration ${i}/${iterations}`);
    console.log("═══════════════════════════════════════════════════════════════");
    console.log("");

    const executePrompt = buildExecutePrompt(
      promptDir,
      workingDir,
      contextStr,
      opportunities,
      completed
    );

    const execResult = await spawnAgent({
      adapter,
      prompt: executePrompt,
      cwd: workingDir,
      onOutput: (line) => {
        if (!line.includes("<!-- SIGNAL:") && !line.includes("<!-- /SIGNAL")) {
          console.log(line);
        }
      },
    });

    // Check for task completion
    const taskComplete = parseTaskComplete(execResult.stdout);
    if (taskComplete) {
      console.log("");
      console.log(`✓ Completed: ${taskComplete.task}`);
      if (taskComplete.commit) {
        console.log(`  Commit: ${taskComplete.commit}`);
      }
      completed.push(`${taskComplete.task}: ${taskComplete.commit || "done"}`);
      totalImprovements++;

      // Mark opportunity as completed
      const opp = opportunities.find((o) => o.id === taskComplete.task);
      if (opp) opp.completed = true;
    }

    // Check for optimization complete signal
    const optComplete = parseOptimizationComplete(execResult.stdout);
    if (optComplete) {
      console.log("");
      console.log(`✓ All optimizations complete! (${optComplete.improvements} improvements)`);
      if (optComplete.summary) {
        console.log(`  Summary: ${optComplete.summary}`);
      }
      totalImprovements = optComplete.improvements;
      break;
    }

    // Check for blocked
    if (execResult.stdout.includes("<!-- SIGNAL:BLOCKED")) {
      console.log("");
      console.log("[optimizer] Agent is blocked. Stopping.");
      break;
    }

    // Small delay between iterations
    await Bun.sleep(1000);
  }

  // ---------------------------------------------------------------------------
  // Step 6: Summary
  // ---------------------------------------------------------------------------
  console.log("");
  console.log("═══════════════════════════════════════════════════════════════");
  console.log("  Optimization Complete");
  console.log("═══════════════════════════════════════════════════════════════");
  console.log("");
  console.log(`  Improvements made: ${totalImprovements}`);
  console.log(`  Working directory: ${workingDir}`);
  if (gitResult.branchName) {
    console.log(`  Branch: ${gitResult.branchName}`);
  }
  console.log("");
  console.log("Next steps:");
  console.log("  git log --oneline -10     # Review commits");
  console.log("  git diff main             # Review all changes");
  if (gitResult.branchName) {
    console.log(`  git push -u origin ${gitResult.branchName}`);
  }
  console.log("");

  rl.close();
}
