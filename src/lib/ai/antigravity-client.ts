/**
 * Antigravity CLI (`agy acp`) provider for HealthLog.
 *
 * Speaks ACP v1 (JSON-RPC 2.0, one message per line) over the stdio of an
 * `agy acp` child process. Each call starts its own child process and ACP
 * session, and nothing is shared between calls.
 *
 * Guarantees:
 * - The child runs in an empty temporary workspace, deleted when the call ends.
 * - The child gets an allowlisted environment only, so app secrets stay out.
 * - The child runs under the profile directory the caller passes in
 *   (`profileDir`, `--app-data-dir`). It never uses the server's default login.
 * - The agent gets no MCP servers and no fs or terminal capabilities.
 * - Every permission request from the agent is refused.
 *
 * @see docs/antigravity-cli-architecture.md
 * @see docs/antigravity-cli-transport-decision.md
 */

import { spawn, type ChildProcess } from "child_process";
import { existsSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { isAbsolute, join } from "path";
import { StringDecoder } from "string_decoder";
import type {
  AIProvider,
  AiContentPart,
  AiMessage,
  CompletionParams,
  CompletionResult,
  ProviderType,
} from "./types";

// ─── Errors ──────────────────────────────────────────────────

export const ANTIGRAVITY_ERRORS = {
  CLI_UNAVAILABLE: "cli_unavailable",
  AUTH_REQUIRED: "auth_required",
  SESSION_FAILED: "session_failed",
  PROMPT_FAILED: "prompt_failed",
  QUOTA_EXCEEDED: "quota_exceeded",
  CANCELLED: "cancelled",
  TIMEOUT: "timeout",
  PROCESS_ERROR: "process_error",
} as const;

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

// ─── Constants ───────────────────────────────────────────────

/** Operator-set root that holds one profile directory per user id. */
const PROFILE_ROOT_ENV = "ANTIGRAVITY_PROFILE_ROOT";
const USER_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/** Environment variables passed to the child. Everything else is dropped. */
const CHILD_ENV_ALLOWLIST = [
  "PATH",
  "HOME",
  "USER",
  "LANG",
  "LC_ALL",
  "TZ",
  "TMPDIR",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_CACHE_HOME",
  "XDG_STATE_HOME",
] as const;

const PROTOCOL_VERSION = 1;
const SETUP_TIMEOUT_MS = 30_000;
const DEFAULT_PROMPT_TIMEOUT_MS = 60_000;
const KILL_GRACE_MS = 2_000;
/** Upper bound on one unparsed line. A runaway agent cannot grow memory without limit. */
const MAX_BUFFER_CHARS = 16 * 1024 * 1024;

const ROLE_LABEL: Record<AiMessage["role"], string> = {
  user: "User",
  assistant: "Assistant",
  tool: "Tool result",
};

// ─── Profile directory ───────────────────────────────────────

/**
 * The profile directory the CLI must use for this user, or null when none is
 * set up. Null means the provider must not run: without an isolated profile
 * the CLI would fall back to the server's login, which every user shares.
 *
 * The directory must already exist. Nothing in HealthLog creates it yet.
 *
 * IMPORTANT: When ANTIGRAVITY_PROFILE_ROOT is set, HealthLog stores a
 * profileId (32-char hex) in the user record and uses that as the directory
 * name, NOT the user's database ID. This function accepts the stored
 * profileId, not the database userId.
 */
export function antigravityProfileDir(profileId: string): string | null {
  const root = process.env[PROFILE_ROOT_ENV];
  if (!root || !isAbsolute(root) || !USER_ID_PATTERN.test(profileId)) return null;
  const dir = join(root, profileId);
  return existsSync(dir) ? dir : null;
}

// ─── ACP wire types ──────────────────────────────────────────

interface JsonRpcError {
  code: number;
  message: string;
}

interface JsonRpcResponse {
  id: number | string;
  result?: unknown;
  error?: JsonRpcError;
}

interface JsonRpcMessage {
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: JsonRpcError;
}

interface AcpInitializeResult {
  agentInfo?: { name?: string };
  capabilities?: {
    promptCapabilities?: { image?: boolean; resourceBlob?: boolean };
  };
}

interface AcpSessionNewResult {
  sessionId?: string;
}

interface AcpPromptResult {
  stopReason?: string;
}

interface AcpSessionUpdate {
  sessionUpdate: string;
  content?: { type?: string; text?: string };
}

interface AcpPermissionOption {
  optionId: string;
  kind: string;
}

type AcpPromptBlock =
  | { type: "text"; text: string }
  | { type: "image"; mimeType: string; data: string }
  | {
      type: "resource";
      resource: { uri: string; mimeType: string; blob: string };
    };

// ─── One child process and its JSON-RPC connection ───────────

interface PendingCall {
  resolve: (response: JsonRpcResponse) => void;
  reject: (error: AntigravityError) => void;
  timer: ReturnType<typeof setTimeout>;
}

class AcpConnection {
  private readonly decoder = new StringDecoder("utf8");
  private buffer = "";
  private nextId = 1;
  private readonly pending = new Map<number | string, PendingCall>();
  private failure: AntigravityError | null = null;
  private readonly exited: Promise<void>;

  /** Receives each `session/update` notification from the agent. */
  onSessionUpdate: (update: AcpSessionUpdate) => void = () => {};

  private constructor(private readonly child: ChildProcess) {
    this.exited = new Promise<void>((resolve) => {
      child.on("exit", () => resolve());
    });
    child.stdout?.on("data", (chunk: Buffer) => this.onData(chunk));
    // stderr can carry user data or secrets. Drain it and never log it.
    child.stderr?.resume();
    child.stdin?.on("error", () =>
      this.fail(
        new AntigravityError(
          "agy stdin closed",
          ANTIGRAVITY_ERRORS.PROCESS_ERROR,
        ),
      ),
    );
    child.on("error", (err) =>
      this.fail(
        new AntigravityError(
          "agy process error",
          ANTIGRAVITY_ERRORS.PROCESS_ERROR,
          err,
        ),
      ),
    );
    child.on("exit", (code, signal) =>
      this.fail(
        new AntigravityError(
          `agy exited (code ${code}, signal ${signal})`,
          ANTIGRAVITY_ERRORS.PROCESS_ERROR,
        ),
      ),
    );
  }

  /** Spawn `agy` and resolve once the process has started. */
  static start(
    args: string[],
    options: { cwd: string; env: NodeJS.ProcessEnv },
  ): Promise<AcpConnection> {
    return new Promise((resolve, reject) => {
      let child: ChildProcess;
      try {
        child = spawn("agy", args, {
          cwd: options.cwd,
          env: options.env,
          stdio: ["pipe", "pipe", "pipe"],
        });
      } catch (err) {
        reject(
          new AntigravityError(
            "Failed to start agy",
            ANTIGRAVITY_ERRORS.CLI_UNAVAILABLE,
            err,
          ),
        );
        return;
      }
      let started = false;
      child.on("spawn", () => {
        started = true;
        resolve(new AcpConnection(child));
      });
      child.on("error", (err) => {
        if (!started) {
          reject(
            new AntigravityError(
              "Failed to start agy",
              ANTIGRAVITY_ERRORS.CLI_UNAVAILABLE,
              err,
            ),
          );
        }
      });
    });
  }

  /**
   * Send a request and wait for its response. Rejects on timeout or when the
   * connection fails. A JSON-RPC error in the response is returned, not thrown.
   */
  call(
    method: string,
    params: unknown,
    timeoutMs: number,
  ): Promise<JsonRpcResponse> {
    if (this.failure) return Promise.reject(this.failure);
    const id = this.nextId++;
    return new Promise<JsonRpcResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new AntigravityError(
            `${method} timed out after ${timeoutMs} ms`,
            ANTIGRAVITY_ERRORS.TIMEOUT,
          ),
        );
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.write({ jsonrpc: "2.0", id, method, params });
    });
  }

  /** Stop the process: SIGTERM, then SIGKILL after a grace period. */
  async close(): Promise<void> {
    this.fail(
      new AntigravityError(
        "agy connection closed",
        ANTIGRAVITY_ERRORS.PROCESS_ERROR,
      ),
    );
    const child = this.child;
    if (
      child.pid === undefined ||
      child.exitCode !== null ||
      child.signalCode !== null
    ) {
      return;
    }
    const killTimer = setTimeout(() => child.kill("SIGKILL"), KILL_GRACE_MS);
    killTimer.unref();
    child.kill("SIGTERM");
    await this.exited;
    clearTimeout(killTimer);
  }

  private write(message: object): void {
    this.child.stdin?.write(JSON.stringify(message) + "\n");
  }

  private fail(error: AntigravityError): void {
    if (this.failure) return;
    this.failure = error;
    for (const [id, call] of this.pending) {
      this.pending.delete(id);
      clearTimeout(call.timer);
      call.reject(error);
    }
  }

  private onData(chunk: Buffer): void {
    // StringDecoder keeps a multi-byte character that is split across chunks
    // intact (Polish letters are two bytes in UTF-8).
    this.buffer += this.decoder.write(chunk);
    if (this.buffer.length > MAX_BUFFER_CHARS) {
      this.fail(
        new AntigravityError(
          "agy sent an oversized message",
          ANTIGRAVITY_ERRORS.PROCESS_ERROR,
        ),
      );
      return;
    }
    let newline = this.buffer.indexOf("\n");
    while (newline !== -1) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (line) this.onLine(line);
      newline = this.buffer.indexOf("\n");
    }
  }

  private onLine(line: string): void {
    let msg: JsonRpcMessage;
    try {
      msg = JSON.parse(line) as JsonRpcMessage;
    } catch {
      // Not logged: the line may contain user data.
      return;
    }
    if (!msg || typeof msg !== "object") return;

    if (typeof msg.method === "string") {
      if (msg.id !== undefined) {
        // A request from the agent. It must be answered under the same id.
        this.onAgentRequest(msg.id, msg.method, msg.params);
      } else if (msg.method === "session/update") {
        const update = (msg.params as { update?: AcpSessionUpdate } | undefined)
          ?.update;
        if (update) this.onSessionUpdate(update);
      }
      return;
    }

    if (msg.id !== undefined) {
      const call = this.pending.get(msg.id);
      if (!call) return;
      this.pending.delete(msg.id);
      clearTimeout(call.timer);
      call.resolve({ id: msg.id, result: msg.result, error: msg.error });
    }
  }

  private onAgentRequest(
    id: number | string,
    method: string,
    params: unknown,
  ): void {
    if (method === "session/request_permission") {
      // HealthLog grants no permissions. Choose a reject-once option when the
      // agent offers one. Otherwise answer "cancelled".
      const options =
        (params as { options?: AcpPermissionOption[] } | undefined)?.options ??
        [];
      const reject = options.find((o) => o.kind === "reject_once");
      const outcome = reject
        ? { outcome: "selected", optionId: reject.optionId }
        : { outcome: "cancelled" };
      this.write({ jsonrpc: "2.0", id, result: { outcome } });
      return;
    }
    this.write({
      jsonrpc: "2.0",
      id,
      error: { code: -32601, message: `Method not supported: ${method}` },
    });
  }
}

// ─── Request helpers ─────────────────────────────────────────

function childEnv(): NodeJS.ProcessEnv {
  // The project's ProcessEnv type requires NODE_ENV. The allowlist fills the rest.
  const env = {} as NodeJS.ProcessEnv;
  for (const key of CHILD_ENV_ALLOWLIST) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

/** The text of a message's content, with media parts left out. */
function textOf(content: AiMessage["content"]): string {
  if (typeof content === "string") return content;
  return content
    .filter(
      (part): part is Extract<AiContentPart, { type: "text" }> =>
        part.type === "text",
    )
    .map((part) => part.text)
    .join("\n");
}

/**
 * Turn the request into ACP prompt blocks: one text block (system prompt
 * followed by the conversation), then one block per attached image or PDF.
 */
function buildPromptBlocks(params: CompletionParams): AcpPromptBlock[] {
  const { messages } = params;
  const single = messages.length === 1 && messages[0].role === "user";
  const body = single
    ? textOf(messages[0].content)
    : messages
        .map((m) => `${ROLE_LABEL[m.role]}: ${textOf(m.content)}`)
        .join("\n\n");
  const text = [params.system, body].filter(Boolean).join("\n\n");

  const blocks: AcpPromptBlock[] = [];
  if (text) blocks.push({ type: "text", text });

  let documents = 0;
  for (const message of messages) {
    if (typeof message.content === "string") continue;
    for (const part of message.content) {
      if (part.type === "image") {
        blocks.push({
          type: "image",
          mimeType: part.mediaType,
          data: part.dataBase64,
        });
      } else if (part.type === "document") {
        documents += 1;
        blocks.push({
          type: "resource",
          resource: {
            uri: `healthlog://attachment-${documents}.pdf`,
            mimeType: part.mediaType,
            blob: part.dataBase64,
          },
        });
      }
    }
  }
  return blocks;
}

function cancelledError(): AntigravityError {
  return new AntigravityError(
    "Request cancelled",
    ANTIGRAVITY_ERRORS.CANCELLED,
  );
}

/** Unwrap a response, or throw with a generic message. The CLI text stays in originalError. */
function resultOrThrow<T>(
  response: JsonRpcResponse,
  code: string,
  label: string,
): T {
  if (response.error) {
    const authRequired = /authentication required/i.test(
      response.error.message,
    );
    throw new AntigravityError(
      label,
      authRequired ? ANTIGRAVITY_ERRORS.AUTH_REQUIRED : code,
      response.error,
    );
  }
  return response.result as T;
}

// ─── Client ──────────────────────────────────────────────────

interface AntigravityClientOptions {
  /**
   * Profile directory passed as `--app-data-dir`. Get it from
   * {@link antigravityProfileDir}. Without it the CLI uses the server login.
   */
  profileDir?: string;
  /** Prompt timeout used when the call does not set `timeoutMs`. */
  timeoutMs?: number;
}

export class AntigravityClient implements AIProvider {
  readonly type: ProviderType = "antigravity";
  /** ACP tools are the agent's own tools, not HealthLog function calling. */
  readonly supportsTools = false;

  constructor(private readonly options: AntigravityClientOptions = {}) {}

  async generateCompletion(
    params: CompletionParams,
  ): Promise<CompletionResult> {
    return this.run(params);
  }

  async generateCompletionStream(
    params: CompletionParams,
    onDelta: (delta: string) => void,
  ): Promise<CompletionResult> {
    return this.run(params, onDelta);
  }

  private async run(
    params: CompletionParams,
    onDelta?: (delta: string) => void,
  ): Promise<CompletionResult> {
    const { signal } = params;
    if (signal?.aborted) throw cancelledError();

    const blocks = buildPromptBlocks(params);
    const workDir = mkdtempSync(join(tmpdir(), "healthlog-acp-"));
    const state: { connection: AcpConnection | null; done: boolean } = {
      connection: null,
      done: false,
    };

    let onAbort: (() => void) | undefined;
    const cancelled = new Promise<never>((_, reject) => {
      onAbort = () => reject(cancelledError());
      signal?.addEventListener("abort", onAbort, { once: true });
    });
    // The race below handles the rejection. This keeps it from surfacing as
    // unhandled when the work finishes first.
    cancelled.catch(() => undefined);

    try {
      return await Promise.race([
        this.execute(workDir, blocks, params, onDelta, state),
        cancelled,
      ]);
    } finally {
      state.done = true;
      if (onAbort) signal?.removeEventListener("abort", onAbort);
      await state.connection?.close();
      rmSync(workDir, { recursive: true, force: true });
    }
  }

  private async execute(
    workDir: string,
    blocks: AcpPromptBlock[],
    params: CompletionParams,
    onDelta: ((delta: string) => void) | undefined,
    state: { connection: AcpConnection | null; done: boolean },
  ): Promise<CompletionResult> {
    const args = ["acp", "--sandbox", "--disable-telemetry"];
    if (this.options.profileDir) {
      args.push("--app-data-dir", this.options.profileDir);
    }

    const connection = await AcpConnection.start(args, {
      cwd: workDir,
      env: childEnv(),
    });
    state.connection = connection;
    if (state.done) {
      // The call was cancelled while the process was starting.
      await connection.close();
      throw cancelledError();
    }

    const chunks: string[] = [];
    connection.onSessionUpdate = (update) => {
      if (
        update.sessionUpdate === "agent_message_chunk" &&
        update.content?.type === "text" &&
        typeof update.content.text === "string"
      ) {
        chunks.push(update.content.text);
        onDelta?.(update.content.text);
      }
    };

    const init = resultOrThrow<AcpInitializeResult>(
      await connection.call(
        "initialize",
        {
          protocolVersion: PROTOCOL_VERSION,
          clientInfo: { name: "HealthLog", version: "1.0.0" },
        },
        SETUP_TIMEOUT_MS,
      ),
      ANTIGRAVITY_ERRORS.SESSION_FAILED,
      "Antigravity initialize failed",
    );

    const promptCaps = init?.capabilities?.promptCapabilities ?? {};
    if (blocks.some((b) => b.type === "image") && promptCaps.image !== true) {
      throw new AntigravityError(
        "Antigravity does not accept image input",
        ANTIGRAVITY_ERRORS.PROMPT_FAILED,
      );
    }
    if (
      blocks.some((b) => b.type === "resource") &&
      promptCaps.resourceBlob !== true
    ) {
      throw new AntigravityError(
        "Antigravity does not accept PDF input",
        ANTIGRAVITY_ERRORS.PROMPT_FAILED,
      );
    }

    const session = resultOrThrow<AcpSessionNewResult>(
      await connection.call(
        "session/new",
        { cwd: workDir, mcpServers: [] },
        SETUP_TIMEOUT_MS,
      ),
      ANTIGRAVITY_ERRORS.SESSION_FAILED,
      "Antigravity session could not be created",
    );
    if (typeof session?.sessionId !== "string") {
      throw new AntigravityError(
        "Antigravity session could not be created",
        ANTIGRAVITY_ERRORS.SESSION_FAILED,
      );
    }

    const timeoutMs =
      params.timeoutMs ?? this.options.timeoutMs ?? DEFAULT_PROMPT_TIMEOUT_MS;
    const response = await connection.call(
      "session/prompt",
      { sessionId: session.sessionId, prompt: blocks },
      timeoutMs,
    );
    if (response.error) {
      const quota = /quota/i.test(response.error.message);
      throw new AntigravityError(
        quota ? "Antigravity quota exceeded" : "Antigravity prompt failed",
        quota
          ? ANTIGRAVITY_ERRORS.QUOTA_EXCEEDED
          : ANTIGRAVITY_ERRORS.PROMPT_FAILED,
        response.error,
      );
    }

    const stopReason = (response.result as AcpPromptResult | undefined)
      ?.stopReason;
    if (stopReason === "cancelled") {
      throw new AntigravityError(
        "Antigravity cancelled the turn",
        ANTIGRAVITY_ERRORS.PROMPT_FAILED,
      );
    }
    const content = chunks.join("");
    if (!content) {
      throw new AntigravityError(
        "Antigravity returned an empty reply",
        ANTIGRAVITY_ERRORS.PROMPT_FAILED,
      );
    }

    return {
      content,
      tokensUsed: null,
      model: init?.agentInfo?.name ?? "antigravity",
      providerType: "antigravity",
      finishReason: stopReason === "max_tokens" ? "length" : "stop",
    };
  }
}
