/**
 * Session folder management for code reviews.
 *
 * Creates isolated session directories (.cr-sessions/cr-<timestamp>-<id>/)
 * that contain session metadata, instructions, and review artifacts.
 */

import { existsSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import type { ReviewSession, PRMetadata } from "./types";

/**
 * Generates a unique session ID using timestamp and random hash.
 *
 * Format: cr-<timestamp>-<short-hash>
 * Example: cr-1704987654321-a7f3c2
 */
function generateSessionId(): string {
  const timestamp = Date.now();
  const randomHash = Math.random().toString(36).substring(2, 8);
  return `cr-${timestamp}-${randomHash}`;
}

/**
 * Creates a new review session with an isolated directory.
 *
 * Creates the directory structure:
 * - .cr-sessions/cr-<id>/
 *   - session.json (session metadata)
 *   - instructions.md (review instructions, DoD, criteria)
 *
 * @param pr - PR metadata
 * @param worktreePath - Path to git worktree for this review
 * @param dod - Definition of Done content
 * @param criteria - Additional review criteria
 * @param basePath - Base path for session directories (default: .cr-sessions)
 * @returns ReviewSession object with session metadata
 */
export function createSession(
  pr: PRMetadata,
  worktreePath: string,
  dod: string,
  criteria: string,
  basePath: string = ".cr-sessions"
): ReviewSession {
  const sessionId = generateSessionId();
  const sessionDir = join(basePath, sessionId);

  // Create session directory (and parent if needed)
  if (!existsSync(basePath)) {
    mkdirSync(basePath, { recursive: true });
  }
  mkdirSync(sessionDir, { recursive: true });

  // Initialize session object
  const session: ReviewSession = {
    id: sessionId,
    sessionDir,
    worktreePath,
    pr,
    dod,
    criteria,
    startTime: new Date(),
    findings: [],
    agentLog: "",
  };

  // Write session metadata
  const sessionJsonPath = join(sessionDir, "session.json");
  writeFileSync(
    sessionJsonPath,
    JSON.stringify(
      {
        id: session.id,
        sessionDir: session.sessionDir,
        worktreePath: session.worktreePath,
        pr: session.pr,
        startTime: session.startTime.toISOString(),
      },
      null,
      2
    ),
    "utf-8"
  );

  return session;
}

/**
 * Writes the instructions.md file to the session directory.
 *
 * This file contains the review prompt, DoD, and criteria that will be
 * provided to the agent.
 *
 * @param session - The review session
 * @param instructionsContent - Full instructions content (generated from prompt template)
 */
export function writeInstructions(
  session: ReviewSession,
  instructionsContent: string
): void {
  const instructionsPath = join(session.sessionDir, "instructions.md");
  writeFileSync(instructionsPath, instructionsContent, "utf-8");
}

/**
 * Cleans up session directory and git worktree.
 *
 * This function:
 * - Removes the git worktree (if keepWorktree is false)
 * - Optionally removes the session directory
 *
 * @param session - The review session to clean up
 * @param keepWorktree - If true, preserve the worktree for debugging
 * @param keepSession - If true, preserve the session directory
 */
export function cleanupSession(
  session: ReviewSession,
  keepWorktree: boolean = false,
  keepSession: boolean = false
): void {
  // Remove worktree if not keeping it
  if (!keepWorktree && existsSync(session.worktreePath)) {
    try {
      // Use git worktree remove command (safer than rmSync)
      const { execSync } = require("child_process");
      execSync(`git worktree remove --force "${session.worktreePath}"`, {
        stdio: "ignore",
      });
    } catch (error) {
      // Fall back to rmSync if git command fails
      console.warn(
        `[session] Failed to remove worktree via git, using rmSync: ${error}`
      );
      rmSync(session.worktreePath, { recursive: true, force: true });
    }
  }

  // Remove session directory if not keeping it
  if (!keepSession && existsSync(session.sessionDir)) {
    rmSync(session.sessionDir, { recursive: true, force: true });
  }
}
