/**
 * Docker sandbox adapter for code review.
 *
 * Wraps a base AgentAdapter to run inside a Docker container with the
 * worktree mounted as a volume. This provides isolation from the host system.
 *
 * Usage:
 *   const baseAdapter = getAdapter('claude');
 *   const dockerAdapter = createDockerAdapter(baseAdapter, worktreePath);
 *   await ensureDockerImage();
 *   await spawnAgent({ adapter: dockerAdapter, ... });
 */

import type { AgentAdapter } from "../agents/spawn";
import { execSync } from "node:child_process";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Docker image name/tag for the code review sandbox.
 * Uses official Bun image as base since this project runs on Bun.
 */
const DOCKER_IMAGE = "oven/bun:latest";

/**
 * Container mount point for the worktree.
 */
const CONTAINER_WORKSPACE = "/workspace";

// ---------------------------------------------------------------------------
// Docker image management
// ---------------------------------------------------------------------------

/**
 * Ensures the Docker image is available locally.
 * Pulls the image if not present.
 *
 * @throws Error if Docker is not available or pull fails.
 */
export function ensureDockerImage(): void {
  try {
    // Check if Docker is available
    execSync("docker --version", { stdio: "pipe" });
  } catch (error) {
    throw new Error(
      "Docker is not available. Install Docker to use sandbox mode."
    );
  }

  try {
    // Check if image exists locally
    execSync(`docker image inspect ${DOCKER_IMAGE}`, { stdio: "pipe" });
  } catch {
    // Image not found, pull it
    console.log(`Pulling Docker image: ${DOCKER_IMAGE}...`);
    execSync(`docker pull ${DOCKER_IMAGE}`, { stdio: "inherit" });
  }
}

// ---------------------------------------------------------------------------
// Adapter factory
// ---------------------------------------------------------------------------

/**
 * Creates a Docker-wrapped adapter that runs the base adapter inside a container.
 *
 * The worktree is mounted at /workspace inside the container, and the cwd
 * is set to that path so the agent operates within the isolated environment.
 *
 * @param baseAdapter - The underlying adapter (claude, amp, etc.) to wrap.
 * @param worktreePath - Absolute path to the worktree on the host.
 * @returns A new AgentAdapter that runs the base adapter in Docker.
 */
export function createDockerAdapter(
  baseAdapter: AgentAdapter,
  worktreePath: string
): AgentAdapter {
  return {
    name: `docker-${baseAdapter.name}`,
    stdin: baseAdapter.stdin,
    buildCommand(): string[] {
      const baseCmd = baseAdapter.buildCommand();

      // Build docker run command with:
      // - Volume mount: worktree → /workspace
      // - Working directory: /workspace
      // - Auto-remove container after exit
      // - Interactive mode (for stdin if needed)
      const dockerCmd = [
        "docker",
        "run",
        "--rm", // Remove container after exit
        "-i", // Keep stdin open for interactive mode
        "-v",
        `${worktreePath}:${CONTAINER_WORKSPACE}`, // Mount worktree
        "-w",
        CONTAINER_WORKSPACE, // Set working directory
        DOCKER_IMAGE,
        ...baseCmd,
      ];

      return dockerCmd;
    },
  };
}
