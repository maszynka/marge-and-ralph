/**
 * Type definitions for Figma design-to-code workflow.
 *
 * The Figma system orchestrates a multi-phase workflow:
 *   1. Extract design data from Figma via MCP
 *   2. Decompose complex designs into component hierarchy
 *   3. Generate implementation plan with dependency graph
 *   4. Iteratively implement components (topological order)
 *   5. Visual comparison loop (design vs. implementation)
 *   6. Pixel-perfect comparison loop (final validation)
 */

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/**
 * Options for running Figma design-to-code workflow.
 */
export interface FigmaOptions {
  /** Figma file URL. */
  figmaUrl?: string;

  /** Figma file key (alternative to URL). */
  figmaFileKey?: string;

  /** Figma node selector/ID to extract (optional, extracts whole file if not provided). */
  nodeSelector?: string;

  /** Figma access token. */
  figmaAccessToken?: string;

  /** CSS selector for the component to compare against in the browser. */
  selector?: string;

  /** Local file path to export Figma design PNG (for pixel comparison). */
  path?: string;

  /** Pixel difference threshold (0-1). Default: 0.01 (1%). */
  pixelThreshold?: number;

  /** Tool adapter to use (claude, gemini, etc.). Default: from config. */
  tool?: string;

  /** Maximum iterations for agent (safety limit). Default: 50. */
  maxIterations?: number;

  /** Output directory for generated components. Default: ./src/components */
  outputDir?: string;

  /** Keep session directory after completion (for debugging). Default: false. */
  keepSession?: boolean;

  /** Framework to use for components. Default: react. */
  framework?: "react" | "vue" | "svelte" | "html";

  /** Path to Figma MCP server. Default: npx @modelcontextprotocol/server-figma */
  figmaMcpPath?: string;

  /** Path to Playwright MCP server. Default: npx @modelcontextprotocol/server-playwright */
  playwrightMcpPath?: string;

  /** Dev server URL for visual/pixel comparison. Default: http://localhost:3000 */
  devServerUrl?: string;

  /** Maximum retries for visual comparison. Default: 3. */
  visualMaxRetries?: number;

  /** Maximum retries for pixel comparison. Default: 2. */
  pixelMaxRetries?: number;

  /** Minimum children for decomposition. */
  decomposeMinChildren?: number;

  /** Maximum depth for decomposition. */
  decomposeMaxDepth?: number;
}

// ---------------------------------------------------------------------------
// Figma Design Data
// ---------------------------------------------------------------------------

/**
 * Node type from Figma API.
 */
export type FigmaNodeType =
  | "DOCUMENT"
  | "CANVAS"
  | "FRAME"
  | "GROUP"
  | "VECTOR"
  | "BOOLEAN_OPERATION"
  | "STAR"
  | "LINE"
  | "ELLIPSE"
  | "REGULAR_POLYGON"
  | "RECTANGLE"
  | "TEXT"
  | "SLICE"
  | "COMPONENT"
  | "COMPONENT_SET"
  | "INSTANCE";

/**
 * Figma node (simplified, focused on properties needed for implementation).
 */
export interface FigmaNode {
  /** Node ID (unique within file). */
  id: string;

  /** Node name (designer-set). */
  name: string;

  /** Node type. */
  type: FigmaNodeType;

  /** Child nodes (for frames, groups, etc.). */
  children?: FigmaNode[];

  /** Layout properties (if applicable). */
  layout?: {
    mode: "NONE" | "HORIZONTAL" | "VERTICAL";
    spacing?: number;
    padding?: {
      top: number;
      right: number;
      bottom: number;
      left: number;
    };
  };

  /** Style properties. */
  styles?: {
    fills?: unknown[];
    strokes?: unknown[];
    effects?: unknown[];
    fontFamily?: string;
    fontSize?: number;
    fontWeight?: number;
    textAlign?: string;
    opacity?: number;
  };

  /** Constraints (for responsive behavior). */
  constraints?: {
    horizontal: "LEFT" | "RIGHT" | "CENTER" | "SCALE" | "STRETCH";
    vertical: "TOP" | "BOTTOM" | "CENTER" | "SCALE" | "STRETCH";
  };

  /** Bounding box. */
  bounds?: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
}

/**
 * Design data extracted from Figma.
 */
export interface FigmaDesignData {
  /** Figma file key. */
  fileKey: string;

  /** Node ID being implemented. */
  nodeId: string;

  /** File name. */
  fileName: string;

  /** Root node of the extracted design. */
  rootNode: FigmaNode;

  /** Flattened list of all nodes (for easier searching). */
  allNodes: FigmaNode[];

  /** URL to exported PNG of the design (for visual/pixel comparison). */
  exportUrl?: string;

  /** Extraction timestamp. */
  extractedAt: Date;
}

// ---------------------------------------------------------------------------
// Component Planning
// ---------------------------------------------------------------------------

/**
 * A planned component to be implemented.
 */
export interface ComponentPlan {
  /** Unique ID (generated from Figma node or custom). */
  id: string;

  /** Component name (matches Figma node name, cleaned for code). */
  name: string;

  /** Display name (original Figma name). */
  displayName: string;

  /** Associated Figma node ID. */
  figmaNodeId: string;

  /** File path where component will be created. */
  filePath: string;

  /** Component type (react, vue, etc.). Inferred from project. */
  type: "react" | "vue" | "svelte" | "html";

  /** IDs of components this depends on (for topological sort). */
  dependencies: string[];

  /** Implementation priority (lower = higher priority). */
  priority: number;

  /** Whether component is atomic (leaf) or composite. */
  isAtomic: boolean;

  /** Design properties (colors, typography, spacing, etc.). */
  designProps: {
    width?: string;
    height?: string;
    backgroundColor?: string;
    color?: string;
    fontSize?: string;
    fontFamily?: string;
    padding?: string;
    margin?: string;
    borderRadius?: string;
    [key: string]: unknown;
  };

  /** Original Figma node data. */
  node?: FigmaNode;

  /** Acceptance criteria (visual match, accessibility, etc.). */
  acceptanceCriteria: string[];

  /** Implementation status. */
  status: "pending" | "in_progress" | "visual_review" | "pixel_review" | "complete";

  /** Iteration count (tracks how many times we've attempted implementation). */
  iterations: number;

  /** Whether component has been implemented. */
  implemented?: boolean;
}

// ---------------------------------------------------------------------------
// Visual Comparison
// ---------------------------------------------------------------------------

/**
 * Result of visual comparison between Figma design and implementation.
 */
export interface VisualComparisonResult {
  /** Component being compared. */
  componentId: string;

  /** Whether visual match is acceptable. */
  matches: boolean;

  /** Confidence score (0-1). */
  confidence: number;

  /** Screenshot URL of current implementation. */
  screenshotUrl: string;

  /** Accessibility tree (for semantic validation). */
  a11yTree?: string;

  /** List of visual discrepancies found. */
  discrepancies: VisualDiscrepancy[];

  /** Comparison timestamp. */
  comparedAt: Date;
}

/**
 * A single visual discrepancy.
 */
export interface VisualDiscrepancy {
  /** Category of discrepancy. */
  type: "color" | "spacing" | "typography" | "layout" | "alignment" | "other";

  /** Severity level. */
  severity: "critical" | "high" | "medium" | "low";

  /** Description of the issue. */
  description: string;

  /** Suggested fix. */
  suggestion?: string;
}

// ---------------------------------------------------------------------------
// Pixel Comparison
// ---------------------------------------------------------------------------

/**
 * Result of pixel-perfect comparison.
 */
export interface PixelComparisonResult {
  /** Component being compared. */
  componentId: string;

  /** Whether pixel match is within threshold. */
  matches: boolean;

  /** Pixel difference percentage (0-1). */
  diffPercentage: number;

  /** Threshold used for comparison. */
  threshold: number;

  /** URL to diff image (highlights differences). */
  diffImageUrl?: string;

  /** Screenshot URL of implementation. */
  implementationUrl: string;

  /** Figma design image URL. */
  designUrl: string;

  /** Comparison timestamp. */
  comparedAt: Date;
}

// ---------------------------------------------------------------------------
// Session Management
// ---------------------------------------------------------------------------

/**
 * A Figma implementation session.
 */
export interface FigmaSession {
  /** Unique session ID (timestamp + short hash). */
  id: string;

  /** Path to session directory (.figma-sessions/fig-<id>/). */
  sessionDir: string;

  /** Figma options. */
  options: FigmaOptions;

  /** Extracted design data. */
  design: FigmaDesignData;

  /** Component implementation plan. */
  components: ComponentPlan[];

  /** Current phase of workflow. */
  phase:
    | "extracting"
    | "planning"
    | "implementing"
    | "visual_comparison"
    | "pixel_comparison"
    | "complete"
    | "error";

  /** Start timestamp. */
  startTime: Date;

  /** End timestamp (set when session completes). */
  endTime?: Date;

  /** Visual comparison results (one per component, may have multiple iterations). */
  visualResults: VisualComparisonResult[];

  /** Pixel comparison results. */
  pixelResults: PixelComparisonResult[];

  /** Agent stdout log. */
  agentLog: string;

  /** Error message (if phase is 'error'). */
  errorMessage?: string;
}
