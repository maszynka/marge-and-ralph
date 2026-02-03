import { existsSync, readFileSync } from "fs";
import { join } from "path";

interface Phase {
  id: string;
  name: string;
  goal: string;
  tasks: string[];
  status: "pending" | "planned" | "executing" | "complete";
}

interface ProjectConfig {
  project: string;
  description: string;
  phases: Phase[];
}

export function showStatus(projectPath: string): void {
  if (!existsSync(projectPath)) {
    console.log(`[status] Project file not found: ${projectPath}`);
    process.exit(1);
  }

  const config: ProjectConfig = JSON.parse(readFileSync(projectPath, "utf-8"));

  console.log(`\n${"=".repeat(60)}`);
  console.log(`PROJECT: ${config.project}`);
  console.log(`${"=".repeat(60)}\n`);

  // Count phases by status
  const statusCounts = {
    complete: 0,
    executing: 0,
    planned: 0,
    pending: 0,
  };

  config.phases.forEach((phase) => {
    statusCounts[phase.status]++;
  });

  const totalPhases = config.phases.length;
  const completedPhases = statusCounts.complete;

  // Display phase breakdown
  console.log("PHASES:");
  config.phases.forEach((phase, index) => {
    const statusIcon = {
      complete: "✓",
      executing: "▶",
      planned: "○",
      pending: "·",
    }[phase.status];

    const isCurrent = phase.status === "executing" ||
                      (phase.status === "pending" && index > 0 && config.phases[index - 1].status === "complete") ||
                      (phase.status === "pending" && index === 0 && statusCounts.complete === 0);

    const marker = isCurrent ? " ← CURRENT" : "";

    console.log(`  ${statusIcon} Phase ${phase.id}: ${phase.name} [${phase.status}]${marker}`);
  });

  console.log(`\nPROGRESS:`);
  console.log(`  Completed: ${completedPhases}/${totalPhases} phases`);
  console.log(`  Executing: ${statusCounts.executing}`);
  console.log(`  Planned:   ${statusCounts.planned}`);
  console.log(`  Pending:   ${statusCounts.pending}`);

  // Suggest next action
  console.log(`\n${"=".repeat(60)}`);

  const currentPhase = config.phases.find(p => p.status === "executing") ||
                       config.phases.find(p => p.status === "pending");

  if (currentPhase) {
    if (currentPhase.status === "pending") {
      console.log(`NEXT ACTION: ./marge.sh plan --phase ${currentPhase.id}`);
    } else if (currentPhase.status === "planned") {
      console.log(`NEXT ACTION: ./marge.sh execute --phase ${currentPhase.id}`);
    } else if (currentPhase.status === "executing") {
      console.log(`NEXT ACTION: ./marge.sh verify --phase ${currentPhase.id}`);
    }
  } else {
    console.log("ALL PHASES COMPLETE!");
  }

  console.log(`${"=".repeat(60)}\n`);
}
