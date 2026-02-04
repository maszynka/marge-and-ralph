/**
 * Playwright MCP client for browser automation and pixel comparison.
 *
 * Communicates with the Playwright MCP server to:
 * - Capture screenshots from browser
 * - Perform pixel-perfect image comparisons
 * - Execute browser automation tasks
 */

import { BaseMCPClient, type MCPServerConfig } from "./base-client.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Configuration for Playwright MCP client.
 */
export interface PlaywrightClientConfig extends MCPServerConfig {
  /** Optional browser type (chromium, firefox, webkit). Default: chromium. */
  browser?: "chromium" | "firefox" | "webkit";

  /** Optional headless mode. Default: true. */
  headless?: boolean;
}

/**
 * Screenshot options.
 */
export interface ScreenshotOptions {
  /** URL to navigate to before taking screenshot. */
  url?: string;

  /** CSS selector to screenshot (if not provided, screenshots full page). */
  selector?: string;

  /** Path to save screenshot. */
  path?: string;

  /** Image format. Default: 'png'. */
  type?: "png" | "jpeg";

  /** Image quality (0-100, JPEG only). */
  quality?: number;

  /** Full page screenshot (scrolls and stitches). Default: false. */
  fullPage?: boolean;

  /** Clip area (x, y, width, height in pixels). */
  clip?: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
}

/**
 * Screenshot result.
 */
export interface ScreenshotResult {
  /** Path to the saved screenshot. */
  path: string;

  /** Base64-encoded image data (if path not provided). */
  data?: string;

  /** Screenshot width in pixels. */
  width: number;

  /** Screenshot height in pixels. */
  height: number;
}

/**
 * Pixel comparison options.
 */
export interface PixelCompareOptions {
  /** Path to first image (baseline/design). */
  image1: string;

  /** Path to second image (implementation/actual). */
  image2: string;

  /** Path to save diff image (highlights differences). */
  diffPath?: string;

  /** Pixel difference threshold (0-1). Default: 0.01 (1%). */
  threshold?: number;

  /** Color for highlighting differences in diff image. Default: red. */
  diffColor?: { r: number; g: number; b: number };

  /** Output diff as base64 instead of file. Default: false. */
  outputBase64?: boolean;
}

/**
 * Pixel comparison result.
 */
export interface PixelCompareResult {
  /** Whether images match within threshold. */
  matches: boolean;

  /** Pixel difference percentage (0-1). */
  diffPercentage: number;

  /** Total number of differing pixels. */
  diffPixels: number;

  /** Total number of pixels compared. */
  totalPixels: number;

  /** Path to diff image (if diffPath provided). */
  diffPath?: string;

  /** Base64 diff image (if outputBase64 = true). */
  diffBase64?: string;

  /** Image dimensions. */
  dimensions: {
    width: number;
    height: number;
  };
}

// ---------------------------------------------------------------------------
// Playwright MCP Client
// ---------------------------------------------------------------------------

/**
 * Client for interacting with Playwright via MCP server.
 */
export class PlaywrightMCPClient extends BaseMCPClient {
  private browser: string;
  private headless: boolean;

  constructor(config: PlaywrightClientConfig) {
    // Pass base config to parent
    super("PlaywrightMCP", config);
    this.browser = config.browser ?? "chromium";
    this.headless = config.headless ?? true;
  }

  /**
   * Take a screenshot of a page or element.
   *
   * @param options - Screenshot options
   * @returns Screenshot result with path and dimensions
   */
  async screenshot(options: ScreenshotOptions): Promise<ScreenshotResult> {
    try {
      const params: Record<string, unknown> = {
        browser: this.browser,
        headless: this.headless,
      };

      // Add optional parameters
      if (options.url) params.url = options.url;
      if (options.selector) params.selector = options.selector;
      if (options.path) params.path = options.path;
      if (options.type) params.type = options.type;
      if (options.quality !== undefined) params.quality = options.quality;
      if (options.fullPage !== undefined) params.fullPage = options.fullPage;
      if (options.clip) params.clip = options.clip;

      const result = await this.call<ScreenshotResult>(
        "playwright_screenshot",
        params
      );

      return result;
    } catch (error) {
      throw new Error(
        `Failed to take screenshot: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Compare two images pixel-by-pixel.
   *
   * @param options - Pixel comparison options
   * @returns Comparison result with match status and diff percentage
   */
  async pixelCompare(
    options: PixelCompareOptions
  ): Promise<PixelCompareResult> {
    try {
      const params: Record<string, unknown> = {
        image1: options.image1,
        image2: options.image2,
      };

      // Add optional parameters
      if (options.diffPath) params.diffPath = options.diffPath;
      if (options.threshold !== undefined) params.threshold = options.threshold;
      if (options.diffColor) params.diffColor = options.diffColor;
      if (options.outputBase64 !== undefined)
        params.outputBase64 = options.outputBase64;

      const result = await this.call<PixelCompareResult>(
        "playwright_pixel_compare",
        params
      );

      // Determine match based on threshold
      const threshold = options.threshold ?? 0.01;
      const matches = result.diffPercentage <= threshold;

      return {
        ...result,
        matches,
      };
    } catch (error) {
      throw new Error(
        `Failed to compare images: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Navigate to a URL and wait for page to load.
   *
   * @param url - URL to navigate to
   * @param waitUntil - Wait until event. Default: 'domcontentloaded'
   */
  async navigate(
    url: string,
    waitUntil: "load" | "domcontentloaded" | "networkidle" = "domcontentloaded"
  ): Promise<void> {
    try {
      await this.call("playwright_navigate", {
        browser: this.browser,
        headless: this.headless,
        url,
        waitUntil,
      });
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
   * @returns Execution result
   */
  async execute(code: string): Promise<unknown> {
    try {
      const result = await this.call("playwright_execute", {
        browser: this.browser,
        headless: this.headless,
        code,
      });
      return result;
    } catch (error) {
      throw new Error(
        `Failed to execute code: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Get the current browser type.
   */
  getBrowser(): string {
    return this.browser;
  }

  /**
   * Set the browser type for future operations.
   */
  setBrowser(browser: "chromium" | "firefox" | "webkit"): void {
    this.browser = browser;
  }

  /**
   * Check if headless mode is enabled.
   */
  isHeadless(): boolean {
    return this.headless;
  }

  /**
   * Set headless mode for future operations.
   */
  setHeadless(headless: boolean): void {
    this.headless = headless;
  }
}
