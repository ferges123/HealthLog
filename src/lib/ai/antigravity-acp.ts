/**
 * The ACP connection to one `agy acp` child process: spawn, JSON-RPC over
 * stdio, the permission gate and a bounded close.
 *
 * The connection never logs what it reads. stderr can carry the prompt, the
 * paths or the account, so it is drained and dropped.
 *
 * @see antigravity-client.ts for the calls the provider makes on top of it.
 */
import { spawn, type ChildProcess } from "child_process";
import { StringDecoder } from "string_decoder";

import { ANTIGRAVITY_ERRORS, AntigravityError } from "./antigravity-errors";

/** How long a closing child gets after SIGTERM before SIGKILL. */
const KILL_GRACE_MS = 2_000;
/** Upper bound on one unparsed line. A runaway agent cannot grow memory without limit. */
const MAX_BUFFER_CHARS = 16 * 1024 * 1024;

interface JsonRpcError {
  code: number;
  message: string;
}

export interface JsonRpcResponse {
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

export interface AcpSessionUpdate {
  sessionUpdate: string;
  content?: { type?: string; text?: string };
}

interface AcpPermissionOption {
  optionId: string;
  kind: string;
}

// ─── One child process and its JSON-RPC connection ───────────

interface PendingCall {
  resolve: (response: JsonRpcResponse) => void;
  reject: (error: AntigravityError) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class AcpConnection {
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
    // ⚠ Use stdout 'close' (not child 'exit') so the fail() runs only after
    // the last stdout data has been flushed through onData. The 'exit' event
    // can fire before the final stdout bytes are delivered, which would reject
    // the pending session/prompt call before its response is read.
    child.stdout?.on("close", () =>
      this.fail(
        new AntigravityError(
          `agy stdout closed`,
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
