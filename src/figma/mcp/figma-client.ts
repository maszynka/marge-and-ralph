/**
 * Figma MCP client for extracting design data and exporting assets.
 *
 * Communicates with the Figma MCP server to:
 * - Extract design data from Figma files
 * - Export nodes as PNG images
 * - Transform API responses to FigmaDesignData format
 */

import { BaseMCPClient, type MCPServerConfig } from "./base-client.js";
import type { FigmaDesignData, FigmaNode } from "../types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Configuration for Figma MCP client.
 */
export interface FigmaClientConfig extends MCPServerConfig {
  /** Figma personal access token. */
  accessToken: string;
}

/**
 * Raw response from Figma API (via MCP server).
 */
interface FigmaAPIResponse {
  name: string;
  lastModified: string;
  thumbnailUrl: string;
  document: {
    id: string;
    name: string;
    type: string;
    children: unknown[];
  };
}

/**
 * Raw Figma node from API.
 */
interface RawFigmaNode {
  id: string;
  name: string;
  type: string;
  children?: RawFigmaNode[];
  absoluteBoundingBox?: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  layoutMode?: string;
  itemSpacing?: number;
  paddingTop?: number;
  paddingRight?: number;
  paddingBottom?: number;
  paddingLeft?: number;
  fills?: unknown[];
  strokes?: unknown[];
  effects?: unknown[];
  constraints?: {
    horizontal: string;
    vertical: string;
  };
  style?: {
    fontFamily?: string;
    fontSize?: number;
    fontWeight?: number;
    textAlignHorizontal?: string;
  };
  opacity?: number;
}

/**
 * Export request parameters.
 */
interface ExportNodeParams {
  /** File key. */
  fileKey: string;

  /** Node ID to export. */
  nodeId: string;

  /** Export format (default: png). */
  format?: "png" | "jpg" | "svg" | "pdf";

  /** Scale factor (default: 1). */
  scale?: number;
}

/**
 * Export response from Figma API.
 */
interface ExportResponse {
  /** URLs of exported images (keyed by node ID). */
  images: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Figma MCP Client
// ---------------------------------------------------------------------------

/**
 * Client for interacting with Figma via MCP server.
 */
export class FigmaMCPClient extends BaseMCPClient {
  private accessToken: string;

  constructor(config: FigmaClientConfig) {
    // Pass base config to parent, adding Figma access token to env
    super("FigmaMCP", {
      ...config,
      env: {
        ...config.env,
        FIGMA_ACCESS_TOKEN: config.accessToken,
      },
    });
    this.accessToken = config.accessToken;
  }

  /**
   * Extract design data from a Figma file.
   *
   * @param fileKey - Figma file key (from URL)
   * @param nodeId - Optional node ID to extract (defaults to entire document)
   * @returns Design data in standardized format
   */
  async extractDesign(
    fileKey: string,
    nodeId?: string
  ): Promise<FigmaDesignData> {
    try {
      // Call MCP tool to fetch Figma file data
      const response = await this.call<FigmaAPIResponse>("figma_get_file", {
        file_key: fileKey,
        node_id: nodeId,
      });

      // Find the target node (or use document root)
      let targetNode: RawFigmaNode;
      if (nodeId) {
        const foundNode = this.findNodeById(response.document, nodeId);
        if (!foundNode) {
          throw new Error(`Node with ID '${nodeId}' not found in file`);
        }
        targetNode = foundNode;
      } else {
        targetNode = response.document as unknown as RawFigmaNode;
      }

      // Transform raw node to our format
      const rootNode = this.transformNode(targetNode);

      // Flatten node tree for easier searching
      const allNodes = this.flattenNodes(rootNode);

      // Build design data
      const designData: FigmaDesignData = {
        fileKey,
        nodeId: nodeId ?? response.document.id,
        fileName: response.name,
        rootNode,
        allNodes,
        extractedAt: new Date(),
      };

      return designData;
    } catch (error) {
      throw new Error(
        `Failed to extract design from Figma: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Export a Figma node as an image.
   *
   * @param params - Export parameters
   * @returns URL to the exported image
   */
  async exportNode(params: ExportNodeParams): Promise<string> {
    try {
      const response = await this.call<ExportResponse>("figma_export_images", {
        file_key: params.fileKey,
        ids: [params.nodeId],
        format: params.format ?? "png",
        scale: params.scale ?? 1,
      });

      // Extract the image URL for the requested node
      const imageUrl = response.images[params.nodeId];
      if (!imageUrl) {
        throw new Error(
          `Export failed: No image URL returned for node '${params.nodeId}'`
        );
      }

      return imageUrl;
    } catch (error) {
      throw new Error(
        `Failed to export node from Figma: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Private Methods
  // ---------------------------------------------------------------------------

  /**
   * Find a node by ID in the node tree.
   */
  private findNodeById(
    node: RawFigmaNode | { id: string; children?: unknown[] },
    targetId: string
  ): RawFigmaNode | null {
    if (node.id === targetId) {
      return node as RawFigmaNode;
    }

    if (node.children) {
      for (const child of node.children) {
        const found = this.findNodeById(child as RawFigmaNode, targetId);
        if (found) {
          return found;
        }
      }
    }

    return null;
  }

  /**
   * Transform raw Figma node to our standardized format.
   */
  private transformNode(raw: RawFigmaNode): FigmaNode {
    const node: FigmaNode = {
      id: raw.id,
      name: raw.name,
      type: raw.type as FigmaNode["type"],
    };

    // Transform children recursively
    if (raw.children) {
      node.children = raw.children.map((child) => this.transformNode(child));
    }

    // Transform layout properties
    if (raw.layoutMode) {
      node.layout = {
        mode: this.mapLayoutMode(raw.layoutMode),
        spacing: raw.itemSpacing,
      };

      // Add padding if present
      if (
        raw.paddingTop !== undefined ||
        raw.paddingRight !== undefined ||
        raw.paddingBottom !== undefined ||
        raw.paddingLeft !== undefined
      ) {
        node.layout.padding = {
          top: raw.paddingTop ?? 0,
          right: raw.paddingRight ?? 0,
          bottom: raw.paddingBottom ?? 0,
          left: raw.paddingLeft ?? 0,
        };
      }
    }

    // Transform style properties
    if (raw.fills || raw.strokes || raw.effects || raw.style) {
      node.styles = {
        fills: raw.fills,
        strokes: raw.strokes,
        effects: raw.effects,
        fontFamily: raw.style?.fontFamily,
        fontSize: raw.style?.fontSize,
        fontWeight: raw.style?.fontWeight,
        textAlign: raw.style?.textAlignHorizontal,
        opacity: raw.opacity,
      };
    }

    // Transform constraints
    if (raw.constraints) {
      node.constraints = {
        horizontal: raw.constraints.horizontal as "LEFT" | "RIGHT" | "CENTER" | "SCALE" | "STRETCH",
        vertical: raw.constraints.vertical as "TOP" | "BOTTOM" | "CENTER" | "SCALE" | "STRETCH",
      };
    }

    // Transform bounding box
    if (raw.absoluteBoundingBox) {
      node.bounds = {
        x: raw.absoluteBoundingBox.x,
        y: raw.absoluteBoundingBox.y,
        width: raw.absoluteBoundingBox.width,
        height: raw.absoluteBoundingBox.height,
      };
    }

    return node;
  }

  /**
   * Map Figma layout mode to our standardized format.
   */
  private mapLayoutMode(
    mode: string
  ): "NONE" | "HORIZONTAL" | "VERTICAL" {
    switch (mode) {
      case "HORIZONTAL":
        return "HORIZONTAL";
      case "VERTICAL":
        return "VERTICAL";
      default:
        return "NONE";
    }
  }

  /**
   * Flatten node tree into a list of all nodes.
   */
  private flattenNodes(root: FigmaNode): FigmaNode[] {
    const nodes: FigmaNode[] = [root];

    if (root.children) {
      for (const child of root.children) {
        nodes.push(...this.flattenNodes(child));
      }
    }

    return nodes;
  }
}
