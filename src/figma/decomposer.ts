/**
 * Component decomposer for Figma design-to-code workflow.
 *
 * Decomposes Figma designs into a component hierarchy with dependency tracking
 * and topological sorting for correct build order.
 */

import type { FigmaNode, FigmaDesignData, ComponentPlan } from "./types.js";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/**
 * Criteria for determining whether a Figma node should be a separate component.
 */
interface DecompositionCriteria {
  /** Minimum number of children to consider decomposition. */
  minChildren: number;

  /** Node types that should always be components. */
  componentTypes: Set<string>;

  /** Node name patterns that indicate components (e.g., /Button|Card|Modal/). */
  componentNamePatterns: RegExp[];

  /** Minimum depth in tree to consider decomposition (avoid over-splitting). */
  minDepth: number;

  /** Maximum depth to decompose (prevent infinite nesting). */
  maxDepth: number;
}

/**
 * Default decomposition criteria.
 */
const DEFAULT_CRITERIA: DecompositionCriteria = {
  minChildren: 3,
  componentTypes: new Set(["COMPONENT", "COMPONENT_SET", "INSTANCE"]),
  componentNamePatterns: [
    /Button/i,
    /Card/i,
    /Modal/i,
    /Dialog/i,
    /Input/i,
    /Select/i,
    /Dropdown/i,
    /Menu/i,
    /Nav/i,
    /Header/i,
    /Footer/i,
    /Sidebar/i,
    /Icon/i,
    /Badge/i,
    /Tag/i,
    /Chip/i,
  ],
  minDepth: 1,
  maxDepth: 10,
};

// ---------------------------------------------------------------------------
// Component Detection
// ---------------------------------------------------------------------------

/**
 * Determines if a Figma node should be decomposed into a separate component.
 *
 * @param node - The Figma node to evaluate.
 * @param depth - Current depth in the tree (0 = root).
 * @param criteria - Decomposition criteria (optional, uses defaults).
 * @returns True if the node should be a separate component.
 */
export function shouldDecompose(
  node: FigmaNode,
  depth: number,
  criteria: Partial<DecompositionCriteria> = {}
): boolean {
  const config = { ...DEFAULT_CRITERIA, ...criteria };

  // Check depth bounds
  if (depth < config.minDepth || depth > config.maxDepth) {
    return false;
  }

  // Always decompose Figma components/instances
  if (config.componentTypes.has(node.type)) {
    return true;
  }

  // Check name patterns
  for (const pattern of config.componentNamePatterns) {
    if (pattern.test(node.name)) {
      return true;
    }
  }

  // Check structural complexity (children count)
  const childCount = node.children?.length ?? 0;
  if (childCount >= config.minChildren) {
    return true;
  }

  return false;
}

// ---------------------------------------------------------------------------
// Component Decomposition
// ---------------------------------------------------------------------------

/**
 * Context for tracking decomposition state.
 */
interface DecompositionContext {
  /** All component plans being created. */
  components: Map<string, ComponentPlan>;

  /** Counter for generating unique IDs. */
  idCounter: number;

  /** Current depth in tree. */
  depth: number;

  /** Base output directory for components. */
  outputDir: string;

  /** Project framework (react, vue, etc.). */
  framework: "react" | "vue" | "svelte" | "html";

  /** Decomposition criteria. */
  criteria: DecompositionCriteria;
}

/**
 * Generates a clean component name from a Figma node name.
 *
 * @param nodeName - Original Figma node name.
 * @returns Clean component name (PascalCase, alphanumeric).
 */
function generateComponentName(nodeName: string): string {
  // Remove special characters, convert to PascalCase
  return nodeName
    .replace(/[^a-zA-Z0-9\s]/g, "")
    .split(/\s+/)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join("");
}

/**
 * Generates a file path for a component.
 *
 * @param componentName - Component name (PascalCase).
 * @param outputDir - Base output directory.
 * @param framework - Project framework.
 * @returns File path for the component.
 */
function generateFilePath(
  componentName: string,
  outputDir: string,
  framework: "react" | "vue" | "svelte" | "html"
): string {
  const ext = framework === "react" ? "tsx" : framework === "vue" ? "vue" : framework === "svelte" ? "svelte" : "html";
  return `${outputDir}/${componentName}.${ext}`;
}

/**
 * Extracts design properties from a Figma node.
 *
 * @param node - Figma node.
 * @returns Design properties object.
 */
function extractDesignProps(node: FigmaNode): ComponentPlan["designProps"] {
  const props: ComponentPlan["designProps"] = {};

  // Bounds
  if (node.bounds) {
    props.width = `${node.bounds.width}px`;
    props.height = `${node.bounds.height}px`;
  }

  // Layout
  if (node.layout) {
    if (node.layout.spacing) {
      props.gap = `${node.layout.spacing}px`;
    }
    if (node.layout.padding) {
      const p = node.layout.padding;
      props.padding = `${p.top}px ${p.right}px ${p.bottom}px ${p.left}px`;
    }
  }

  // Styles
  if (node.styles) {
    if (node.styles.fontFamily) {
      props.fontFamily = node.styles.fontFamily;
    }
    if (node.styles.fontSize) {
      props.fontSize = `${node.styles.fontSize}px`;
    }
    if (node.styles.fontWeight) {
      props.fontWeight = node.styles.fontWeight.toString();
    }
    if (node.styles.textAlign) {
      props.textAlign = node.styles.textAlign;
    }
    if (node.styles.opacity !== undefined) {
      props.opacity = node.styles.opacity.toString();
    }
  }

  return props;
}

/**
 * Recursively decomposes a Figma node into component plans.
 *
 * @param node - The Figma node to decompose.
 * @param ctx - Decomposition context.
 * @param parentId - Parent component ID (if any).
 * @returns Component ID for this node (may be newly created or null if not a component).
 */
function decomposeNode(
  node: FigmaNode,
  ctx: DecompositionContext,
  parentId?: string
): string | null {
  // Check if this node should be a component
  const isComponent = shouldDecompose(node, ctx.depth, ctx.criteria);

  let componentId: string | null = null;

  if (isComponent) {
    // Generate component plan
    componentId = `comp-${ctx.idCounter++}`;
    const componentName = generateComponentName(node.name);
    const filePath = generateFilePath(componentName, ctx.outputDir, ctx.framework);

    const plan: ComponentPlan = {
      id: componentId,
      name: componentName,
      displayName: node.name,
      figmaNodeId: node.id,
      filePath,
      type: ctx.framework,
      dependencies: [],
      priority: ctx.depth, // Lower depth = higher priority (parent before children)
      isAtomic: !node.children || node.children.length === 0,
      designProps: extractDesignProps(node),
      acceptanceCriteria: [
        "Visual match with Figma design",
        "Responsive behavior matches constraints",
        "Accessible (semantic HTML, ARIA)",
      ],
      status: "pending",
      iterations: 0,
    };

    ctx.components.set(componentId, plan);
  }

  // Recurse into children
  if (node.children && node.children.length > 0) {
    ctx.depth++;

    for (const child of node.children) {
      const childComponentId = decomposeNode(child, ctx, componentId ?? parentId);

      // If this node is a component and the child is also a component, add dependency
      if (componentId && childComponentId) {
        const plan = ctx.components.get(componentId);
        if (plan && !plan.dependencies.includes(childComponentId)) {
          plan.dependencies.push(childComponentId);
        }
      }
    }

    ctx.depth--;
  }

  return componentId;
}

/**
 * Decomposes a Figma design into a component hierarchy with dependency tracking.
 *
 * @param design - Figma design data.
 * @param options - Decomposition options.
 * @returns Array of component plans with dependency information.
 */
export function decompose(
  design: FigmaDesignData,
  options: {
    outputDir?: string;
    framework?: "react" | "vue" | "svelte" | "html";
    criteria?: Partial<DecompositionCriteria>;
  } = {}
): ComponentPlan[] {
  const ctx: DecompositionContext = {
    components: new Map(),
    idCounter: 1,
    depth: 0,
    outputDir: options.outputDir ?? "src/components",
    framework: options.framework ?? "react",
    criteria: { ...DEFAULT_CRITERIA, ...options.criteria },
  };

  // Start decomposition from root
  decomposeNode(design.rootNode, ctx);

  return Array.from(ctx.components.values());
}

// ---------------------------------------------------------------------------
// Topological Sort
// ---------------------------------------------------------------------------

/**
 * Performs topological sort on component plans to determine build order.
 *
 * Components with no dependencies come first, then components that depend on them, etc.
 * Handles cycles by breaking them and logging a warning.
 *
 * @param components - Array of component plans.
 * @returns Sorted array of component plans (build order).
 */
export function topologicalSort(components: ComponentPlan[]): ComponentPlan[] {
  // Build adjacency list and in-degree map
  const graph = new Map<string, string[]>();
  const inDegree = new Map<string, number>();

  // Initialize
  for (const comp of components) {
    graph.set(comp.id, comp.dependencies);
    inDegree.set(comp.id, 0);
  }

  // Calculate in-degrees
  for (const comp of components) {
    for (const depId of comp.dependencies) {
      const current = inDegree.get(depId) ?? 0;
      inDegree.set(depId, current + 1);
    }
  }

  // Kahn's algorithm for topological sort
  const queue: string[] = [];
  const result: ComponentPlan[] = [];
  const componentMap = new Map(components.map((c) => [c.id, c]));

  // Start with nodes that have no dependencies (in-degree 0)
  for (const [id, degree] of inDegree.entries()) {
    if (degree === 0) {
      queue.push(id);
    }
  }

  while (queue.length > 0) {
    const currentId = queue.shift()!;
    const component = componentMap.get(currentId);

    if (component) {
      result.push(component);
    }

    // Process dependencies (reverse direction: this component depends on others)
    const deps = graph.get(currentId) ?? [];
    for (const depId of deps) {
      const newDegree = (inDegree.get(depId) ?? 0) - 1;
      inDegree.set(depId, newDegree);

      if (newDegree === 0) {
        queue.push(depId);
      }
    }
  }

  // Check for cycles (if result.length < components.length, there's a cycle)
  if (result.length < components.length) {
    console.warn(
      `Topological sort detected cycle. Sorted ${result.length}/${components.length} components. Adding remaining in original order.`
    );

    // Add remaining components (break cycle)
    for (const comp of components) {
      if (!result.find((r) => r.id === comp.id)) {
        result.push(comp);
      }
    }
  }

  return result;
}
