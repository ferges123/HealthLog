/**
 * Antigravity CLI (agy) ACP provider for HealthLog.
 *
 * This client implements the AIProvider contract over the Agent Client
 * Protocol (ACP) v1, communicating via JSON-RPC over stdio with the
 * `agy acp` subprocess.
 *
 * Key constraints (see docs/antigravity-cli-architecture.md):
 * - supportsTools = false (ACP tools are for agent operations, not function calling)
 * - No credential storage in DB (uses CLI auth)
 * - New session per completion (no session ID persistence)
 * - Streaming via agent_message_chunk notifications
 * - All permission requests are rejected
 *
 * @see docs/antigravity-cli-transport-decision.md
 */

import { spawn, ChildProcess } from "child_process";
import { randomUUID } from "crypto";
import { mkdirSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type {
  AIProvider,
  CompletionParams,
  CompletionResult,
  AiContentPart,
  ProviderType,
} from "./types";

// ─── ACP JSON-RPC Types ───────────────────────────────────────

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number | string;
  method: string;
  params?: unknown;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number | string;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
}

type JsonRpcMessage = JsonRpcResponse | JsonRpcNotification;

interface ACPInitializeResult {
  protocolVersion: string;
  agentInfo: {
    name: string;
    version: string;
  };
  capabilities?: {
    promptCapabilities?: {
      text?: boolean;
      image?: boolean;
      audio?: boolean;
      resourceBlob?: boolean;
    };
    [key: string]: unknown;
  };
}

interface ACPConfigOption {
  name: string;
  type: string;
  displayName?: string;
  enum?: string[];
  default?: unknown;
  [key: string]: unknown;
}

interface ACPSessionNewResult {
  sessionId: string;
  configOptions?: ACPConfigOption[];
}

interface ACPPromptResult {
  stopReason?: "end_turn" | "max_tokens" | "cancelled" | "refusal";
}

interface ACPSessionUpdate {
  sessionUpdate: string;
  content?: { type: string; text?: string };
  [key: string]: unknown;
}

// ─── Error Codes ─────────────────────────────────────────────

export class AntigravityError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly originalError?: unknown,
  ) {
    super(message);
    this.name = "AntigravityError";
  }
}

export const ANTIGRAVITY_ERRORS = {
  CLI_UNAVAILABLE: "cli_unavailable",
  AUTH_REQUIRED: "auth_required",
  SESSION_FAILED: "session_failed",
  PROMPT_FAILED: "prompt_failed",
  QUOTA_EXCEEDED: "quota_exceeded",
  MODEL_UNAVAILABLE: "model_unavailable",
  CANCELLED: "cancelled",
  TIMEOUT: "timeout",
  PROCESS_ERROR: "process_error",
} as const;

// ─── Client Implementation ───────────────────────────────────

export class AntigravityClient implements AIProvider {
  readonly type: ProviderType = "antigravity";
  readonly supportsTools = false; // ACP tools are NOT HealthLog function calling

  private process: ChildProcess | null = null;
  private requestId = 0;
  private pendingRequests = new Map<
    number | string,
    {
      resolve: (response: JsonRpcResponse) => void;
      reject: (error: Error) => void;
    }
  >();
  private buffer = "";
  private notifications: JsonRpcNotification[] = [];
  private sessionWarnings: string[] = [];

  constructor(
    private config: {
      /** User's selected model (from antigravityModel field) */
      model?: string | null;
      /** Reasoning effort: "low" | "medium" | "high" | "xhigh" | "max" */
      thoughtLevel?: string;
      /** Profile ID for isolation (not used in Stage 2 - uses default auth) */
      profileId?: string;
      /** Timeout for operations in ms */
      timeoutMs?: number;
    } = {},
  ) {}

  // ─── AIProvider Implementation ─────────────────────────────

  async generateCompletion(params: CompletionParams): Promise<CompletionResult> {
    const { signal } = params;

    try {
      // 1. Start ACP process
      await this.startProcess(signal);

      // 2. Initialize ACP
      await this.initialize(signal);

      // 3. Create session
      const sessionId = await this.createSession(signal);

      // 4. Send prompt and collect response
      const result = await this.sendPrompt(sessionId, params, signal);

      // 5. Return result
      return result;
    } finally {
      // Always clean up
      await this.stopProcess();
    }
  }

  async generateCompletionStream(
    params: CompletionParams,
    onDelta: (delta: string) => void,
  ): Promise<CompletionResult> {
    const { signal } = params;

    try {
      await this.startProcess(signal);
      await this.initialize(signal);
      const sessionId = await this.createSession(signal);

      // Stream mode - call onDelta for each chunk
      const result = await this.sendPrompt(sessionId, params, signal, onDelta);

      return result;
    } finally {
      await this.stopProcess();
    }
  }

  // ─── Process Lifecycle ─────────────────────────────────────

  private async startProcess(signal?: AbortSignal): Promise<void> {
    if (this.process) return;

    return new Promise((resolve, reject) => {
      const timeout = this.config.timeoutMs ?? 60_000;

      // Create temp work directory
      const workDir = join(tmpdir(), `healthlog-acp-${randomUUID()}`);
      mkdirSync(workDir, { recursive: true, mode: 0o700 });

      // Spawn agy acp process
      // NOTE: Not using --app-data-dir in Stage 2 (uses default auth)
      this.process = spawn("agy", ["acp", "--sandbox", "--disable-telemetry"], {
        stdio: ["pipe", "pipe", "pipe"],
        cwd: workDir,
        env: {
          ...process.env,
          // Strip secrets
          ANTHROPIC_API_KEY: undefined,
          OPENAI_API_KEY: undefined,
        },
      });

      this.process.on("error", (err) => {
        this.process = null;
        reject(
          new AntigravityError(
            `Failed to start agy: ${err.message}`,
            ANTIGRAVITY_ERRORS.CLI_UNAVAILABLE,
            err,
          ),
        );
      });

      this.process.stdout?.on("data", (data: Buffer) => {
        this.handleData(data.toString());
      });

      this.process.stderr?.on("data", () => {
        // Ignore stderr - may contain sensitive data
      });

      this.process.on("close", (code) => {
        this.process = null;
      });

      // Wait for process to start
      setTimeout(resolve, 500);

      // Abort handler
      signal?.addEventListener("abort", () => {
        this.stopProcess();
        reject(new AntigravityError("Aborted", ANTIGRAVITY_ERRORS.CANCELLED));
      });

      // Timeout
      setTimeout(() => {
        if (!this.process) return;
        reject(new AntigravityError("Process start timeout", ANTIGRAVITY_ERRORS.TIMEOUT));
      }, 5000);
    });
  }

  private handleData(data: string): void {
    this.buffer += data;

    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() || "";

    for (const line of lines) {
      if (!line.trim()) continue;

      try {
        const message: JsonRpcMessage = JSON.parse(line);

        if ("id" in message && message.id !== undefined) {
          // Response to a request
          const pending = this.pendingRequests.get(message.id);
          if (pending) {
            this.pendingRequests.delete(message.id);
            pending.resolve(message);
          }
        } else if ("method" in message) {
          // Notification
          this.handleNotification(message);
        }
      } catch {
        // Ignore parse errors
      }
    }
  }

  private handleNotification(notification: JsonRpcNotification): void {
    this.notifications.push(notification);

    // Handle permission requests - always reject
    if (notification.method === "session/request_permission") {
      const params = notification.params as { requestId: string };
      this.rejectPermission(params.requestId).catch(() => {});
    }

    // Collect session warnings
    if (notification.method === "session/update") {
      const params = notification.params as { update?: ACPSessionUpdate };
      if (params.update?.sessionUpdate === "usage_update") {
        // Check for quota warnings
        const content = JSON.stringify(params.update);
        if (content.includes("quota")) {
          this.sessionWarnings.push("Quota warning received");
        }
      }
    }
  }

  private async stopProcess(): Promise<void> {
    if (!this.process) return;

    return new Promise((resolve) => {
      if (!this.process) {
        resolve();
        return;
      }

      const timeout = setTimeout(() => {
        this.process?.kill("SIGKILL");
      }, 2000);

      this.process.on("close", () => {
        clearTimeout(timeout);
        resolve();
      });

      this.process.kill("SIGTERM");
    });
  }

  // ─── ACP Protocol Methods ───────────────────────────────────

  private async initialize(signal?: AbortSignal): Promise<ACPInitializeResult> {
    const { result, error } = await this.send<ACPInitializeResult>("initialize", {
      protocolVersion: 1,
      clientInfo: {
        name: "HealthLog",
        version: "1.0.0",
      },
    });

    if (error) {
      throw new AntigravityError(
        `Initialize failed: ${error.message}`,
        ANTIGRAVITY_ERRORS.SESSION_FAILED,
        error,
      );
    }

    return result!;
  }

  private async createSession(signal?: AbortSignal): Promise<string> {
    const workDir = join(tmpdir(), `healthlog-acp-workspace-${randomUUID()}`);
    mkdirSync(workDir, { recursive: true, mode: 0o700 });

    const { result, error } = await this.send<ACPSessionNewResult>("session/new", {
      cwd: workDir,
      mcpServers: [], // No MCP servers
    });

    if (error) {
      // Check for auth error
      if (error.message.includes("Authentication required")) {
        throw new AntigravityError(
          "Authentication required",
          ANTIGRAVITY_ERRORS.AUTH_REQUIRED,
          error,
        );
      }
      throw new AntigravityError(
        `Session creation failed: ${error.message}`,
        ANTIGRAVITY_ERRORS.SESSION_FAILED,
        error,
      );
    }

    // Set config options if specified
    if (this.config.model || this.config.thoughtLevel) {
      await this.configureSession(result!.sessionId, signal);
    }

    return result!.sessionId;
  }

  private async configureSession(sessionId: string, signal?: AbortSignal): Promise<void> {
    // TODO: Implement config option setting via session/update
    // For Stage 2, we rely on the model specified in the prompt
  }

  private async sendPrompt(
    sessionId: string,
    params: CompletionParams,
    signal?: AbortSignal,
    onStream?: (delta: string) => void,
  ): Promise<CompletionResult> {
    // Clear notifications
    this.notifications = [];
    this.sessionWarnings = [];

    // Build prompt content
    const prompt = this.buildPromptContent(params);

    // Send prompt
    const { result, error } = await this.send<ACPPromptResult>("session/prompt", {
      sessionId,
      prompt,
      // TODO: Add reasoning config when supported
    });

    if (error) {
      // Check for quota
      if (error.message.includes("quota")) {
        throw new AntigravityError(
          "Quota exceeded",
          ANTIGRAVITY_ERRORS.QUOTA_EXCEEDED,
          error,
        );
      }

      throw new AntigravityError(
        `Prompt failed: ${error.message}`,
        ANTIGRAVITY_ERRORS.PROMPT_FAILED,
        error,
      );
    }

    // Collect response from notifications
    const content = this.collectResponse(onStream);
    const tokensUsed = this.extractTokens();
    const model = this.config.model ?? "unknown";

    return {
      content,
      tokensUsed,
      model,
      providerType: "antigravity",
      finishReason: this.mapStopReason(result?.stopReason),
    };
  }

  private buildPromptContent(params: CompletionParams): AiContentPart[] {
    const parts: AiContentPart[] = [];

    // Build message content
    // For now, we use a single user message with system instructions
    // TODO: Support multi-turn by encoding history

    let userContent = "";

    // Add system prompt as prefix (ACP doesn't have separate system)
    if (params.system) {
      userContent += params.system + "\n\n";
    }

    // Extract text from messages
    for (const msg of params.messages) {
      if (msg.role === "user") {
        if (typeof msg.content === "string") {
          userContent += msg.content;
        } else {
          // Handle multimodal content
          for (const part of msg.content) {
            if (part.type === "text") {
              userContent += part.text;
            } else if (part.type === "image") {
              parts.push({
                type: "image",
                mimeType: part.mediaType,
                data: part.dataBase64,
              } as any); // ACP format
            } else if (part.type === "document") {
              // PDF as resource blob
              parts.push({
                type: "resource",
                resource: {
                  uri: `healthlog://document.pdf`,
                  mimeType: part.mediaType,
                  blob: part.dataBase64,
                },
              } as any);
            }
          }
        }
      }
    }

    // Add text part first
    if (userContent) {
      parts.unshift({ type: "text", text: userContent });
    }

    return parts;
  }

  private collectResponse(onStream?: (delta: string) => void): string {
    const chunks: string[] = [];

    for (const notif of this.notifications) {
      if (notif.method === "session/update") {
        const params = notif.params as { update?: ACPSessionUpdate };
        if (params.update?.sessionUpdate === "agent_message_chunk") {
          const text = params.update.content?.text ?? "";
          chunks.push(text);
          onStream?.(text);
        }
      }
    }

    return chunks.join("");
  }

  private extractTokens(): number | null {
    // TODO: Extract from usage_update notification
    return null;
  }

  private mapStopReason(
    reason?: "end_turn" | "max_tokens" | "cancelled" | "refusal",
  ): "stop" | "length" | undefined {
    switch (reason) {
      case "end_turn":
        return "stop";
      case "max_tokens":
        return "length";
      case "cancelled":
        return undefined; // Will be handled differently
      default:
        return "stop";
    }
  }

  // ─── JSON-RPC Helpers ─────────────────────────────────────────

  private async send<T = unknown>(
    method: string,
    params?: unknown,
  ): Promise<{ result?: T; error?: { code: number; message: string } }> {
    return new Promise((resolve, reject) => {
      if (!this.process?.stdin) {
        reject(new AntigravityError("Process not running", ANTIGRAVITY_ERRORS.PROCESS_ERROR));
        return;
      }

      const id = ++this.requestId;
      const request: JsonRpcRequest = { jsonrpc: "2.0", id, method, params };

      this.pendingRequests.set(id, {
        resolve: (response) => {
          resolve({
            result: response.result as T | undefined,
            error: response.error as { code: number; message: string } | undefined,
          });
        },
        reject,
      });

      const line = JSON.stringify(request) + "\n";
      this.process.stdin.write(line);
    });
  }

  private async rejectPermission(requestId: string): Promise<void> {
    await this.send("session/reject_permission", { requestId });
  }
}
