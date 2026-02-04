/**
 * Playwriter client for browser automation and screenshot capture.
 *
 * Wraps the Playwriter CLI to provide:
 * - Screenshot capture from browser
 * - Accessibility tree extraction
 * - Page navigation
 *
 * Unlike other MCP clients, Playwriter uses CLI commands rather than
 * a persistent MCP server connection.
 */

import { spawn } from "child_process";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Configuration for Playwriter client.
 */
export interface PlaywriterClientConfig {
  /** Session ID for Playwriter (isolates state). */
  sessionId?: string;

  /** Timeout for commands (ms). Default: 30000. */
  timeout?: number;

  /** Command to run playwriter (e.g., "playwriter", "npx playwriter", "bunx playwriter"). */
  command?: string;
}

/**
 * Screenshot options.
 */
export interface ScreenshotOptions {
  /** Path to save screenshot. */
  path: string;

  /** Whether to use CSS scale (prevents 2-4x larger images on high-DPI displays). Default: true. */
  cssScale?: boolean;

  /** Maximum dimension size in pixels (will resize if larger). Default: 1500. */
  maxSize?: number;
}

/**
 * Navigation options.
 */
export interface NavigationOptions {
  /** URL to navigate to. */
  url: string;

  /** Wait until event. Default: 'domcontentloaded'. */
  waitUntil?: "load" | "domcontentloaded" | "networkidle";
}

/**
 * Accessibility tree options.
 */
export interface A11yTreeOptions {
  /** Search pattern to filter results (string or regex pattern). */
  search?: string;

  /** Maximum number of lines to return. Default: unlimited. */
  limit?: number;

  /** Line offset for pagination. Default: 0. */
  offset?: number;
}

// ---------------------------------------------------------------------------
// Playwriter Client
// ---------------------------------------------------------------------------

/**
 * Client for interacting with the browser via Playwriter CLI.
 */
export class PlaywriterClient {
  private sessionId: string;
  private timeout: number;
  private command: string;

  constructor(config?: PlaywriterClientConfig) {
    this.sessionId = config?.sessionId ?? "1";
    this.timeout = config?.timeout ?? 30000;
    this.command = config?.command ?? "playwriter";
  }

  /**
   * Initialize a new Playwriter session.
   * Call this before using the client if you want a fresh session.
   */
  async initSession(): Promise<string> {
    try {
      const output = await this.executeCommand("session new");
      const sessionId = output.trim();
      this.sessionId = sessionId;
      return sessionId;
    } catch (error) {
      throw new Error(
        `Failed to initialize Playwriter session: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Reset the current session (clears state, reconnects to browser).
   */
  async resetSession(): Promise<void> {
    try {
      await this.executeCommand(`session reset ${this.sessionId}`);
    } catch (error) {
      throw new Error(
        `Failed to reset Playwriter session: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Take a screenshot of the current page.
   *
   * @param options - Screenshot options
   * @returns Path to the saved screenshot
   */
  async screenshot(options: ScreenshotOptions): Promise<string> {
    try {
      const cssScaleArg = options.cssScale !== false ? ", scale: 'css'" : "";
      const code = `await page.screenshot({ path: '${options.path}'${cssScaleArg} })`;

      await this.execute(code);

      // If maxSize is specified, resize the image
      if (options.maxSize && options.maxSize > 0) {
        await this.resizeImage(options.path, options.maxSize);
      }

      return options.path;
    } catch (error) {
      throw new Error(
        `Failed to take screenshot: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Get accessibility tree of the current page.
   *
   * @param options - Accessibility tree options
   * @returns Accessibility tree as text
   */
  async getA11yTree(options?: A11yTreeOptions): Promise<string> {
    try {
      let code: string;

      if (options?.search) {
        // Use search parameter if provided
        const searchPattern =
          typeof options.search === "string"
            ? `'${options.search}'`
            : `/${options.search}/i`;
        code = `console.log(await accessibilitySnapshot({ page, search: ${searchPattern} }))`;
      } else {
        // Get full tree
        code = `console.log(await accessibilitySnapshot({ page }))`;
      }

      const output = await this.execute(code);

      // Apply pagination if specified
      if (options?.limit !== undefined || options?.offset !== undefined) {
        const lines = output.split("\n");
        const offset = options.offset ?? 0;
        const limit = options.limit ?? lines.length;
        return lines.slice(offset, offset + limit).join("\n");
      }

      return output;
    } catch (error) {
      throw new Error(
        `Failed to get accessibility tree: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Navigate to a URL.
   *
   * @param options - Navigation options
   */
  async navigate(options: NavigationOptions): Promise<void> {
    try {
      const waitUntil = options.waitUntil ?? "domcontentloaded";
      const code = `await page.goto('${options.url}', { waitUntil: '${waitUntil}' }); await waitForPageLoad({ page, timeout: 5000 })`;

      await this.execute(code);
    } catch (error) {
      throw new Error(
        `Failed to navigate: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Execute arbitrary JavaScript code in the browser context.
   *
   * @param code - JavaScript code to execute
   * @returns Command output (stdout)
   */
  async execute(code: string): Promise<string> {
    try {
      const args = ["-s", this.sessionId, "-e", code];
      return await this.executeCommand(args.join(" "));
    } catch (error) {
      throw new Error(
        `Failed to execute code: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Get the current session ID.
   */
  getSessionId(): string {
    return this.sessionId;
  }

  /**
   * Set the session ID (useful for switching between sessions).
   */
  setSessionId(sessionId: string): void {
    this.sessionId = sessionId;
  }

  // ---------------------------------------------------------------------------
  // Private Methods
  // ---------------------------------------------------------------------------

  /**
   * Execute a Playwriter command.
   */
  private async executeCommand(args: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const parts = this.command.split(" ");
      const cmd = parts[0];
      const cmdArgs = [...parts.slice(1), ...args.split(" ")];

      const proc = spawn(cmd, cmdArgs, {
        stdio: ["ignore", "pipe", "pipe"],
      });

      let stdout = "";
      let stderr = "";

      proc.stdout?.on("data", (chunk: Buffer) => {
        stdout += chunk.toString();
      });

      proc.stderr?.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });

      // Set timeout
      const timer = setTimeout(() => {
        proc.kill("SIGTERM");
        reject(new Error(`Playwriter command timeout after ${this.timeout}ms`));
      }, this.timeout);

      proc.on("exit", (code) => {
        clearTimeout(timer);

        if (code === 0) {
          resolve(stdout);
        } else {
          reject(
            new Error(
              `Playwriter command failed with code ${code}: ${stderr || stdout}`
            )
          );
        }
      });

      proc.on("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });
  }

  /**
   * Resize an image to fit within maxSize (using sips on macOS, ImageMagick elsewhere).
   */
  private async resizeImage(path: string, maxSize: number): Promise<void> {
    return new Promise((resolve, reject) => {
      // Try sips first (macOS)
      const proc = spawn("sips", [
        "--resampleHeightWidthMax",
        String(maxSize),
        path,
        "--out",
        path,
      ]);

      proc.on("exit", (code) => {
        if (code === 0) {
          resolve();
        } else {
          // Fallback: try ImageMagick convert
          const convert = spawn("convert", [
            path,
            "-resize",
            `${maxSize}x${maxSize}>`,
            path,
          ]);

          convert.on("exit", (convertCode) => {
            if (convertCode === 0) {
              resolve();
            } else {
              // If both fail, just continue without resizing
              console.warn(
                `Failed to resize image (tried sips and convert). Continuing without resize.`
              );
              resolve();
            }
          });

          convert.on("error", () => {
            console.warn(
              `Failed to resize image (tried sips and convert). Continuing without resize.`
            );
            resolve();
          });
        }
      });

      proc.on("error", () => {
        // Try convert as fallback
        const convert = spawn("convert", [
          path,
          "-resize",
          `${maxSize}x${maxSize}>`,
          path,
        ]);

        convert.on("exit", (convertCode) => {
          if (convertCode === 0) {
            resolve();
          } else {
            console.warn(
              `Failed to resize image (tried sips and convert). Continuing without resize.`
            );
            resolve();
          }
        });

        convert.on("error", () => {
          console.warn(
            `Failed to resize image (tried sips and convert). Continuing without resize.`
          );
          resolve();
        });
      });
    });
  }
}
