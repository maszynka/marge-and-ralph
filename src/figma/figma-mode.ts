/**
 * Figma design-to-code orchestrator.
 *
 * Runs the 5-phase workflow:
 *   1. Extract design from Figma
 *   2. Decompose into component hierarchy
 *   3. Implement components (per-component loop)
 *   4. Visual comparison loop (human-perceptible differences)
 *   5. Pixel comparison loop (pixel-perfect validation)
 *
 * Emits signals at each phase for progress tracking.
 */

import { existsSync, readFileSync } from "fs";
import { join } from "path";
import type { FigmaOptions, FigmaSession, ComponentPlan } from "./types.js";
import { FigmaMCPClient } from "./mcp/figma-client.js";
import { PlaywriterClient } from "./mcp/playwriter-client.js";
import { PlaywrightMCPClient } from "./mcp/playwright-client.js";
import { decompose, topologicalSort } from "./decomposer.js";
import { initSession, updateSession, loadSession } from "./session.js";
import { spawnAgent } from "../agents/spawn.js";
import { getAdapter } from "../agents/adapters/index.js";
import type { Signal } from "../agents/signals.js";

// ---------------------------------------------------------------------------
// Main orchestrator
// ---------------------------------------------------------------------------

/**
 * Runs the complete Figma design-to-code workflow.
 *
 * This is the main entry point that coordinates all phases:
 * 1. Extract design from Figma via MCP
 * 2. Decompose into component hierarchy with dependencies
 * 3. Implement each component in topological order
 * 4. Visual comparison loop (iterative refinement)
 * 5. Pixel-perfect comparison loop (final validation)
 *
 * @param options - Figma workflow configuration
 */
export async function runFigmaMode(options: FigmaOptions): Promise<void> {
  console.log("[figma-mode] Starting Figma design-to-code workflow");
  console.log(`[figma-mode] Tool: ${options.tool || "claude"}`);

  // Validate required options
  if (!options.figmaUrl && !options.figmaFileKey) {
    throw new Error("Either figmaUrl or figmaFileKey must be provided");
  }

  const tool = options.tool || "claude";
  const adapter = getAdapter(tool);

  // Phase 1: Extract design from Figma
  const design = await phaseExtract(options);

  // Initialize session
  const session = initSession(options, design);
  console.log(`[figma-mode] Session ID: ${session.id}`);

  try {
    // Phase 2: Decompose into component hierarchy
    await phasePlan(session, options);

    // Phase 3: Implement components
    await phaseImplement(session, options, adapter);

    // Phase 4: Visual comparison loop
    await phaseVisualCompare(session, options, adapter);

    // Phase 5: Pixel comparison loop
    await phasePixelCompare(session, options, adapter);

    // Complete
    updateSession(session, { phase: "complete" });
    console.log("[figma-mode] ✓ Workflow complete!");
    emitSignal("FIGMA_COMPLETE", { sessionId: session.id });
  } catch (error) {
    console.error("[figma-mode] Error:", error);
    updateSession(session, {
      phase: "error",
      errorMessage: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Phase 1: Extract design from Figma
// ---------------------------------------------------------------------------

async function phaseExtract(opts: FigmaOptions) {
  console.log("[figma-mode] Phase 1: Extracting design from Figma...");

  const figmaClient = new FigmaMCPClient({
    command: opts.figmaMcpPath || "npx",
    args: opts.figmaMcpPath ? [] : ["--yes", "@modelcontextprotocol/server-figma"],
    env: {
      FIGMA_ACCESS_TOKEN: opts.figmaAccessToken || process.env.FIGMA_ACCESS_TOKEN || "",
    },
    accessToken: opts.figmaAccessToken || process.env.FIGMA_ACCESS_TOKEN || "",
  });

  try {
    await figmaClient.connect();

    const fileKey = opts.figmaFileKey || extractFileKey(opts.figmaUrl!);
    const nodeId = opts.nodeSelector;

    console.log(`[figma-mode] File: ${fileKey}`);
    if (nodeId) console.log(`[figma-mode] Node: ${nodeId}`);

    const design = await figmaClient.extractDesign(fileKey, nodeId);

    console.log(`[figma-mode] ✓ Extracted: ${design.fileName}`);
    emitSignal("FIGMA_EXTRACTED", { fileKey, nodeCount: String(design.allNodes.length) });

    return design;
  } finally {
    await figmaClient.disconnect();
  }
}

// ---------------------------------------------------------------------------
// Phase 2: Decompose into component hierarchy
// ---------------------------------------------------------------------------

async function phasePlan(session: FigmaSession, opts: FigmaOptions): Promise<void> {
  console.log("[figma-mode] Phase 2: Planning component hierarchy...");

  updateSession(session, { phase: "planning" });

  const components = decompose(session.design, {
    framework: opts.framework || "react",
    outputDir: opts.outputDir || "./src/components",
    criteria: {
      minChildren: opts.decomposeMinChildren,
      maxDepth: opts.decomposeMaxDepth,
    },
  });

  const sortedComponents = topologicalSort(components);
  updateSession(session, { components: sortedComponents });

  console.log(`[figma-mode] ✓ Planned ${sortedComponents.length} components`);
  emitSignal("COMPONENTS_PLANNED", { count: String(sortedComponents.length) });
}

// ---------------------------------------------------------------------------
// Phase 3: Implement components
// ---------------------------------------------------------------------------

async function phaseImplement(session: FigmaSession, opts: FigmaOptions, adapter: any): Promise<void> {
  console.log("[figma-mode] Phase 3: Implementing components...");

  updateSession(session, { phase: "implementing" });

  const updatedSession = loadSession(session.id);
  if (!updatedSession.components || updatedSession.components.length === 0) {
    throw new Error("No components to implement");
  }

  const promptPath = join(process.cwd(), "src/prompts/figma-implement.md");
  if (!existsSync(promptPath)) {
    throw new Error(`Implementation prompt not found: ${promptPath}`);
  }

  const promptTemplate = readFileSync(promptPath, "utf-8");

  for (let i = 0; i < updatedSession.components.length; i++) {
    const component = updatedSession.components[i];
    console.log(`[figma-mode] [${i + 1}/${updatedSession.components.length}] Implementing: ${component.name}`);

    const prompt = buildImplementPrompt(promptTemplate, component, opts);

    const result = await spawnAgent({
      adapter,
      prompt,
      cwd: process.cwd(),
      onOutput: (line) => {
        if (line.includes("✓") || line.includes("SIGNAL:")) {
          console.log(`  ${line}`);
        }
      },
      onSignal: (signal: Signal) => {
        if (signal.type === "FIGMA_COMPONENT_COMPLETE") {
          console.log(`  ✓ Component complete: ${component.name}`);
        }
      },
    });

    const complete = result.signals.some((s) => s.type === "FIGMA_COMPONENT_COMPLETE");
    if (!complete) {
      throw new Error(`Component implementation failed: ${component.name}`);
    }

    component.implemented = true;
    updateSession(updatedSession, { components: updatedSession.components });
    emitSignal("FIGMA_COMPONENT_COMPLETE", { name: component.name, path: component.filePath });
  }

  console.log(`[figma-mode] ✓ All ${updatedSession.components.length} components implemented`);
}

// ---------------------------------------------------------------------------
// Phase 4: Visual comparison loop
// ---------------------------------------------------------------------------

async function phaseVisualCompare(session: FigmaSession, opts: FigmaOptions, adapter: any): Promise<void> {
  console.log("[figma-mode] Phase 4: Visual comparison...");

  updateSession(session, { phase: "visual_comparison" });

  const maxRetries = opts.visualMaxRetries || 3;
  const promptPath = join(process.cwd(), "src/prompts/figma-visual-compare.md");

  if (!existsSync(promptPath)) {
    throw new Error(`Visual compare prompt not found: ${promptPath}`);
  }

  const promptTemplate = readFileSync(promptPath, "utf-8");
  const playwriter = new PlaywriterClient();

  try {
    const updatedSession = loadSession(session.id);

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      console.log(`[figma-mode] Visual comparison attempt ${attempt}/${maxRetries}`);

      const url = opts.devServerUrl || "http://localhost:3000";
      await playwriter.navigate({ url });

      const screenshotPath = join(updatedSession.sessionDir, "screenshots", `impl-attempt-${attempt}.png`);
      await playwriter.screenshot({ path: screenshotPath, cssScale: true, maxSize: 1920 });

      const prompt = buildVisualComparePrompt(promptTemplate, updatedSession, screenshotPath, opts);

      const result = await spawnAgent({
        adapter,
        prompt,
        cwd: process.cwd(),
        onOutput: (line) => {
          if (line.includes("SIGNAL:") || line.includes("✓")) {
            console.log(`  ${line}`);
          }
        },
      });

      const match = result.signals.some((s) => s.type === "VISUAL_MATCH");
      const mismatch = result.signals.some((s) => s.type === "VISUAL_MISMATCH");

      if (match) {
        console.log("[figma-mode] ✓ Visual comparison passed!");
        emitSignal("VISUAL_MATCH", { attempt: String(attempt) });
        return;
      }

      if (mismatch && attempt < maxRetries) {
        console.log(`[figma-mode] ✗ Visual mismatch detected, retrying...`);
        emitSignal("VISUAL_MISMATCH", { attempt: String(attempt) });
      } else if (mismatch) {
        throw new Error("Visual comparison failed after max retries");
      }
    }
  } finally {
    // Playwriter cleanup is automatic
  }
}

// ---------------------------------------------------------------------------
// Phase 5: Pixel comparison loop
// ---------------------------------------------------------------------------

async function phasePixelCompare(session: FigmaSession, opts: FigmaOptions, adapter: any): Promise<void> {
  console.log("[figma-mode] Phase 5: Pixel comparison...");

  updateSession(session, { phase: "pixel_comparison" });

  const maxRetries = opts.pixelMaxRetries || 2;
  const threshold = opts.pixelThreshold || 0.01;
  const promptPath = join(process.cwd(), "src/prompts/figma-pixel-compare.md");

  if (!existsSync(promptPath)) {
    throw new Error(`Pixel compare prompt not found: ${promptPath}`);
  }

  const promptTemplate = readFileSync(promptPath, "utf-8");

  const playwright = new PlaywrightMCPClient({
    command: opts.playwrightMcpPath || "npx",
    args: opts.playwrightMcpPath ? [] : ["--yes", "@modelcontextprotocol/server-playwright"],
    browser: "chromium",
    headless: true,
  });

  const figmaClient = new FigmaMCPClient({
    command: opts.figmaMcpPath || "npx",
    args: opts.figmaMcpPath ? [] : ["--yes", "@modelcontextprotocol/server-figma"],
    env: {
      FIGMA_ACCESS_TOKEN: opts.figmaAccessToken || process.env.FIGMA_ACCESS_TOKEN || "",
    },
    accessToken: opts.figmaAccessToken || process.env.FIGMA_ACCESS_TOKEN || "",
  });

  try {
    await playwright.connect();
    await figmaClient.connect();

    const updatedSession = loadSession(session.id);
    const fileKey = opts.figmaFileKey || extractFileKey(opts.figmaUrl!);

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      console.log(`[figma-mode] Pixel comparison attempt ${attempt}/${maxRetries}`);

      const url = opts.devServerUrl || "http://localhost:3000";
      await playwright.navigate(url);

      const implScreenshotPath = join(
        updatedSession.sessionDir,
        "screenshots",
        `impl-pixel-${attempt}.png`
      );
      await playwright.screenshot({ path: implScreenshotPath, fullPage: false });

      const referenceScreenshotPath = join(
        updatedSession.sessionDir,
        "screenshots",
        "figma-reference.png"
      );

      if (!existsSync(referenceScreenshotPath) && opts.nodeSelector) {
        const imageUrl = await figmaClient.exportNode({
          fileKey,
          nodeId: opts.nodeSelector,
          format: "png",
          scale: 2,
        });
        console.log(`[figma-mode] Reference image URL: ${imageUrl}`);
      }

      const diffPath = join(updatedSession.sessionDir, "diffs", `diff-${attempt}.png`);
      const result = await playwright.pixelCompare({
        image1: referenceScreenshotPath,
        image2: implScreenshotPath,
        diffPath,
        threshold,
      });

      console.log(`[figma-mode] Diff: ${(result.diffPercentage * 100).toFixed(4)}%`);

      if (result.matches) {
        console.log("[figma-mode] ✓ Pixel comparison passed!");
        emitSignal("PIXEL_MATCH", { attempt: String(attempt), diffPercentage: (result.diffPercentage * 100).toFixed(4) });
        return;
      }

      console.log(`[figma-mode] ✗ Pixel mismatch detected`);
      emitSignal("PIXEL_MISMATCH", { attempt: String(attempt), diffPercentage: (result.diffPercentage * 100).toFixed(4) });

      if (attempt < maxRetries) {
        const prompt = buildPixelComparePrompt(promptTemplate, updatedSession, result, diffPath, opts);
        await spawnAgent({
          adapter,
          prompt,
          cwd: process.cwd(),
          onOutput: (line) => {
            if (line.includes("✓")) console.log(`  ${line}`);
          },
        });
      } else {
        throw new Error("Pixel comparison failed after max retries");
      }
    }
  } finally {
    await playwright.disconnect();
    await figmaClient.disconnect();
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function extractFileKey(figmaUrl: string): string {
  const match = figmaUrl.match(/file\/([a-zA-Z0-9]+)/);
  if (!match) throw new Error(`Invalid Figma URL: ${figmaUrl}`);
  return match[1];
}

function buildImplementPrompt(template: string, component: ComponentPlan, opts: FigmaOptions): string {
  let prompt = template;
  prompt = prompt.replace(/\{\{COMPONENT_NAME\}\}/g, component.name);
  prompt = prompt.replace(/\{\{COMPONENT_PATH\}\}/g, component.filePath);
  prompt = prompt.replace(/\{\{FRAMEWORK\}\}/g, opts.framework || "react");
  prompt = prompt.replace(/\{\{DESIGN_PROPS\}\}/g, JSON.stringify(component.designProps, null, 2));
  prompt = prompt.replace(/\{\{FIGMA_NODE\}\}/g, JSON.stringify(component.node, null, 2));
  prompt = prompt.replace(/\{\{DEPENDENCIES\}\}/g, component.dependencies.length > 0 ? component.dependencies.join(", ") : "None");
  return prompt;
}

function buildVisualComparePrompt(template: string, session: FigmaSession, screenshotPath: string, opts: FigmaOptions): string {
  let prompt = template;
  prompt = prompt.replace(/\{\{SCREENSHOT_PATH\}\}/g, screenshotPath);
  prompt = prompt.replace(/\{\{FIGMA_URL\}\}/g, opts.figmaUrl || "");
  prompt = prompt.replace(/\{\{OUTPUT_DIR\}\}/g, opts.outputDir || "./src/components");
  prompt = prompt.replace(/\{\{FRAMEWORK\}\}/g, opts.framework || "react");
  return prompt;
}

function buildPixelComparePrompt(template: string, session: FigmaSession, result: { diffPercentage: number; diffPixels: number; totalPixels: number }, diffPath: string, opts: FigmaOptions): string {
  let prompt = template;
  prompt = prompt.replace(/\{\{DIFF_PATH\}\}/g, diffPath);
  prompt = prompt.replace(/\{\{DIFF_PERCENTAGE\}\}/g, (result.diffPercentage * 100).toFixed(4));
  prompt = prompt.replace(/\{\{DIFF_PIXELS\}\}/g, String(result.diffPixels));
  prompt = prompt.replace(/\{\{TOTAL_PIXELS\}\}/g, String(result.totalPixels));
  prompt = prompt.replace(/\{\{OUTPUT_DIR\}\}/g, opts.outputDir || "./src/components");
  prompt = prompt.replace(/\{\{FRAMEWORK\}\}/g, opts.framework || "react");
  return prompt;
}

function emitSignal(type: string, attrs: Record<string, string> = {}): void {
  const attrStr = Object.entries(attrs)
    .map(([k, v]) => `${k}="${v}"`)
    .join(" ");
  console.log(`<!-- SIGNAL:${type} ${attrStr} -->`);
}
