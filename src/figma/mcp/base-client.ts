/**
 * Base MCP (Model Context Protocol) client infrastructure.
 *
 * Provides connection management, request/response handling, error handling,
 * and retry logic for communicating with MCP servers via stdio.
 *
 * MCP servers expose tools (functions) that can be called by sending JSON-RPC
 * messages over stdin/stdout. This base client handles the low-level protocol
 * details so specific clients (Figma, Playwriter, Playwright) can focus on
 * their domain-specific tool calls.
 */

import { spawn, type ChildProcess } from "child_process";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Configuration for an MCP server connection.
 */
export interface MCPServerConfig {
  /** Server command to spawn (e.g., "npx", "node", "python"). */
  command: string;

  /** Arguments to pass to the command. */
  args: string[];

  /** Environment variables for the server process. */
  env?: Record<string, string>;

  /** Working directory for the server process. */
  cwd?: string;

  /** Timeout for connection establishment (ms). Default: 10000. */
  connectionTimeout?: number;

  /** Timeout for individual tool calls (ms). Default: 30000. */
  callTimeout?: number;

  /** Maximum retry attempts for failed calls. Default: 3. */
  maxRetries?: number;

  /** Delay between retry attempts (ms). Default: 1000. */
  retryDelay?: number;
}

/**
 * MCP JSON-RPC request.
 */
interface MCPRequest {
  jsonrpc: "2.0";
  id: number | string;
  method: string;
  params?: Record<string, unknown>;
}

/**
 * MCP JSON-RPC response.
 */
interface MCPResponse {
  jsonrpc: "2.0";
  id: number | string;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

/**
 * Connection state.
 */
type ConnectionState = "disconnected" | "connecting" | "connected" | "error";

// ---------------------------------------------------------------------------
// Base MCP Client
// ---------------------------------------------------------------------------

/**
 * Base client for communicating with MCP servers.
 */
export class BaseMCPClient {
  protected config: Omit<Required<MCPServerConfig>, "cwd"> & { cwd?: string };
  protected process: ChildProcess | null = null;
  protected state: ConnectionState = "disconnected";
  protected requestId = 0;
  protected pendingRequests = new Map<
    number | string,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
      timer: NodeJS.Timeout;
    }
  >();
  protected buffer = "";
  protected serverName: string;

  constructor(serverName: string, config: MCPServerConfig) {
    this.serverName = serverName;
    this.config = {
      command: config.command,
      args: config.args,
      env: config.env ?? {},
      cwd: config.cwd,
      connectionTimeout: config.connectionTimeout ?? 10000,
      callTimeout: config.callTimeout ?? 30000,
      maxRetries: config.maxRetries ?? 3,
      retryDelay: config.retryDelay ?? 1000,
    };
  }

  /**
   * Connect to the MCP server.
   * Spawns the server process and sets up stdio communication.
   */
  async connect(): Promise<void> {
    if (this.state === "connected") {
      return; // Already connected
    }

    if (this.state === "connecting") {
      throw new Error(`${this.serverName}: Connection already in progress`);
    }

    this.state = "connecting";

    try {
      // Spawn the MCP server process
      this.process = spawn(this.config.command, this.config.args, {
        env: { ...process.env, ...this.config.env },
        cwd: this.config.cwd,
        stdio: ["pipe", "pipe", "pipe"],
      });

      // Handle stdout (server responses)
      this.process.stdout?.on("data", (chunk: Buffer) => {
        this.handleStdout(chunk);
      });

      // Handle stderr (server logs/errors)
      this.process.stderr?.on("data", (chunk: Buffer) => {
        const message = chunk.toString().trim();
        if (message) {
          console.error(`[${this.serverName}] ${message}`);
        }
      });

      // Handle process exit
      this.process.on("exit", (code, signal) => {
        const reason = signal ? `signal ${signal}` : `code ${code}`;
        console.error(`[${this.serverName}] Process exited: ${reason}`);
        this.state = "disconnected";
        this.rejectAllPending(
          new Error(`Server process exited: ${reason}`)
        );
      });

      // Handle process errors
      this.process.on("error", (error) => {
        console.error(`[${this.serverName}] Process error:`, error);
        this.state = "error";
        this.rejectAllPending(error);
      });

      // Wait for connection to be established
      await this.waitForConnection();

      this.state = "connected";
      console.log(`[${this.serverName}] Connected successfully`);
    } catch (error) {
      this.state = "error";
      this.cleanup();
      throw new Error(
        `${this.serverName}: Failed to connect: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Disconnect from the MCP server.
   * Terminates the server process and cleans up resources.
   */
  async disconnect(): Promise<void> {
    if (this.state === "disconnected") {
      return;
    }

    console.log(`[${this.serverName}] Disconnecting...`);

    // Reject any pending requests
    this.rejectAllPending(new Error("Client disconnected"));

    // Cleanup and terminate process
    this.cleanup();

    this.state = "disconnected";
    console.log(`[${this.serverName}] Disconnected`);
  }

  /**
   * Call an MCP tool (with retry logic).
   *
   * @param method - The tool/method name to call
   * @param params - Parameters to pass to the tool
   * @returns The result from the tool
   */
  async call<T = unknown>(
    method: string,
    params?: Record<string, unknown>
  ): Promise<T> {
    let lastError: Error | null = null;

    for (let attempt = 0; attempt < this.config.maxRetries; attempt++) {
      try {
        if (this.state !== "connected") {
          throw new Error(`${this.serverName}: Not connected`);
        }

        const result = await this.sendRequest<T>(method, params);
        return result;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        console.warn(
          `[${this.serverName}] Call failed (attempt ${attempt + 1}/${this.config.maxRetries}): ${lastError.message}`
        );

        // Don't retry on the last attempt
        if (attempt < this.config.maxRetries - 1) {
          await this.sleep(this.config.retryDelay);
        }
      }
    }

    throw new Error(
      `${this.serverName}: Call to '${method}' failed after ${this.config.maxRetries} attempts: ${lastError?.message}`
    );
  }

  /**
   * Check if the client is connected.
   */
  isConnected(): boolean {
    return this.state === "connected";
  }

  /**
   * Get the current connection state.
   */
  getState(): ConnectionState {
    return this.state;
  }

  // ---------------------------------------------------------------------------
  // Private Methods
  // ---------------------------------------------------------------------------

  /**
   * Send a JSON-RPC request to the server.
   */
  private async sendRequest<T>(
    method: string,
    params?: Record<string, unknown>
  ): Promise<T> {
    const id = ++this.requestId;
    const request: MCPRequest = {
      jsonrpc: "2.0",
      id,
      method,
      params,
    };

    return new Promise<T>((resolve, reject) => {
      // Set up timeout
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(
          new Error(
            `${this.serverName}: Request timeout for method '${method}'`
          )
        );
      }, this.config.callTimeout);

      // Store pending request
      this.pendingRequests.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
      });

      // Send request via stdin
      const message = JSON.stringify(request) + "\n";
      this.process?.stdin?.write(message, (error) => {
        if (error) {
          this.pendingRequests.delete(id);
          clearTimeout(timer);
          reject(
            new Error(
              `${this.serverName}: Failed to write request: ${error.message}`
            )
          );
        }
      });
    });
  }

  /**
   * Handle stdout data from the server.
   */
  private handleStdout(chunk: Buffer): void {
    this.buffer += chunk.toString();

    // Process complete JSON-RPC messages (newline-delimited)
    let newlineIndex: number;
    while ((newlineIndex = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, newlineIndex).trim();
      this.buffer = this.buffer.slice(newlineIndex + 1);

      if (line) {
        try {
          const response: MCPResponse = JSON.parse(line);
          this.handleResponse(response);
        } catch (error) {
          console.error(
            `[${this.serverName}] Failed to parse response:`,
            line,
            error
          );
        }
      }
    }
  }

  /**
   * Handle a JSON-RPC response from the server.
   */
  private handleResponse(response: MCPResponse): void {
    const pending = this.pendingRequests.get(response.id);
    if (!pending) {
      console.warn(
        `[${this.serverName}] Received response for unknown request ID: ${response.id}`
      );
      return;
    }

    // Clear timeout and remove from pending
    clearTimeout(pending.timer);
    this.pendingRequests.delete(response.id);

    // Resolve or reject based on response
    if (response.error) {
      pending.reject(
        new Error(
          `${this.serverName}: ${response.error.message} (code: ${response.error.code})`
        )
      );
    } else {
      pending.resolve(response.result);
    }
  }

  /**
   * Wait for the connection to be established.
   * Override this in subclasses if needed for server-specific handshake.
   */
  protected async waitForConnection(): Promise<void> {
    // Basic implementation: just wait a short time for process to start
    await this.sleep(100);

    // Check if process is still running
    if (!this.process || this.process.exitCode !== null) {
      throw new Error("Server process failed to start");
    }
  }

  /**
   * Reject all pending requests.
   */
  private rejectAllPending(error: Error): void {
    for (const [id, pending] of this.pendingRequests.entries()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pendingRequests.clear();
  }

  /**
   * Cleanup resources.
   */
  private cleanup(): void {
    if (this.process) {
      // Remove all listeners
      this.process.stdout?.removeAllListeners();
      this.process.stderr?.removeAllListeners();
      this.process.removeAllListeners();

      // Kill the process
      if (this.process.exitCode === null) {
        this.process.kill("SIGTERM");

        // Force kill after 2 seconds if still running
        setTimeout(() => {
          if (this.process && this.process.exitCode === null) {
            this.process.kill("SIGKILL");
          }
        }, 2000);
      }

      this.process = null;
    }

    this.buffer = "";
  }

  /**
   * Sleep for a specified duration.
   */
  protected sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
