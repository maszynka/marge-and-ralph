/**
 * Planning loop with discovery phase.
 *
 * Flow:
 *   1. Get goal from user
 *   2. DISCOVERY LOOP: Planner asks questions → user answers → repeat until ready
 *   3. PLANNING LOOP: Planner proposes plan → user approves/feedback → repeat until approved
 *   4. Save project.json
 */

import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import * as readline from "readline";
import { getAdapter } from "../agents/adapters";
import { spawnAgent } from "../agents/spawn";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PlanningOptions {
  tool: string;
  maxIterations: number;
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

type PlannerMode = "discovery" | "planning";

// ---------------------------------------------------------------------------
// User input helpers
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

async function promptMultiline(rl: readline.Interface, question: string): Promise<string> {
  console.log(question);
  console.log("(Enter empty line to finish)");

  const lines: string[] = [];
  while (true) {
    const line = await prompt(rl, "> ");
    if (line === "") break;
    lines.push(line);
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Output parsing
// ---------------------------------------------------------------------------

function detectMode(output: string): PlannerMode {
  if (output.includes("<!-- SIGNAL:DISCOVERY_QUESTIONS")) return "discovery";
  if (output.includes("<!-- SIGNAL:PLAN_PROPOSAL")) return "planning";
  // Default to discovery if unclear
  return "discovery";
}

function parseDiscoveryQuestions(output: string): string | null {
  const match = output.match(/<!-- SIGNAL:DISCOVERY_QUESTIONS[^>]*-->([\s\S]*?)<!-- \/SIGNAL -->/);
  return match ? match[1].trim() : null;
}

function parsePlanFromOutput(output: string): { phases: Phase[]; rawPlan: string } | null {
  const signalMatch = output.match(/<!-- SIGNAL:PLAN_PROPOSAL[^>]*-->([\s\S]*?)<!-- \/SIGNAL -->/);
  if (!signalMatch) return null;

  const rawPlan = signalMatch[1].trim();
  const phases: Phase[] = [];

  // Parse phases - handle both "**Tasks:**" and "**Why first:**" formats
  const phaseRegex = /### Phase (\d+): ([^\n]+)\n\*\*Goal:\*\* ([^\n]+)/g;
  let phaseMatch;

  while ((phaseMatch = phaseRegex.exec(rawPlan)) !== null) {
    const [fullMatch, num, name, goal] = phaseMatch;
    const phaseStart = phaseMatch.index;

    // Find tasks section for this phase
    const afterGoal = rawPlan.slice(phaseStart);
    const tasksMatch = afterGoal.match(/\*\*Tasks:\*\*\n((?:\d+\. [^\n]+\n?)+)/);

    const tasks = tasksMatch
      ? tasksMatch[1]
          .split("\n")
          .filter((line) => /^\d+\./.test(line.trim()))
          .map((line) => line.replace(/^\d+\.\s*/, "").trim())
      : [];

    phases.push({
      id: num.padStart(2, "0"),
      name: name.trim(),
      goal: goal.trim(),
      tasks,
      status: "pending",
    });
  }

  return phases.length > 0 ? { phases, rawPlan } : null;
}

// ---------------------------------------------------------------------------
// Build prompts
// ---------------------------------------------------------------------------

function loadPlannerPrompt(promptDir: string): string {
  const path = join(promptDir, "planner.md");
  if (!existsSync(path)) {
    throw new Error(`Planner prompt not found: ${path}`);
  }
  return readFileSync(path, "utf-8");
}

function buildDiscoveryPrompt(basePrompt: string, goal: string, context: string): string {
  return `${basePrompt}

---

## Your Task

**Goal the user stated:** ${goal}

**Additional context:**
${context || "None provided yet."}

This is your FIRST contact with this goal. Start with DISCOVERY mode — ask clarifying questions before planning.`;
}

function buildAnswersPrompt(basePrompt: string, goal: string, answers: string): string {
  return `${basePrompt}

---

## Your Task

**Goal:** ${goal}

## Answers from Discovery

${answers}

The user has answered your questions. Now create the PLAN_PROPOSAL.`;
}

function buildRevisionPrompt(
  basePrompt: string,
  goal: string,
  answers: string,
  previousPlan: string,
  feedback: string
): string {
  return `${basePrompt}

---

## Your Task (Revision)

**Goal:** ${goal}

## Answers from Discovery

${answers}

## Previous Plan

${previousPlan}

## User Feedback

${feedback}

Revise the plan based on feedback. If feedback is ambiguous, ask 1-2 clarifying questions. Otherwise output the complete revised PLAN_PROPOSAL.`;
}

// ---------------------------------------------------------------------------
// Main planning loop
// ---------------------------------------------------------------------------

export async function runPlanningLoop(opts: PlanningOptions): Promise<void> {
  const { tool, maxIterations, projectPath, promptDir } = opts;
  const adapter = getAdapter(tool);
  const rl = createReadline();

  console.log("");
  console.log("═══════════════════════════════════════════════════════════════");
  console.log("  Planning Mode — Discovery → Plan → Approve");
  console.log("═══════════════════════════════════════════════════════════════");
  console.log("");

  // Check for existing project
  let goal = "";
  let discoveryAnswers = "";

  if (existsSync(projectPath)) {
    const existing = JSON.parse(readFileSync(projectPath, "utf-8")) as ProjectJson;
    console.log(`Found existing project: ${existing.project}`);
    const action = await prompt(rl, "Continue with existing project? (y/n/new goal): ");

    if (action.toLowerCase() === "y") {
      goal = existing.description;
      discoveryAnswers = existing.discoveryAnswers || "";
      console.log(`Using existing goal: ${goal}`);
    } else if (action.toLowerCase() !== "n") {
      goal = action;
    }
  }

  // Get goal if not set
  if (!goal) {
    goal = await prompt(rl, "What do you want to build? > ");
    if (!goal) {
      console.log("No goal provided. Exiting.");
      rl.close();
      return;
    }
  }

  const basePrompt = loadPlannerPrompt(promptDir);
  let currentPlan = "";
  let iteration = 0;
  let mode: PlannerMode = discoveryAnswers ? "planning" : "discovery";

  while (iteration < maxIterations) {
    iteration++;
    console.log("");
    console.log("───────────────────────────────────────────────────────────────");
    console.log(`  Iteration ${iteration}/${maxIterations} — ${mode === "discovery" ? "Discovery" : "Planning"}`);
    console.log("───────────────────────────────────────────────────────────────");
    console.log("");

    // Build prompt based on mode
    let agentPrompt: string;
    if (mode === "discovery") {
      agentPrompt = buildDiscoveryPrompt(basePrompt, goal, discoveryAnswers);
    } else if (currentPlan) {
      agentPrompt = buildRevisionPrompt(basePrompt, goal, discoveryAnswers, currentPlan, "");
    } else {
      agentPrompt = buildAnswersPrompt(basePrompt, goal, discoveryAnswers);
    }

    // Spawn planner
    console.log(`[planner] Thinking with ${tool}...`);
    console.log("");

    const result = await spawnAgent({
      adapter,
      prompt: agentPrompt,
      cwd: process.cwd(),
      onOutput: (line) => {
        if (!line.includes("<!-- SIGNAL:") && !line.includes("<!-- /SIGNAL")) {
          console.log(line);
        }
      },
    });

    const detectedMode = detectMode(result.stdout);

    // Handle DISCOVERY mode
    if (detectedMode === "discovery") {
      const questions = parseDiscoveryQuestions(result.stdout);
      if (!questions) {
        console.log("[planner] Could not parse questions. Retrying...");
        continue;
      }

      console.log("");
      console.log("═══════════════════════════════════════════════════════════════");
      console.log("  Planner has questions for you");
      console.log("═══════════════════════════════════════════════════════════════");
      console.log("");

      const answers = await promptMultiline(rl, "Your answers (address the questions above):");

      if (!answers) {
        const skip = await prompt(rl, "No answers provided. Skip discovery and plan anyway? (y/n): ");
        if (skip.toLowerCase() === "y") {
          mode = "planning";
          discoveryAnswers = "(User skipped discovery)";
        }
        continue;
      }

      // Accumulate answers
      discoveryAnswers += (discoveryAnswers ? "\n\n" : "") + `## Answers (iteration ${iteration})\n${answers}`;

      // Check if user wants to proceed to planning
      const proceed = await prompt(rl, "Ready to see the plan? (y) or continue discussion (n): ");
      if (proceed.toLowerCase() === "y") {
        mode = "planning";
      }
      continue;
    }

    // Handle PLANNING mode
    const parsed = parsePlanFromOutput(result.stdout);
    if (!parsed) {
      console.log("");
      console.log("[planner] Could not parse plan. The planner may still be asking questions.");
      const moreContext = await promptMultiline(rl, "Add more context or answers:");
      if (moreContext) {
        discoveryAnswers += `\n\n## Additional context\n${moreContext}`;
      }
      continue;
    }

    currentPlan = parsed.rawPlan;

    // Show summary
    console.log("");
    console.log("═══════════════════════════════════════════════════════════════");
    console.log("  Plan Summary");
    console.log("═══════════════════════════════════════════════════════════════");
    console.log(`  Phases: ${parsed.phases.length}`);
    for (const phase of parsed.phases) {
      console.log(`    ${phase.id}. ${phase.name} (${phase.tasks.length} tasks)`);
      console.log(`        Goal: ${phase.goal}`);
    }
    console.log("");

    // Get user feedback
    const response = await prompt(rl, "(a)pprove / (f)eedback / (q)uit: ");

    if (response.toLowerCase() === "a" || response.toLowerCase() === "approve") {
      // Save project.json
      const projectName = goal
        .split(" ")
        .slice(0, 3)
        .join("-")
        .toLowerCase()
        .replace(/[^a-z0-9-]/g, "");

      const project: ProjectJson = {
        project: projectName,
        description: goal,
        discoveryAnswers,
        phases: parsed.phases,
        config: {
          tool,
          workflow: {
            research: true,
            plan_check: true,
            verifier: true,
          },
        },
      };

      writeFileSync(projectPath, JSON.stringify(project, null, 2));
      console.log("");
      console.log(`✓ Plan approved! Saved to ${projectPath}`);
      console.log("");
      console.log("Next steps:");
      console.log("  ./marge.sh execute --phase 1   # Execute first phase");
      console.log("  ./marge.sh status              # Check progress");
      rl.close();
      return;
    }

    if (response.toLowerCase() === "q" || response.toLowerCase() === "quit") {
      console.log("Planning cancelled.");
      rl.close();
      return;
    }

    // Collect feedback for revision
    console.log("");
    const feedback = await promptMultiline(rl, "What should be changed?");
    if (feedback) {
      discoveryAnswers += `\n\n## Feedback on plan\n${feedback}`;
    }
  }

  console.log("");
  console.log(`Reached max iterations (${maxIterations}).`);
  console.log("Run ./marge.sh plan to continue.");
  rl.close();
}
