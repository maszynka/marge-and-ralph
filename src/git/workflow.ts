/**
 * Git workflow management — plain shell commands (NOT via AI agent).
 *
 * Provides functions to:
 * - Check git status of a directory
 * - Prompt user for workflow choice (branch, stash, worktree)
 * - Execute the chosen workflow via Bun.spawn
 */

import * as readline from "readline";
import { resolve, basename, dirname, join } from "path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface GitStatus {
  isGitRepo: boolean;
  hasUncommittedChanges: boolean;
  hasUntrackedFiles: boolean;
  currentBranch: string;
}

export type WorkflowChoice = "branch" | "stash" | "worktree" | "skip";

export interface WorkflowResult {
  choice: WorkflowChoice;
  workingDir: string; // may differ from original if worktree
  branchName?: string;
}

// ---------------------------------------------------------------------------
// Shell helpers
// ---------------------------------------------------------------------------

async function run(
  cmd: string[],
  cwd: string
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = Bun.spawn(cmd, {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });

  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;

  return { stdout: stdout.trim(), stderr: stderr.trim(), exitCode };
}

// ---------------------------------------------------------------------------
// Git status check
// ---------------------------------------------------------------------------

export async function checkGitStatus(cwd: string): Promise<GitStatus> {
  // Check if git repo
  const gitCheck = await run(["git", "rev-parse", "--git-dir"], cwd);
  if (gitCheck.exitCode !== 0) {
    return {
      isGitRepo: false,
      hasUncommittedChanges: false,
      hasUntrackedFiles: false,
      currentBranch: "",
    };
  }

  // Get current branch
  const branchResult = await run(["git", "branch", "--show-current"], cwd);
  const currentBranch = branchResult.stdout || "HEAD";

  // Check for changes (staged + unstaged)
  const statusResult = await run(["git", "status", "--porcelain"], cwd);
  const statusLines = statusResult.stdout.split("\n").filter(Boolean);

  const hasUncommittedChanges = statusLines.some(
    (line) => line.startsWith("M") || line.startsWith("A") || line.startsWith("D") || line.startsWith("R") || line.startsWith(" M") || line.startsWith(" D")
  );
  const hasUntrackedFiles = statusLines.some((line) => line.startsWith("??"));

  return {
    isGitRepo: true,
    hasUncommittedChanges: hasUncommittedChanges || hasUntrackedFiles,
    hasUntrackedFiles,
    currentBranch,
  };
}

// ---------------------------------------------------------------------------
// User prompt for workflow choice
// ---------------------------------------------------------------------------

export async function promptWorkflowChoice(
  rl: readline.Interface
): Promise<WorkflowChoice> {
  return new Promise((resolve) => {
    console.log("");
    console.log("How do you want to handle uncommitted changes?");
    console.log("  1. Commit current changes + create new branch");
    console.log("  2. Stash changes");
    console.log("  3. Create worktree (original unchanged)");
    console.log("  4. Skip (continue with changes)");
    console.log("");

    rl.question("Choice [1]: ", (answer) => {
      const choice = answer.trim() || "1";
      switch (choice) {
        case "1":
          resolve("branch");
          break;
        case "2":
          resolve("stash");
          break;
        case "3":
          resolve("worktree");
          break;
        case "4":
          resolve("skip");
          break;
        default:
          resolve("branch");
      }
    });
  });
}

// ---------------------------------------------------------------------------
// Execute workflow
// ---------------------------------------------------------------------------

function generateBranchName(): string {
  const now = new Date();
  const timestamp = now.toISOString().slice(0, 16).replace("T", "-").replace(":", "");
  return `optimize/${timestamp}`;
}

export async function executeWorkflow(
  cwd: string,
  choice: WorkflowChoice,
  rl?: readline.Interface
): Promise<WorkflowResult> {
  const branchName = generateBranchName();

  switch (choice) {
    case "branch": {
      // Stage all changes
      console.log("[git] Staging all changes...");
      await run(["git", "add", "-A"], cwd);

      // Commit
      console.log("[git] Committing...");
      const commitResult = await run(
        ["git", "commit", "-m", "checkpoint: pre-optimize"],
        cwd
      );
      if (commitResult.exitCode !== 0 && !commitResult.stderr.includes("nothing to commit")) {
        console.error("[git] Commit failed:", commitResult.stderr);
      }

      // Create and checkout new branch
      console.log(`[git] Creating branch: ${branchName}`);
      const branchResult = await run(["git", "checkout", "-b", branchName], cwd);
      if (branchResult.exitCode !== 0) {
        console.error("[git] Branch creation failed:", branchResult.stderr);
        throw new Error(`Failed to create branch: ${branchResult.stderr}`);
      }

      return { choice, workingDir: cwd, branchName };
    }

    case "stash": {
      console.log("[git] Stashing changes...");
      const stashResult = await run(
        ["git", "stash", "push", "-m", "pre-optimize stash"],
        cwd
      );
      if (stashResult.exitCode !== 0) {
        console.error("[git] Stash failed:", stashResult.stderr);
      }

      // Create new branch from clean state
      console.log(`[git] Creating branch: ${branchName}`);
      await run(["git", "checkout", "-b", branchName], cwd);

      return { choice, workingDir: cwd, branchName };
    }

    case "worktree": {
      const parentDir = dirname(cwd);
      const projectName = basename(cwd);
      const worktreeName = `${projectName}-optimize-${Date.now()}`;
      const worktreePath = join(parentDir, worktreeName);

      console.log(`[git] Creating worktree: ${worktreePath}`);
      const worktreeResult = await run(
        ["git", "worktree", "add", worktreePath, "-b", branchName],
        cwd
      );
      if (worktreeResult.exitCode !== 0) {
        console.error("[git] Worktree creation failed:", worktreeResult.stderr);
        throw new Error(`Failed to create worktree: ${worktreeResult.stderr}`);
      }

      console.log(`[git] Working in worktree: ${worktreePath}`);
      return { choice, workingDir: worktreePath, branchName };
    }

    case "skip":
      console.log("[git] Skipping git workflow, continuing with current state.");
      return { choice, workingDir: cwd };

    default:
      return { choice: "skip", workingDir: cwd };
  }
}

// ---------------------------------------------------------------------------
// Combined helper
// ---------------------------------------------------------------------------

export async function handleGitWorkflow(
  targetDir: string,
  rl: readline.Interface
): Promise<WorkflowResult> {
  const absPath = resolve(targetDir);
  const status = await checkGitStatus(absPath);

  if (!status.isGitRepo) {
    console.log("[git] Not a git repository, skipping git workflow.");
    return { choice: "skip", workingDir: absPath };
  }

  console.log(`[git] Branch: ${status.currentBranch}`);

  if (!status.hasUncommittedChanges) {
    console.log("[git] No uncommitted changes.");
    // Still create a new branch for optimization
    const branchName = generateBranchName();
    console.log(`[git] Creating branch: ${branchName}`);
    await run(["git", "checkout", "-b", branchName], absPath);
    return { choice: "branch", workingDir: absPath, branchName };
  }

  console.log("[git] Found uncommitted changes.");
  const choice = await promptWorkflowChoice(rl);
  return executeWorkflow(absPath, choice, rl);
}
