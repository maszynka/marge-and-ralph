/**
 * Main orchestrator for code review workflow.
 *
 * This module coordinates the entire code review process:
 * 1. Parse input (PR URL or branch name)
 * 2. Resolve PR metadata via gh/glab CLI
 * 3. Create isolated session with git worktree
 * 4. Load review context (DoD, criteria, PR changes)
 * 5. Generate review prompt from template
 * 6. Spawn agent to perform review
 * 7. Parse signals (REVIEW_FINDING, REVIEW_COMPLETE)
 * 8. Generate artifacts (markdown report, JSON findings, CI summary)
 * 9. Cleanup worktree and session
 */

import { existsSync, readFileSync } from "fs";
import { execSync } from "child_process";
import { join, resolve } from "path";
import type {
  CodeReviewOptions,
  ReviewSession,
  ReviewResult,
  ReviewFinding,
  ReviewOutcome,
} from "./types";
import { resolvePR } from "./pr-resolver";
import { createSession, writeInstructions, cleanupSession } from "./session";
import { createDockerAdapter, ensureDockerImage } from "./docker";
import { generateArtifacts } from "./artifacts";
import { getAdapter } from "../agents/adapters/index";
import { spawnAgent } from "../agents/spawn";
import type { Signal } from "../agents/signals";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_MAX_ITERATIONS = 50;
const DEFAULT_DOD_CONTENT = `## Default Definition of Done

- Code compiles/builds without errors
- Code follows project conventions and style guide
- No critical security vulnerabilities
- Tests exist for new functionality
- Documentation updated as needed
- PR description clearly explains changes
- No TODOs or FIXMEs introduced without tracking
`;

// ---------------------------------------------------------------------------
// Helper functions
// ---------------------------------------------------------------------------

/**
 * Creates a git worktree for the PR branch.
 *
 * @param branch - Branch name to checkout
 * @param sessionId - Unique session identifier
 * @returns Absolute path to the created worktree
 */
function createWorktree(branch: string, sessionId: string): string {
  const worktreeDir = join(process.cwd(), ".cr-sessions", sessionId, "worktree");

  try {
    // Create worktree for the PR branch
    execSync(`git worktree add "${worktreeDir}" "${branch}"`, {
      stdio: "pipe",
      encoding: "utf-8",
    });

    return resolve(worktreeDir);
  } catch (error) {
    throw new Error(
      `[reviewer] Failed to create git worktree for branch "${branch}": ${error}`
    );
  }
}

/**
 * Loads Definition of Done content from file or uses default.
 *
 * @param dodFile - Optional path to DoD file
 * @returns DoD content as string
 */
function loadDod(dodFile?: string): string {
  if (!dodFile) {
    return DEFAULT_DOD_CONTENT;
  }

  if (!existsSync(dodFile)) {
    console.warn(
      `[reviewer] DoD file not found: ${dodFile}. Using default DoD.`
    );
    return DEFAULT_DOD_CONTENT;
  }

  try {
    return readFileSync(dodFile, "utf-8");
  } catch (error) {
    console.warn(
      `[reviewer] Failed to read DoD file: ${dodFile}. Using default DoD. Error: ${error}`
    );
    return DEFAULT_DOD_CONTENT;
  }
}

/**
 * Generates the review prompt from template with placeholder substitution.
 *
 * @param session - Review session with PR metadata and context
 * @returns Fully populated prompt string
 */
function generatePrompt(session: ReviewSession): string {
  const templatePath = join(__dirname, "..", "prompts", "code-review.md");

  if (!existsSync(templatePath)) {
    throw new Error(
      `[reviewer] Prompt template not found: ${templatePath}`
    );
  }

  let template = readFileSync(templatePath, "utf-8");

  // Get project name from package.json or use repo name as fallback
  let projectName = session.pr.repo;
  const packageJsonPath = join(process.cwd(), "package.json");
  if (existsSync(packageJsonPath)) {
    try {
      const pkg = JSON.parse(readFileSync(packageJsonPath, "utf-8"));
      if (pkg.name) {
        projectName = pkg.name;
      }
    } catch {
      // Ignore parsing errors, use repo name
    }
  }

  // Build ticket section if ticket URL exists
  const ticketSection = session.pr.ticketUrl
    ? `**Ticket:** ${session.pr.ticketUrl}`
    : "";

  // Replace placeholders
  template = template.replace(/{PROJECT_NAME}/g, projectName);
  template = template.replace(/{PR_PLATFORM}/g, session.pr.platform);
  template = template.replace(/{PR_TITLE}/g, session.pr.title);
  template = template.replace(/{PR_BRANCH}/g, session.pr.branch);
  template = template.replace(/{PR_BASE_BRANCH}/g, session.pr.baseBranch);
  template = template.replace(/{PR_URL}/g, session.pr.url);
  template = template.replace(
    /{PR_DESCRIPTION}/g,
    session.pr.description || "(No description provided)"
  );
  template = template.replace(/{TICKET_SECTION}/g, ticketSection);
  template = template.replace(/{DOD_CONTENT}/g, session.dod);
  template = template.replace(
    /{CRITERIA_CONTENT}/g,
    session.criteria || "(No additional criteria specified)"
  );

  return template;
}

/**
 * Parses a REVIEW_FINDING signal into a ReviewFinding object.
 *
 * @param signal - REVIEW_FINDING signal from agent
 * @param index - Finding index for ID generation
 * @returns ReviewFinding object
 */
function parseFinding(signal: Signal, index: number): ReviewFinding {
  const { attrs, body } = signal;

  // Extract parts from body using markdown sections
  let description = body;
  let suggestion: string | undefined;
  let snippet: string | undefined;

  // Parse suggestion section if present
  const suggestionMatch = body.match(
    /\*\*Suggestion:\*\*\s*([^\n]*(?:\n(?!\*\*)[^\n]*)*)/i
  );
  if (suggestionMatch) {
    suggestion = suggestionMatch[1].trim();
    description = body.slice(0, suggestionMatch.index).trim();
  }

  // Parse code snippet if present (between ``` markers)
  const snippetMatch = body.match(/```[\w]*\n([\s\S]*?)```/);
  if (snippetMatch) {
    snippet = snippetMatch[1].trim();
  }

  // Remove suggestion and snippet sections from description
  description = description
    .replace(/\*\*Suggestion:\*\*[\s\S]*/, "")
    .replace(/```[\w]*\n[\s\S]*?```/, "")
    .trim();

  return {
    id: `finding-${index + 1}`,
    severity: attrs.severity as ReviewFinding["severity"],
    category: attrs.category as ReviewFinding["category"],
    file: attrs.file,
    line: attrs.line ? parseInt(attrs.line, 10) : undefined,
    title: attrs.title,
    description,
    suggestion,
    snippet,
  };
}

/**
 * Determines overall review outcome from findings.
 *
 * Logic:
 * - critical or high findings → fail
 * - medium findings (no critical/high) → warning
 * - only low/info findings → pass
 * - no findings → pass
 *
 * @param findings - Array of review findings
 * @returns Review outcome
 */
function determineOutcome(findings: ReviewFinding[]): ReviewOutcome {
  const hasCritical = findings.some((f) => f.severity === "critical");
  const hasHigh = findings.some((f) => f.severity === "high");
  const hasMedium = findings.some((f) => f.severity === "medium");

  if (hasCritical || hasHigh) {
    return "fail";
  }

  if (hasMedium) {
    return "warning";
  }

  return "pass";
}

// ---------------------------------------------------------------------------
// Main orchestrator
// ---------------------------------------------------------------------------

/**
 * Runs a complete code review workflow.
 *
 * This is the main entry point that coordinates all review steps:
 * 1. Resolve PR metadata from input (URL or branch)
 * 2. Create isolated session directory and git worktree
 * 3. Load context (DoD, criteria)
 * 4. Generate review prompt from template
 * 5. Spawn agent to perform review
 * 6. Parse signals to collect findings
 * 7. Generate artifacts (report, findings, summary)
 * 8. Cleanup (worktree, session)
 *
 * @param options - Code review configuration
 * @returns ReviewResult with outcome, artifacts, and stats
 */
export async function runCodeReview(
  options: CodeReviewOptions
): Promise<ReviewResult> {
  const {
    input,
    dodFile,
    criteria = "",
    sandbox = "none",
    keepWorktree = false,
    outputDir,
    tool = "claude",
    maxIterations = DEFAULT_MAX_ITERATIONS,
  } = options;

  console.log(`[reviewer] Starting code review for: ${input}`);

  // Step 1: Resolve PR metadata
  console.log(`[reviewer] Resolving PR metadata...`);
  const pr = resolvePR(input);
  console.log(
    `[reviewer] Resolved: ${pr.platform} ${pr.owner}/${pr.repo}#${pr.number} - ${pr.title}`
  );

  // Step 2: Load context
  const dod = loadDod(dodFile);

  // Step 3: Create session (temporary ID, will create worktree next)
  console.log(`[reviewer] Creating review session...`);
  const tempWorktreePath = ""; // Will be set after worktree creation
  const session = createSession(pr, tempWorktreePath, dod, criteria);

  console.log(`[reviewer] Session ID: ${session.id}`);
  console.log(`[reviewer] Session directory: ${session.sessionDir}`);

  // Step 4: Create git worktree
  console.log(`[reviewer] Creating git worktree for branch: ${pr.branch}`);
  try {
    session.worktreePath = createWorktree(pr.branch, session.id);
    console.log(`[reviewer] Worktree created: ${session.worktreePath}`);
  } catch (error) {
    console.error(`[reviewer] Failed to create worktree: ${error}`);
    // Cleanup partial session
    cleanupSession(session, false, false);
    throw error;
  }

  // Step 5: Generate review prompt
  console.log(`[reviewer] Generating review prompt...`);
  const prompt = generatePrompt(session);
  writeInstructions(session, prompt);
  console.log(
    `[reviewer] Instructions written: ${join(session.sessionDir, "instructions.md")}`
  );

  // Step 6: Get adapter (with optional Docker wrapper)
  let adapter = getAdapter(tool);
  if (sandbox === "docker") {
    console.log(`[reviewer] Enabling Docker sandbox...`);
    ensureDockerImage();
    adapter = createDockerAdapter(adapter, session.worktreePath);
    console.log(`[reviewer] Docker adapter ready`);
  }

  // Step 7: Spawn agent
  console.log(`[reviewer] Spawning agent: ${adapter.name}`);
  console.log(`[reviewer] Max iterations: ${maxIterations}`);
  console.log(`[reviewer] Working directory: ${session.worktreePath}`);
  console.log("");
  console.log("=".repeat(70));
  console.log("  CODE REVIEW IN PROGRESS");
  console.log("=".repeat(70));
  console.log("");

  let findingCount = 0;
  let completeSignalReceived = false;
  let completeSummary = "";
  let completeOutcome: ReviewOutcome | undefined;

  const result = await spawnAgent({
    adapter,
    prompt,
    cwd: session.worktreePath,
    onOutput: (line) => {
      session.agentLog += line + "\n";
      process.stdout.write(line + "\n");
    },
    onSignal: (signal) => {
      if (signal.type === "REVIEW_FINDING") {
        const finding = parseFinding(signal, findingCount);
        session.findings.push(finding);
        findingCount++;

        console.log("");
        console.log(
          `[reviewer] Finding #${findingCount}: [${finding.severity.toUpperCase()}] ${finding.title} (${finding.file})`
        );
        console.log("");
      } else if (signal.type === "REVIEW_COMPLETE") {
        completeSignalReceived = true;
        completeSummary = signal.attrs.summary || "Review complete";
        completeOutcome = signal.attrs.outcome as ReviewOutcome;

        console.log("");
        console.log("=".repeat(70));
        console.log("  REVIEW COMPLETE");
        console.log("=".repeat(70));
        console.log(`  Outcome: ${completeOutcome}`);
        console.log(`  Summary: ${completeSummary}`);
        console.log(`  Findings: ${findingCount}`);
        console.log("=".repeat(70));
        console.log("");
      }
    },
    timeout: 0, // No timeout
  });

  // Step 8: Set end time
  session.endTime = new Date();

  // Step 9: Determine outcome (from signal or fallback to heuristic)
  let outcome: ReviewOutcome;
  let summary: string;

  if (completeSignalReceived && completeOutcome) {
    outcome = completeOutcome;
    summary = completeSummary;
  } else {
    // Fallback: agent didn't emit REVIEW_COMPLETE signal
    console.warn(
      `[reviewer] Warning: Agent did not emit REVIEW_COMPLETE signal. Using fallback outcome determination.`
    );
    outcome = determineOutcome(session.findings);
    summary = `Review completed with ${session.findings.length} findings. No completion signal received.`;
  }

  // Handle non-zero exit codes
  if (result.exitCode !== 0) {
    console.error(
      `[reviewer] Agent exited with non-zero code: ${result.exitCode}`
    );
    outcome = "error";
    summary = `Agent failed with exit code ${result.exitCode}. Check logs for details.`;
  }

  // Step 10: Generate artifacts
  console.log(`[reviewer] Generating artifacts...`);
  const reviewResult = generateArtifacts(session, outcome, summary, outputDir);

  console.log(`[reviewer] Artifacts generated:`);
  console.log(`  - Report: ${reviewResult.reportPath}`);
  console.log(`  - Findings: ${reviewResult.findingsPath}`);
  console.log(`  - Summary: ${reviewResult.summaryPath}`);

  // Step 11: Cleanup
  console.log(`[reviewer] Cleaning up...`);
  const keepSession = true; // Always keep session directory (it has the artifacts)
  cleanupSession(session, keepWorktree, keepSession);

  if (keepWorktree) {
    console.log(
      `[reviewer] Worktree preserved: ${session.worktreePath}`
    );
  } else {
    console.log(`[reviewer] Worktree removed`);
  }

  console.log("");
  console.log("=".repeat(70));
  console.log(`  REVIEW ${outcome.toUpperCase()}`);
  console.log("=".repeat(70));
  console.log(`  ${summary}`);
  console.log("");
  console.log(`  Stats:`);
  console.log(`    Critical: ${reviewResult.stats.critical}`);
  console.log(`    High:     ${reviewResult.stats.high}`);
  console.log(`    Medium:   ${reviewResult.stats.medium}`);
  console.log(`    Low:      ${reviewResult.stats.low}`);
  console.log(`    Info:     ${reviewResult.stats.info}`);
  console.log("");
  console.log(`  Full report: ${reviewResult.reportPath}`);
  console.log("=".repeat(70));
  console.log("");

  return reviewResult;
}
