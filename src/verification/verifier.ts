/**
 * Verification orchestrator.
 *
 * Loads project.json, finds the target phase, and spawns a verifier agent
 * to check if the phase goal was actually achieved (not just if tasks were completed).
 */

import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { getAdapter } from "../agents/adapters";
import { spawnAgent } from "../agents/spawn";
import type { Signal, VerificationSignal } from "../agents/signals";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface VerifyOptions {
  tool: string;
  phase?: number | null;
  projectPath: string;
  promptDir: string;
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

export interface VerificationResult {
  status: "passed" | "gaps_found" | "human_needed";
  score: number;
  details: string;
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

function findTargetPhase(project: ProjectJson, phaseNum?: number | null): Phase | null {
  if (phaseNum !== null && phaseNum !== undefined) {
    // Find specific phase by number
    const phaseId = phaseNum.toString().padStart(2, "0");
    return project.phases.find((p) => p.id === phaseId) ?? null;
  }

  // Find first complete phase (most recent)
  const completePhases = project.phases.filter((p) => p.status === "complete");
  return completePhases[completePhases.length - 1] ?? null;
}

// ---------------------------------------------------------------------------
// Prompt building
// ---------------------------------------------------------------------------

function loadVerifierPrompt(promptDir: string): string {
  const path = join(promptDir, "verifier.md");
  if (!existsSync(path)) {
    throw new Error(`Verifier prompt not found: ${path}`);
  }
  return readFileSync(path, "utf-8");
}

function buildVerificationPrompt(
  basePrompt: string,
  project: ProjectJson,
  phase: Phase
): string {
  const completedTasks = phase.tasks.map((task, i) => `${i + 1}. ${task}`).join("\n");

  return basePrompt
    .replace("{PROJECT_CONTEXT}", project.description)
    .replace("{PHASE_GOAL}", phase.goal)
    .replace("{COMPLETED_TASKS}", completedTasks)
    .replace("{PHASE_NAME}", phase.name)
    .replace("{PHASE_ID}", phase.id);
}

// ---------------------------------------------------------------------------
// Main verifier
// ---------------------------------------------------------------------------

export async function runVerifier(opts: VerifyOptions): Promise<VerificationResult> {
  const { tool, phase: phaseNum, projectPath, promptDir } = opts;

  console.log("");
  console.log("═══════════════════════════════════════════════════════════════");
  console.log("  Verify Mode");
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
      console.log("No completed phases found. Execute a phase first!");
      process.exit(1);
    }
  }

  console.log(`Phase: ${phase.id}. ${phase.name}`);
  console.log(`Goal: ${phase.goal}`);
  console.log(`Status: ${phase.status}`);
  console.log("");

  if (phase.status !== "complete") {
    console.log("⚠ Warning: Phase is not marked as complete.");
    console.log("  Verification may fail if tasks are not finished.");
    console.log("");
  }

  console.log("Starting verification...");
  console.log("");

  // Load base prompt
  const verificationPrompt = buildVerificationPrompt(
    loadVerifierPrompt(promptDir),
    project,
    phase
  );

  const adapter = getAdapter(tool);

  let verificationSignal: VerificationSignal | null = null;

  const result = await spawnAgent({
    adapter,
    prompt: verificationPrompt,
    cwd: process.cwd(),
    onOutput: (line) => {
      process.stdout.write(line + "\n");
    },
    onSignal: (signal: Signal) => {
      if (signal.type === "VERIFICATION") {
        verificationSignal = signal as VerificationSignal;
        console.log("");
        console.log("═══════════════════════════════════════════════════════════════");
        console.log("  Verification Complete");
        console.log("═══════════════════════════════════════════════════════════════");
        console.log("");
        console.log(`Status: ${signal.attrs.status}`);
        console.log(`Score: ${signal.attrs.score}/10`);
        console.log("");
        if (signal.body) {
          console.log(signal.body);
          console.log("");
        }
      }
    },
  });

  // Check for verification signal
  if (!verificationSignal) {
    verificationSignal = result.signals.find((s) => s.type === "VERIFICATION") as VerificationSignal | undefined ?? null;
  }

  if (!verificationSignal) {
    console.error("ERROR: No VERIFICATION signal received from agent");
    console.error("Agent may have failed or not emitted the required signal");
    process.exit(1);
  }

  const status = verificationSignal.attrs.status as "passed" | "gaps_found" | "human_needed";
  const score = parseInt(verificationSignal.attrs.score, 10);

  // Display results
  if (status === "passed") {
    console.log("✓ Phase goal achieved!");
  } else if (status === "gaps_found") {
    console.log("⚠ Gaps found in implementation");
  } else if (status === "human_needed") {
    console.log("⏸ Human verification required");
  }

  return {
    status,
    score,
    details: verificationSignal.body,
  };
}
