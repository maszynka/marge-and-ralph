/**
 * Execution orchestrator.
 *
 * Loads project.json, finds the target phase, and executes tasks sequentially.
 * Monitors signals (TASK_COMPLETE, CHECKPOINT, BLOCKED) and updates phase status.
 */

import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { getAdapter } from "../agents/adapters";
import { spawnAgent } from "../agents/spawn";
import type { Signal } from "../agents/signals";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ExecuteOptions {
  tool: string;
  phase?: number | null;
  projectPath: string;
  promptDir: string;
  noVerify?: boolean;
}

interface Phase {
  id: string;
  name: string;
  goal: string;
  tasks: string[];
  status: "pending" | "planned" | "executing" | "complete";
}

interface ProjectJson {
  project: string;
  description: string;
  discoveryAnswers?: string;
  phases: Phase[];
  config: {
    tool: string;
    workflow: {
      research: boolean;
      plan_check: boolean;
      verifier: boolean;
    };
  };
}

// ---------------------------------------------------------------------------
// Project management
// ---------------------------------------------------------------------------

function loadProject(projectPath: string): ProjectJson {
  if (!existsSync(projectPath)) {
    throw new Error(`Project file not found: ${projectPath}`);
  }

  return JSON.parse(readFileSync(projectPath, "utf-8"));
}

function saveProject(projectPath: string, project: ProjectJson): void {
  writeFileSync(projectPath, JSON.stringify(project, null, 2));
}

function findTargetPhase(project: ProjectJson, phaseNum?: number | null): Phase | null {
  if (phaseNum !== null && phaseNum !== undefined) {
    // Find specific phase by number
    const phaseId = phaseNum.toString().padStart(2, "0");
    return project.phases.find((p) => p.id === phaseId) ?? null;
  }

  // Find first pending or executing phase
  return project.phases.find((p) => p.status === "pending" || p.status === "executing") ?? null;
}

// ---------------------------------------------------------------------------
// Prompt building
// ---------------------------------------------------------------------------

function loadExecutorPrompt(promptDir: string): string {
  const path = join(promptDir, "executor.md");
  if (!existsSync(path)) {
    throw new Error(`Executor prompt not found: ${path}`);
  }
  return readFileSync(path, "utf-8");
}

function buildTaskPrompt(
  basePrompt: string,
  project: ProjectJson,
  phase: Phase,
  task: string,
  taskIndex: number
): string {
  return basePrompt
    .replace("{PROJECT_CONTEXT}", project.description)
    .replace("{PHASE_GOAL}", phase.goal)
    .replace("{TASK_DESCRIPTION}", task)
    .replace("{TASK_INDEX}", (taskIndex + 1).toString())
    .replace("{TOTAL_TASKS}", phase.tasks.length.toString());
}

// ---------------------------------------------------------------------------
// Main executor
// ---------------------------------------------------------------------------

export async function runExecutor(opts: ExecuteOptions): Promise<void> {
  const { tool, phase: phaseNum, projectPath, promptDir, noVerify } = opts;

  console.log("");
  console.log("═══════════════════════════════════════════════════════════════");
  console.log("  Execute Mode");
  console.log("═══════════════════════════════════════════════════════════════");
  console.log("");

  // Load project
  const project = loadProject(projectPath);
  console.log(`Project: ${project.project}`);

  // Find target phase
  const phase = findTargetPhase(project, phaseNum);
  if (!phase) {
    if (phaseNum !== null && phaseNum !== undefined) {
      throw new Error(`Phase ${phaseNum} not found in project.json`);
    } else {
      console.log("No pending phases found. All phases complete!");
      return;
    }
  }

  console.log(`Phase: ${phase.id}. ${phase.name}`);
  console.log(`Goal: ${phase.goal}`);
  console.log(`Tasks: ${phase.tasks.length}`);
  console.log("");

  // Update phase status to executing
  phase.status = "executing";
  saveProject(projectPath, project);

  // Load base prompt
  const basePrompt = loadExecutorPrompt(promptDir);
  const adapter = getAdapter(tool);

  // Execute each task sequentially
  for (let i = 0; i < phase.tasks.length; i++) {
    const task = phase.tasks[i];
    console.log("───────────────────────────────────────────────────────────────");
    console.log(`  Task ${i + 1}/${phase.tasks.length}`);
    console.log("───────────────────────────────────────────────────────────────");
    console.log(`  ${task}`);
    console.log("");

    const taskPrompt = buildTaskPrompt(basePrompt, project, phase, task, i);

    let blocked = false;
    let checkpointNeeded = false;

    const result = await spawnAgent({
      adapter,
      prompt: taskPrompt,
      cwd: process.cwd(),
      onOutput: (line) => {
        process.stdout.write(line + "\n");
      },
      onSignal: (signal: Signal) => {
        if (signal.type === "TASK_COMPLETE") {
          console.log("");
          console.log(`✓ Task ${i + 1} completed`);
          if (signal.attrs.commit) {
            console.log(`  Commit: ${signal.attrs.commit}`);
          }
          if (signal.attrs.files) {
            console.log(`  Files: ${signal.attrs.files}`);
          }
        } else if (signal.type === "BLOCKED") {
          console.log("");
          console.log(`⚠ Task ${i + 1} blocked: ${signal.attrs.reason}`);
          console.log(signal.body || "");
          blocked = true;
        } else if (signal.type === "CHECKPOINT") {
          console.log("");
          console.log(`⏸ Checkpoint: ${signal.attrs.type}`);
          console.log(signal.body || "");
          checkpointNeeded = true;
        }
      },
    });

    // Check for signals in result
    const taskComplete = result.signals.some((s) => s.type === "TASK_COMPLETE");
    const taskBlocked = result.signals.some((s) => s.type === "BLOCKED") || blocked;
    const needsCheckpoint = result.signals.some((s) => s.type === "CHECKPOINT") || checkpointNeeded;

    if (taskBlocked) {
      console.log("");
      console.log("Execution blocked. Fix the issue and re-run ./marge.sh execute");
      phase.status = "pending";
      saveProject(projectPath, project);
      process.exit(1);
    }

    if (needsCheckpoint) {
      console.log("");
      console.log("Checkpoint reached. Resume with ./marge.sh execute");
      phase.status = "executing";
      saveProject(projectPath, project);
      process.exit(0);
    }

    if (!taskComplete && result.exitCode !== 0) {
      console.log("");
      console.log(`Task ${i + 1} failed (exit code: ${result.exitCode})`);
      phase.status = "pending";
      saveProject(projectPath, project);
      process.exit(1);
    }

    console.log("");
  }

  // All tasks complete
  console.log("═══════════════════════════════════════════════════════════════");
  console.log(`  Phase ${phase.id} complete!`);
  console.log("═══════════════════════════════════════════════════════════════");
  console.log("");

  phase.status = "complete";
  saveProject(projectPath, project);

  // Show next steps
  const nextPhase = project.phases.find((p) => p.status === "pending");
  if (nextPhase) {
    console.log("Next phase:");
    console.log(`  ${nextPhase.id}. ${nextPhase.name}`);
    console.log("");
    console.log("Run: ./marge.sh execute");
  } else {
    console.log("All phases complete! 🎉");
  }

  if (!noVerify) {
    console.log("");
    console.log("To verify this phase:");
    console.log(`  ./marge.sh verify --phase ${phase.id}`);
  }
}
