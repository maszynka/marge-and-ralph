/**
 * Session folder management for Figma design-to-code workflows.
 *
 * Creates isolated session directories (.figma-sessions/fig-<timestamp>-<id>/)
 * that contain session metadata, design data, component plans, and comparison artifacts.
 */

import { existsSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "fs";
import { join } from "path";
import type {
  FigmaSession,
  FigmaOptions,
  FigmaDesignData,
  ComponentPlan,
  VisualComparisonResult,
  PixelComparisonResult,
} from "./types.js";

/**
 * Generates a unique session ID using timestamp and random hash.
 *
 * Format: fig-<timestamp>-<short-hash>
 * Example: fig-1704987654321-a7f3c2
 */
function generateSessionId(): string {
  const timestamp = Date.now();
  const randomHash = Math.random().toString(36).substring(2, 8);
  return `fig-${timestamp}-${randomHash}`;
}

/**
 * Creates a new Figma session with an isolated directory.
 *
 * Creates the directory structure:
 * - .figma-sessions/fig-<id>/
 *   - session.json (session metadata)
 *   - design.json (extracted design data)
 *   - components.json (component plans)
 *   - screenshots/ (visual comparison screenshots)
 *   - diffs/ (pixel comparison diff images)
 *
 * @param options - Figma workflow options
 * @param design - Extracted design data
 * @param basePath - Base path for session directories (default: .figma-sessions)
 * @returns FigmaSession object with session metadata
 */
export function initSession(
  options: FigmaOptions,
  design: FigmaDesignData,
  basePath: string = ".figma-sessions"
): FigmaSession {
  const sessionId = generateSessionId();
  const sessionDir = join(basePath, sessionId);

  // Create session directory structure
  if (!existsSync(basePath)) {
    mkdirSync(basePath, { recursive: true });
  }
  mkdirSync(sessionDir, { recursive: true });
  mkdirSync(join(sessionDir, "screenshots"), { recursive: true });
  mkdirSync(join(sessionDir, "diffs"), { recursive: true });

  // Initialize session object
  const session: FigmaSession = {
    id: sessionId,
    sessionDir,
    options,
    design,
    components: [],
    phase: "extracting",
    startTime: new Date(),
    visualResults: [],
    pixelResults: [],
    agentLog: "",
  };

  // Write session metadata
  saveSession(session);

  // Write design data to separate file
  const designPath = join(sessionDir, "design.json");
  writeFileSync(
    designPath,
    JSON.stringify(
      {
        fileKey: design.fileKey,
        nodeId: design.nodeId,
        fileName: design.fileName,
        rootNode: design.rootNode,
        allNodes: design.allNodes,
        exportUrl: design.exportUrl,
        extractedAt: design.extractedAt.toISOString(),
      },
      null,
      2
    ),
    "utf-8"
  );

  return session;
}

/**
 * Updates an existing session with new data.
 *
 * This function merges updates into the session object and persists to disk.
 * Use this to update phase, components, comparison results, etc.
 *
 * @param session - The session to update
 * @param updates - Partial session data to merge (only specified fields are updated)
 */
export function updateSession(
  session: FigmaSession,
  updates: Partial<
    Omit<FigmaSession, "id" | "sessionDir" | "startTime" | "options" | "design">
  >
): void {
  // Merge updates into session
  Object.assign(session, updates);

  // Save updated session
  saveSession(session);

  // If components were updated, save them to separate file
  if (updates.components) {
    const componentsPath = join(session.sessionDir, "components.json");
    writeFileSync(
      componentsPath,
      JSON.stringify(session.components, null, 2),
      "utf-8"
    );
  }
}

/**
 * Loads a session from disk.
 *
 * Reconstructs the full FigmaSession object from persisted files.
 *
 * @param sessionId - The session ID to load
 * @param basePath - Base path for session directories (default: .figma-sessions)
 * @returns FigmaSession object
 * @throws Error if session does not exist or is corrupted
 */
export function loadSession(
  sessionId: string,
  basePath: string = ".figma-sessions"
): FigmaSession {
  const sessionDir = join(basePath, sessionId);

  if (!existsSync(sessionDir)) {
    throw new Error(`Session ${sessionId} does not exist at ${sessionDir}`);
  }

  // Read session metadata
  const sessionPath = join(sessionDir, "session.json");
  if (!existsSync(sessionPath)) {
    throw new Error(`Session metadata file missing: ${sessionPath}`);
  }

  const sessionData = JSON.parse(readFileSync(sessionPath, "utf-8"));

  // Read design data
  const designPath = join(sessionDir, "design.json");
  const designData = existsSync(designPath)
    ? JSON.parse(readFileSync(designPath, "utf-8"))
    : null;

  if (!designData) {
    throw new Error(`Design data file missing: ${designPath}`);
  }

  // Read components (if exists)
  const componentsPath = join(sessionDir, "components.json");
  const componentsData = existsSync(componentsPath)
    ? JSON.parse(readFileSync(componentsPath, "utf-8"))
    : [];

  // Reconstruct session object
  const session: FigmaSession = {
    id: sessionData.id,
    sessionDir: sessionData.sessionDir,
    options: sessionData.options,
    design: {
      ...designData,
      extractedAt: new Date(designData.extractedAt),
    },
    components: componentsData,
    phase: sessionData.phase,
    startTime: new Date(sessionData.startTime),
    endTime: sessionData.endTime ? new Date(sessionData.endTime) : undefined,
    visualResults: sessionData.visualResults || [],
    pixelResults: sessionData.pixelResults || [],
    agentLog: sessionData.agentLog || "",
    errorMessage: sessionData.errorMessage,
  };

  return session;
}

/**
 * Saves session metadata to disk.
 *
 * Internal helper used by initSession and updateSession.
 *
 * @param session - The session to save
 */
function saveSession(session: FigmaSession): void {
  const sessionPath = join(session.sessionDir, "session.json");
  writeFileSync(
    sessionPath,
    JSON.stringify(
      {
        id: session.id,
        sessionDir: session.sessionDir,
        options: session.options,
        phase: session.phase,
        startTime: session.startTime.toISOString(),
        endTime: session.endTime?.toISOString(),
        visualResults: session.visualResults,
        pixelResults: session.pixelResults,
        agentLog: session.agentLog,
        errorMessage: session.errorMessage,
      },
      null,
      2
    ),
    "utf-8"
  );
}

/**
 * Cleans up session directory.
 *
 * This function removes the session directory and all artifacts.
 *
 * @param session - The session to clean up
 * @param keepSession - If true, preserve the session directory for debugging
 */
export function cleanupSession(
  session: FigmaSession,
  keepSession: boolean = false
): void {
  // Remove session directory if not keeping it
  if (!keepSession && existsSync(session.sessionDir)) {
    rmSync(session.sessionDir, { recursive: true, force: true });
  }
}
