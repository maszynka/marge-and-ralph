/**
 * Artifact generation for code reviews.
 *
 * Generates three output files from a completed review session:
 *   1. review-report.md - Human-readable markdown report
 *   2. review-findings.json - Machine-readable JSON findings
 *   3. review-summary.txt - One-liner summary for CI/CD
 */

import { writeFileSync } from "fs";
import { join } from "path";
import type {
  ReviewSession,
  ReviewResult,
  ReviewFinding,
  ReviewOutcome,
} from "./types";

/**
 * Generates all review artifacts from a completed session.
 *
 * Creates three files in the output directory:
 * - review-report.md: Detailed markdown report with findings grouped by severity
 * - review-findings.json: Structured JSON with all findings and metadata
 * - review-summary.txt: Single line summary for CI integration
 *
 * @param session - The completed review session
 * @param outcome - Overall review outcome (pass/fail/warning/error)
 * @param summary - Summary message from REVIEW_COMPLETE signal
 * @param outputDir - Directory to write artifacts (defaults to session directory)
 * @returns ReviewResult object with paths to generated artifacts
 */
export function generateArtifacts(
  session: ReviewSession,
  outcome: ReviewOutcome,
  summary: string,
  outputDir?: string
): ReviewResult {
  const artifactDir = outputDir || session.sessionDir;

  // Calculate stats by severity
  const stats = {
    critical: session.findings.filter((f) => f.severity === "critical").length,
    high: session.findings.filter((f) => f.severity === "high").length,
    medium: session.findings.filter((f) => f.severity === "medium").length,
    low: session.findings.filter((f) => f.severity === "low").length,
    info: session.findings.filter((f) => f.severity === "info").length,
  };

  // Generate file paths
  const reportPath = join(artifactDir, "review-report.md");
  const findingsPath = join(artifactDir, "review-findings.json");
  const summaryPath = join(artifactDir, "review-summary.txt");

  // Generate each artifact
  writeFileSync(reportPath, generateMarkdownReport(session, outcome, summary, stats), "utf-8");
  writeFileSync(findingsPath, generateJsonFindings(session, outcome, summary, stats), "utf-8");
  writeFileSync(summaryPath, generateCISummary(outcome, summary, stats), "utf-8");

  // Construct result object
  const result: ReviewResult = {
    session,
    outcome,
    summary,
    reportPath,
    findingsPath,
    summaryPath,
    stats,
  };

  return result;
}

/**
 * Generates a detailed markdown report.
 *
 * Report structure:
 * - Header with PR info and summary
 * - Overall outcome badge
 * - Stats table
 * - Findings grouped by severity
 * - Session metadata footer
 */
function generateMarkdownReport(
  session: ReviewSession,
  outcome: ReviewOutcome,
  summary: string,
  stats: { critical: number; high: number; medium: number; low: number; info: number }
): string {
  const lines: string[] = [];

  // Header
  lines.push(`# Code Review Report`);
  lines.push(``);
  lines.push(`**PR:** ${session.pr.title}`);
  lines.push(`**Branch:** \`${session.pr.branch}\` → \`${session.pr.baseBranch}\``);
  lines.push(`**Platform:** ${session.pr.platform}`);
  lines.push(`**URL:** ${session.pr.url}`);
  if (session.pr.ticketUrl) {
    lines.push(`**Ticket:** ${session.pr.ticketUrl}`);
  }
  lines.push(``);

  // Outcome badge
  const badge = getOutcomeBadge(outcome);
  lines.push(`## ${badge} ${outcome.toUpperCase()}`);
  lines.push(``);
  lines.push(summary);
  lines.push(``);

  // Stats table
  lines.push(`## Summary`);
  lines.push(``);
  lines.push(`| Severity | Count |`);
  lines.push(`|----------|-------|`);
  lines.push(`| Critical | ${stats.critical} |`);
  lines.push(`| High     | ${stats.high} |`);
  lines.push(`| Medium   | ${stats.medium} |`);
  lines.push(`| Low      | ${stats.low} |`);
  lines.push(`| Info     | ${stats.info} |`);
  lines.push(`| **Total** | **${session.findings.length}** |`);
  lines.push(``);

  // Findings grouped by severity
  if (session.findings.length > 0) {
    lines.push(`## Findings`);
    lines.push(``);

    // Group by severity (in priority order)
    const severityOrder: Array<"critical" | "high" | "medium" | "low" | "info"> = [
      "critical",
      "high",
      "medium",
      "low",
      "info",
    ];

    for (const severity of severityOrder) {
      const findings = session.findings.filter((f) => f.severity === severity);
      if (findings.length === 0) continue;

      lines.push(`### ${getSeverityEmoji(severity)} ${severity.toUpperCase()} (${findings.length})`);
      lines.push(``);

      for (const finding of findings) {
        lines.push(`#### ${finding.title}`);
        lines.push(``);
        lines.push(`- **Category:** ${finding.category}`);
        lines.push(`- **File:** \`${finding.file}\`${finding.line ? `:${finding.line}` : ""}`);
        lines.push(``);
        lines.push(finding.description);
        lines.push(``);

        if (finding.snippet) {
          lines.push("```");
          lines.push(finding.snippet);
          lines.push("```");
          lines.push(``);
        }

        if (finding.suggestion) {
          lines.push(`**Suggestion:** ${finding.suggestion}`);
          lines.push(``);
        }

        lines.push(`---`);
        lines.push(``);
      }
    }
  } else {
    lines.push(`## Findings`);
    lines.push(``);
    lines.push(`No issues found. Great work! ✅`);
    lines.push(``);
  }

  // Footer with session metadata
  lines.push(`---`);
  lines.push(``);
  lines.push(`**Session ID:** ${session.id}`);
  lines.push(`**Review Time:** ${session.startTime.toISOString()}${session.endTime ? ` - ${session.endTime.toISOString()}` : ""}`);
  if (session.endTime) {
    const duration = session.endTime.getTime() - session.startTime.getTime();
    const minutes = Math.floor(duration / 60000);
    const seconds = Math.floor((duration % 60000) / 1000);
    lines.push(`**Duration:** ${minutes}m ${seconds}s`);
  }
  lines.push(``);

  return lines.join("\n");
}

/**
 * Generates JSON findings file with all review data.
 *
 * JSON structure includes:
 * - Session metadata
 * - PR information
 * - Overall outcome and summary
 * - Stats breakdown
 * - Full findings array
 */
function generateJsonFindings(
  session: ReviewSession,
  outcome: ReviewOutcome,
  summary: string,
  stats: { critical: number; high: number; medium: number; low: number; info: number }
): string {
  const json = {
    sessionId: session.id,
    pr: {
      platform: session.pr.platform,
      owner: session.pr.owner,
      repo: session.pr.repo,
      number: session.pr.number,
      branch: session.pr.branch,
      baseBranch: session.pr.baseBranch,
      title: session.pr.title,
      description: session.pr.description,
      url: session.pr.url,
      ticketUrl: session.pr.ticketUrl,
    },
    outcome,
    summary,
    stats,
    findings: session.findings.map((f) => ({
      id: f.id,
      severity: f.severity,
      category: f.category,
      file: f.file,
      line: f.line,
      title: f.title,
      description: f.description,
      suggestion: f.suggestion,
      snippet: f.snippet,
    })),
    timing: {
      startTime: session.startTime.toISOString(),
      endTime: session.endTime?.toISOString(),
      durationMs: session.endTime
        ? session.endTime.getTime() - session.startTime.getTime()
        : null,
    },
  };

  return JSON.stringify(json, null, 2);
}

/**
 * Generates a single-line summary suitable for CI/CD output.
 *
 * Format: [OUTCOME] PR #123 (owner/repo): Summary (X critical, Y high, Z medium)
 */
function generateCISummary(
  outcome: ReviewOutcome,
  summary: string,
  stats: { critical: number; high: number; medium: number; low: number; info: number }
): string {
  const parts = [outcome.toUpperCase()];

  // Build counts string (only include non-zero counts)
  const counts: string[] = [];
  if (stats.critical > 0) counts.push(`${stats.critical} critical`);
  if (stats.high > 0) counts.push(`${stats.high} high`);
  if (stats.medium > 0) counts.push(`${stats.medium} medium`);

  const countsStr = counts.length > 0 ? ` (${counts.join(", ")})` : "";

  parts.push(`${summary}${countsStr}`);

  return parts.join(": ");
}

/**
 * Returns an emoji for the given outcome.
 */
function getOutcomeBadge(outcome: ReviewOutcome): string {
  switch (outcome) {
    case "pass":
      return "✅";
    case "fail":
      return "❌";
    case "warning":
      return "⚠️";
    case "error":
      return "💥";
    default:
      return "❓";
  }
}

/**
 * Returns an emoji for the given severity level.
 */
function getSeverityEmoji(severity: string): string {
  switch (severity) {
    case "critical":
      return "🔴";
    case "high":
      return "🟠";
    case "medium":
      return "🟡";
    case "low":
      return "🔵";
    case "info":
      return "ℹ️";
    default:
      return "❓";
  }
}
