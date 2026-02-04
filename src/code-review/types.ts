/**
 * Type definitions for code review system.
 *
 * The code review system orchestrates automated PR reviews by:
 *   1. Resolving PR metadata from URLs or branch names
 *   2. Creating isolated review sessions with git worktrees
 *   3. Spawning an agent with project context and DoD criteria
 *   4. Parsing review findings from agent signals
 *   5. Generating artifacts (markdown report, JSON findings, CI summary)
 */

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/**
 * Options for running a code review.
 */
export interface CodeReviewOptions {
  /** PR URL (github/gitlab) or branch name to review. */
  input: string;

  /** Path to Definition of Done (DoD) file. Optional. */
  dodFile?: string;

  /** Additional review criteria as text. Optional. */
  criteria?: string;

  /** Sandbox mode: 'none' | 'docker'. Default: 'none'. */
  sandbox?: "none" | "docker";

  /** Keep worktree after review completes (for debugging). Default: false. */
  keepWorktree?: boolean;

  /** Output directory for artifacts. Default: .cr-sessions/<session-id>/ */
  outputDir?: string;

  /** Tool adapter to use (claude, gemini, etc.). Default: from config. */
  tool?: string;

  /** Maximum iterations for agent (safety limit). Default: 50. */
  maxIterations?: number;
}

// ---------------------------------------------------------------------------
// PR metadata
// ---------------------------------------------------------------------------

/**
 * Platform hosting the PR (GitHub or GitLab).
 */
export type PRPlatform = "github" | "gitlab";

/**
 * Metadata about the pull request being reviewed.
 */
export interface PRMetadata {
  /** Platform: github or gitlab. */
  platform: PRPlatform;

  /** Owner/organization name. */
  owner: string;

  /** Repository name. */
  repo: string;

  /** PR number (for GitHub) or MR IID (for GitLab). */
  number: number;

  /** Branch name (head/source branch). */
  branch: string;

  /** Base branch (target branch, e.g., main). */
  baseBranch: string;

  /** PR title. */
  title: string;

  /** PR description/body. */
  description: string;

  /** URL to related ticket (JIRA, Linear, etc.) if found in description. */
  ticketUrl?: string;

  /** Full URL to the PR. */
  url: string;
}

// ---------------------------------------------------------------------------
// Review session
// ---------------------------------------------------------------------------

/**
 * A review session tracks the isolated environment and metadata for one review.
 */
export interface ReviewSession {
  /** Unique session ID (timestamp + short hash). */
  id: string;

  /** Path to session directory (.cr-sessions/cr-<id>/). */
  sessionDir: string;

  /** Path to git worktree created for this review. */
  worktreePath: string;

  /** PR metadata. */
  pr: PRMetadata;

  /** Definition of Done content (from file or default). */
  dod: string;

  /** Additional review criteria. */
  criteria: string;

  /** Start timestamp. */
  startTime: Date;

  /** End timestamp (set when review completes). */
  endTime?: Date;

  /** Review findings collected during the session. */
  findings: ReviewFinding[];

  /** Agent stdout log. */
  agentLog: string;
}

// ---------------------------------------------------------------------------
// Review findings
// ---------------------------------------------------------------------------

/**
 * Severity level for a review finding.
 */
export type FindingSeverity = "critical" | "high" | "medium" | "low" | "info";

/**
 * Category of the finding.
 */
export type FindingCategory =
  | "correctness"
  | "security"
  | "performance"
  | "maintainability"
  | "style"
  | "documentation"
  | "testing"
  | "other";

/**
 * A single review finding emitted by the agent.
 */
export interface ReviewFinding {
  /** Unique ID within the session (auto-generated or from signal). */
  id: string;

  /** Severity level. */
  severity: FindingSeverity;

  /** Category. */
  category: FindingCategory;

  /** File path (relative to repo root). */
  file: string;

  /** Line number (optional). */
  line?: number;

  /** Short title/summary. */
  title: string;

  /** Detailed description. */
  description: string;

  /** Suggested fix or recommendation. */
  suggestion?: string;

  /** Code snippet showing the issue (optional). */
  snippet?: string;
}

// ---------------------------------------------------------------------------
// Review result
// ---------------------------------------------------------------------------

/**
 * Overall review outcome.
 */
export type ReviewOutcome = "pass" | "fail" | "warning" | "error";

/**
 * Final result of a code review.
 */
export interface ReviewResult {
  /** Session metadata. */
  session: ReviewSession;

  /** Overall outcome. */
  outcome: ReviewOutcome;

  /** Summary message (one-liner for CI). */
  summary: string;

  /** Path to generated markdown report. */
  reportPath: string;

  /** Path to generated JSON findings file. */
  findingsPath: string;

  /** Path to CI summary file. */
  summaryPath: string;

  /** Total findings by severity. */
  stats: {
    critical: number;
    high: number;
    medium: number;
    low: number;
    info: number;
  };
}
