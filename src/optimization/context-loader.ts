/**
 * Context loader — finds and loads project context files.
 *
 * Looks for:
 * - agent.md, AGENT.md
 * - CLAUDE.md, claude.md, Claude.md
 * - README.md (truncated)
 * - package.json, Cargo.toml, pyproject.toml (for project type detection)
 */

import { existsSync, readFileSync, readdirSync } from "fs";
import { join } from "path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ProjectContext {
  agentMd?: string;
  claudeMd?: string;
  readme?: string;
  projectType?: "node" | "python" | "rust" | "go" | "unknown";
  projectConfig?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// File detection helpers
// ---------------------------------------------------------------------------

function findFileIgnoreCase(dir: string, names: string[]): string | null {
  try {
    const files = readdirSync(dir);
    for (const name of names) {
      const found = files.find((f) => f.toLowerCase() === name.toLowerCase());
      if (found) {
        return join(dir, found);
      }
    }
  } catch {
    // Directory not readable
  }
  return null;
}

function readFileSafe(path: string, maxLines?: number): string | undefined {
  try {
    const content = readFileSync(path, "utf-8");
    if (maxLines) {
      const lines = content.split("\n");
      if (lines.length > maxLines) {
        return lines.slice(0, maxLines).join("\n") + "\n\n... (truncated)";
      }
    }
    return content;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Project type detection
// ---------------------------------------------------------------------------

function detectProjectType(dir: string): ProjectContext["projectType"] {
  if (existsSync(join(dir, "package.json"))) return "node";
  if (existsSync(join(dir, "Cargo.toml"))) return "rust";
  if (existsSync(join(dir, "pyproject.toml"))) return "python";
  if (existsSync(join(dir, "setup.py"))) return "python";
  if (existsSync(join(dir, "requirements.txt"))) return "python";
  if (existsSync(join(dir, "go.mod"))) return "go";
  return "unknown";
}

function loadProjectConfig(dir: string, type: ProjectContext["projectType"]): Record<string, unknown> | undefined {
  try {
    switch (type) {
      case "node": {
        const pkgPath = join(dir, "package.json");
        if (existsSync(pkgPath)) {
          const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
          return {
            name: pkg.name,
            description: pkg.description,
            scripts: pkg.scripts ? Object.keys(pkg.scripts) : [],
            dependencies: pkg.dependencies ? Object.keys(pkg.dependencies).length : 0,
            devDependencies: pkg.devDependencies ? Object.keys(pkg.devDependencies).length : 0,
          };
        }
        break;
      }
      case "rust": {
        const cargoPath = join(dir, "Cargo.toml");
        if (existsSync(cargoPath)) {
          const content = readFileSync(cargoPath, "utf-8");
          const nameMatch = content.match(/name\s*=\s*"([^"]+)"/);
          return { name: nameMatch?.[1] || "unknown" };
        }
        break;
      }
      case "python": {
        const pyprojectPath = join(dir, "pyproject.toml");
        if (existsSync(pyprojectPath)) {
          const content = readFileSync(pyprojectPath, "utf-8");
          const nameMatch = content.match(/name\s*=\s*"([^"]+)"/);
          return { name: nameMatch?.[1] || "unknown" };
        }
        break;
      }
    }
  } catch {
    // Failed to parse config
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Main loader
// ---------------------------------------------------------------------------

export async function loadProjectContext(targetDir: string): Promise<ProjectContext> {
  const context: ProjectContext = {};

  // Find agent.md
  const agentPath = findFileIgnoreCase(targetDir, ["agent.md", "AGENT.md"]);
  if (agentPath) {
    context.agentMd = readFileSafe(agentPath);
    console.log(`[context] Found: ${agentPath}`);
  }

  // Find CLAUDE.md
  const claudePath = findFileIgnoreCase(targetDir, ["CLAUDE.md", "claude.md", "Claude.md"]);
  if (claudePath) {
    context.claudeMd = readFileSafe(claudePath);
    console.log(`[context] Found: ${claudePath}`);
  }

  // Find README.md (truncated to 100 lines)
  const readmePath = findFileIgnoreCase(targetDir, ["README.md", "readme.md", "Readme.md"]);
  if (readmePath) {
    context.readme = readFileSafe(readmePath, 100);
    console.log(`[context] Found: ${readmePath}`);
  }

  // Detect project type
  context.projectType = detectProjectType(targetDir);
  console.log(`[context] Project type: ${context.projectType}`);

  // Load project config
  context.projectConfig = loadProjectConfig(targetDir, context.projectType);

  return context;
}

// ---------------------------------------------------------------------------
// Format context for prompt injection
// ---------------------------------------------------------------------------

export function formatContextForPrompt(context: ProjectContext): string {
  const sections: string[] = [];

  if (context.projectType && context.projectType !== "unknown") {
    sections.push(`## Project Type\n${context.projectType}`);
  }

  if (context.projectConfig) {
    sections.push(`## Project Config\n\`\`\`json\n${JSON.stringify(context.projectConfig, null, 2)}\n\`\`\``);
  }

  if (context.claudeMd) {
    sections.push(`## Project Instructions (CLAUDE.md)\n${context.claudeMd}`);
  }

  if (context.agentMd) {
    sections.push(`## Agent Instructions (agent.md)\n${context.agentMd}`);
  }

  if (context.readme) {
    sections.push(`## README (excerpt)\n${context.readme}`);
  }

  if (sections.length === 0) {
    return "No project context files found.";
  }

  return sections.join("\n\n---\n\n");
}
