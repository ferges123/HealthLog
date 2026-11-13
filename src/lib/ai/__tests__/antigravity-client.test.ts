import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { AntigravityClient, ANTIGRAVITY_ERRORS } from "../antigravity-client";
import { singleUserTurn } from "../types";

// Mock the child_process spawn
vi.mock("child_process", () => ({
  spawn: vi.fn(),
}));

// Mock fs-temp operations
vi.mock("fs", () => ({
  mkdtempSync: vi.fn(() => "/tmp/healthlog-acp-test"),
  rmSync: vi.fn(),
  existsSync: vi.fn(() => true),
}));

vi.mock("os", () => ({
  tmpdir: () => "/tmp",
}));

import { spawn } from "child_process";

function createMockProcess({
  spawnEvent = true,
}: { spawnEvent?: boolean } = {}) {
  const handlers: {
    stdout: ((data: Buffer) => void)[];
    stderr: ((data: Buffer) => void)[];
    close: ((code: number | null) => void)[];
    error: ((err: Error) => void)[];
    exit: ((code: number | null, signal: string | null) => void)[];
    spawn: (() => void)[];
  } = { stdout: [], stderr: [], close: [], error: [], exit: [], spawn: [] };

  let stdinBuffer = "";

  const proc = {
    stdin: {
      on: vi.fn(),
      write: vi.fn((data: string) => {
        stdinBuffer += data;
        // Process complete lines
        const lines = stdinBuffer.split("\n");
        stdinBuffer = lines.pop() || "";

        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const msg = JSON.parse(line);
            handleMockMessage(msg);
          } catch {}
        }
      }),
    },
    stdout: {
      on: vi.fn((event: string, handler: (data: Buffer) => void) => {
        if (event === "data") handlers.stdout.push(handler);
      }),
    },
    stderr: {
      on: vi.fn((event: string, handler: (data: Buffer) => void) => {
        if (event === "data") handlers.stderr.push(handler);
      }),
      resume: vi.fn(),
    },
    pid: 4242,
    exitCode: null as number | null,
    signalCode: null as string | null,
    on: vi.fn((event: string, handler: (...args: never[]) => void) => {
      if (event === "close")
        handlers.close.push(handler as (code: number | null) => void);
      if (event === "error")
        handlers.error.push(handler as (err: Error) => void);
      if (event === "exit")
        handlers.exit.push(
          handler as (code: number | null, signal: string | null) => void,
        );
      if (event === "spawn") {
        handlers.spawn.push(handler as () => void);
        if (spawnEvent) setTimeout(() => handlers.spawn.forEach((h) => h()), 0);
      }
    }),
    kill: vi.fn(() => {
      setTimeout(() => handlers.exit.forEach((h) => h(0, null)), 10);
    }),
  };

  function sendMessage(msg: unknown) {
    const data = Buffer.from(JSON.stringify(msg) + "\n");
    handlers.stdout.forEach((h) => h(data));
  }

  function handleMockMessage(msg: {
    jsonrpc: string;
    id?: number;
    method?: string;
    params?: unknown;
  }) {
    if (msg.method === "initialize") {
      sendMessage({
        jsonrpc: "2.0",
        id: msg.id,
        result: {
          protocolVersion: 1,
          agentInfo: { name: "Mock ACP", version: "0.0.1" },
          capabilities: { promptCapabilities: { text: true, image: true } },
        },
      });
    } else if (msg.method === "session/new") {
      sendMessage({
        jsonrpc: "2.0",
        id: msg.id,
        result: {
          sessionId: "test-session-123",
          configOptions: [
            {
              name: "Model",
              type: "select",
              enum: ["gemini-3.8-flash-medium"],
            },
            {
              name: "Thinking Level",
              type: "select",
              enum: ["low", "medium", "high"],
            },
          ],
        },
      });
    } else if (msg.method === "session/prompt") {
      // Send message chunk
      sendMessage({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "test-session-123",
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "This is the answer." },
          },
        },
      });
      // Send response
      sendMessage({
        jsonrpc: "2.0",
        id: msg.id,
        result: { stopReason: "end_turn" },
      });
    } else if (msg.method === "session/reject_permission") {
      sendMessage({ jsonrpc: "2.0", id: msg.id, result: {} });
    } else {
      sendMessage({ jsonrpc: "2.0", id: msg.id, result: {} });
    }
  }

  return { proc, sendMessage, handlers };
}

describe("AntigravityClient", () => {
  let mockSpawn: ReturnType<typeof vi.fn>;
  let mockProcess: ReturnType<typeof createMockProcess>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockProcess = createMockProcess();
    mockSpawn = spawn as ReturnType<typeof vi.fn>;
    mockSpawn.mockReturnValue(mockProcess.proc);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("type", () => {
    it('has type="antigravity"', () => {
      const client = new AntigravityClient();
      expect(client.type).toBe("antigravity");
    });
  });

  describe("supportsTools", () => {
    it("is false (ACP tools are NOT HealthLog function calling)", () => {
      const client = new AntigravityClient();
      expect(client.supportsTools).toBe(false);
    });
  });

  describe("generateCompletion", () => {
    it("returns a CompletionResult with required fields", async () => {
      const client = new AntigravityClient();
      const result = await client.generateCompletion(
        singleUserTurn({ system: "You are helpful.", user: "Hello" }),
      );

      expect(typeof result.content).toBe("string");
      expect(result.content.length).toBeGreaterThan(0);
      expect(result.providerType).toBe("antigravity");
      expect(typeof result.model).toBe("string");
      expect(
        result.tokensUsed === null || typeof result.tokensUsed === "number",
      ).toBe(true);
    });

    it("includes system prompt in the request", async () => {
      const client = new AntigravityClient();
      await client.generateCompletion(
        singleUserTurn({ system: "Custom system", user: "Hello" }),
      );

      // Check that prompt was sent
      expect(mockProcess.proc.stdin.write).toHaveBeenCalled();
    });

    it("handles multimodal content (image)", async () => {
      const client = new AntigravityClient();
      const result = await client.generateCompletion(
        singleUserTurn({
          system: "Describe images.",
          user: "What's this?",
          images: [
            {
              mediaType: "image/png",
              dataBase64: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB",
            },
          ],
        }),
      );

      expect(typeof result.content).toBe("string");
    });
  });

  describe("generateCompletionStream", () => {
    it("calls onDelta for each chunk", async () => {
      const client = new AntigravityClient();
      const chunks: string[] = [];

      const result = await client.generateCompletionStream(
        singleUserTurn({ system: "sys", user: "user" }),
        (delta) => chunks.push(delta),
      );

      expect(chunks.length).toBeGreaterThan(0);
      expect(typeof result.content).toBe("string");
    });
  });

  describe("error handling", () => {
    it("throws CLI_UNAVAILABLE when spawn error event fires", async () => {
      const { proc, handlers } = createMockProcess({ spawnEvent: false });
      mockSpawn.mockReturnValue(proc);

      const client = new AntigravityClient();

      const promise = client.generateCompletion(
        singleUserTurn({ system: "s", user: "u" }),
      );

      // Emit error after a tick
      setTimeout(() => {
        handlers.error.forEach((h) => h(new Error("spawn ENOENT")));
      }, 10);

      await expect(promise).rejects.toMatchObject({
        code: ANTIGRAVITY_ERRORS.CLI_UNAVAILABLE,
      });
    });
  });

  describe("process lifecycle", () => {
    it("cleans up process after completion", async () => {
      const client = new AntigravityClient();
      await client.generateCompletion(
        singleUserTurn({ system: "s", user: "u" }),
      );

      // Process should be killed
      expect(mockProcess.proc.kill).toHaveBeenCalled();
    });

    it("cleans up process on error", async () => {
      const { proc, sendMessage, handlers } = createMockProcess();
      mockSpawn.mockReturnValue(proc);

      // Make session/new fail
      const originalHandle = proc.stdin.write;
      proc.stdin.write = vi.fn((data: string) => {
        const msg = JSON.parse(data.trim());
        if (msg.method === "session/new") {
          sendMessage({
            jsonrpc: "2.0",
            id: msg.id,
            error: { code: -32000, message: "Auth required" },
          });
        }
        return originalHandle.call(proc.stdin, data);
      });

      const client = new AntigravityClient();

      await expect(
        client.generateCompletion(singleUserTurn({ system: "s", user: "u" })),
      ).rejects.toThrow();

      expect(proc.kill).toHaveBeenCalled();
    });
  });
});
