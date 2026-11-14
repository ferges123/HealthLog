import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  AntigravityClient,
  ANTIGRAVITY_ERRORS,
  modelOptionsOf,
} from "../antigravity-client";
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
const TEST_PROFILE = {
  geminiDir: "/var/lib/healthlog/antigravity/user-1",
};
/** The model selector, in the shape ACP session configOptions define. */
const MODEL_OPTION = {
  id: "model",
  name: "Model",
  category: "model",
  type: "select",
  currentValue: "model-fast",
  options: [
    { value: "model-fast", name: "Fast" },
    { value: "model-pro", name: "Pro" },
  ],
};
const DEFAULT_CONFIG_OPTIONS: unknown[] = [MODEL_OPTION];
function createMockProcess({
  spawnEvent = true,
  configOptions = DEFAULT_CONFIG_OPTIONS,
  setConfigFails = false,
}: {
  spawnEvent?: boolean;
  configOptions?: unknown[];
  setConfigFails?: boolean;
} = {}) {
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
          agentCapabilities: {
            promptCapabilities: { image: true, embeddedContext: true },
          },
        },
      });
    } else if (msg.method === "session/new") {
      sendMessage({
        jsonrpc: "2.0",
        id: msg.id,
        result: {
          sessionId: "test-session-123",
          configOptions,
        },
      });
    } else if (msg.method === "session/set_config_option") {
      if (setConfigFails) {
        sendMessage({
          jsonrpc: "2.0",
          id: msg.id,
          error: { code: -32602, message: "Invalid value" },
        });
      } else {
        sendMessage({
          jsonrpc: "2.0",
          id: msg.id,
          result: { configOptions },
        });
      }
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
      const client = new AntigravityClient({ profile: TEST_PROFILE });
      expect(client.type).toBe("antigravity");
    });
  });
  describe("supportsTools", () => {
    it("is false (ACP tools are NOT HealthLog function calling)", () => {
      const client = new AntigravityClient({ profile: TEST_PROFILE });
      expect(client.supportsTools).toBe(false);
    });
  });
  describe("generateCompletion", () => {
    it("returns a CompletionResult with required fields", async () => {
      const client = new AntigravityClient({ profile: TEST_PROFILE });
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
      const client = new AntigravityClient({ profile: TEST_PROFILE });
      await client.generateCompletion(
        singleUserTurn({ system: "Custom system", user: "Hello" }),
      );
      // Check that prompt was sent
      expect(mockProcess.proc.stdin.write).toHaveBeenCalled();
    });
    it("handles multimodal content (image)", async () => {
      const client = new AntigravityClient({ profile: TEST_PROFILE });
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
      const client = new AntigravityClient({ profile: TEST_PROFILE });
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
      const client = new AntigravityClient({ profile: TEST_PROFILE });
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
      const client = new AntigravityClient({ profile: TEST_PROFILE });
      await client.generateCompletion(
        singleUserTurn({ system: "s", user: "u" }),
      );
      // Process should be killed
      expect(mockProcess.proc.kill).toHaveBeenCalled();
    });
    it("cleans up process on error", async () => {
      const { proc, sendMessage } = createMockProcess();
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
      const client = new AntigravityClient({ profile: TEST_PROFILE });
      await expect(
        client.generateCompletion(singleUserTurn({ system: "s", user: "u" })),
      ).rejects.toThrow();
      expect(proc.kill).toHaveBeenCalled();
    });
  });
  describe("tool suppression", () => {
    it("appends the no-tool hint to the system prompt sent to agy", async () => {
      const client = new AntigravityClient({ profile: TEST_PROFILE });
      await client.generateCompletion(
        singleUserTurn({ system: "You are a coach.", user: "Cześć" }),
      );
      const msgs = sentMessages(mockProcess.proc.stdin.write);
      const promptMsg = msgs.find((m) => m.method === "session/prompt");
      expect(promptMsg).toBeDefined();
      const blocks = (promptMsg?.params as { prompt?: unknown[] })?.prompt;
      const textBlock = (
        blocks as Array<{ type: string; text?: string }> | undefined
      )?.find((b) => b.type === "text");
      expect(textBlock?.text).toContain("You are a coach.");
      expect(textBlock?.text).toContain(
        "Do not use any internal tools, planning steps, or execution steps",
      );
    });
    it("includes the hint even when no system prompt is provided", async () => {
      const client = new AntigravityClient({ profile: TEST_PROFILE });
      await client.generateCompletion(singleUserTurn({ user: "Hi" }));
      const msgs = sentMessages(mockProcess.proc.stdin.write);
      const promptMsg = msgs.find((m) => m.method === "session/prompt");
      const blocks = (promptMsg?.params as { prompt?: unknown[] })?.prompt;
      const textBlock = (
        blocks as Array<{ type: string; text?: string }> | undefined
      )?.find((b) => b.type === "text");
      expect(textBlock?.text).toContain(
        "Do not use any internal tools, planning steps, or execution steps",
      );
    });
    it("throws PROMPT_FAILED when agy returns end_turn with no content", async () => {
      // Simulate the Step_Generic scenario: session/prompt returns end_turn
      // with no preceding agent_message_chunk notifications.
      const { proc, sendMessage } = createMockProcess();
      (proc.stdin.write as ReturnType<typeof vi.fn>).mockImplementation(
        (data: string) => {
          const lines = data.split("\n").filter((l) => l.trim());
          for (const line of lines) {
            const msg = JSON.parse(line) as {
              method?: string;
              id?: number;
              params?: unknown;
            };
            if (msg.method === "initialize") {
              sendMessage({
                jsonrpc: "2.0",
                id: msg.id,
                result: {
                  protocolVersion: 1,
                  agentInfo: { name: "Mock ACP", version: "0.0.1" },
                  agentCapabilities: {
                    promptCapabilities: { image: true, embeddedContext: true },
                  },
                },
              });
            } else if (msg.method === "session/new") {
              sendMessage({
                jsonrpc: "2.0",
                id: msg.id,
                result: { sessionId: "empty-session", configOptions: [] },
              });
            } else if (msg.method === "session/prompt") {
              // No agent_message_chunk — only the completion signal
              sendMessage({
                jsonrpc: "2.0",
                id: msg.id,
                result: { stopReason: "end_turn" },
              });
            }
          }
        },
      );
      mockSpawn.mockReturnValue(proc);
      const client = new AntigravityClient({ profile: TEST_PROFILE });
      await expect(
        client.generateCompletion(singleUserTurn({ user: "Cześć" })),
      ).rejects.toMatchObject({ code: ANTIGRAVITY_ERRORS.PROMPT_FAILED });
    });
  });
});
/** Every JSON-RPC message the client wrote to the child's stdin, in order. */
function sentMessages(
  write: unknown,
): { id?: number; method?: string; params?: Record<string, unknown> }[] {
  const calls = (write as { mock: { calls: unknown[][] } }).mock.calls;
  return calls.flatMap(([data]) =>
    String(data)
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line)),
  );
}
describe("modelOptionsOf", () => {
  it("reads the model selector from the ACP configOptions shape", () => {
    expect(modelOptionsOf([MODEL_OPTION])).toEqual({
      configId: "model",
      models: [
        { id: "model-fast", name: "Fast" },
        { id: "model-pro", name: "Pro" },
      ],
      currentModel: "model-fast",
    });
  });
  it("flattens grouped options", () => {
    const grouped = {
      ...MODEL_OPTION,
      options: [
        {
          group: "Google",
          options: [{ value: "model-pro", name: "Pro" }],
        },
      ],
    };
    expect(modelOptionsOf([grouped])?.models).toEqual([
      { id: "model-pro", name: "Pro" },
    ]);
  });
  it("matches by id when the category is missing", () => {
    const byId = { ...MODEL_OPTION, category: undefined };
    expect(modelOptionsOf([byId])?.configId).toBe("model");
  });
  it("skips entries without a string value and names models by value when unnamed", () => {
    const option = {
      ...MODEL_OPTION,
      options: [{ value: "model-x" }, { value: 7 }, { name: "No value" }],
    };
    expect(modelOptionsOf([option])?.models).toEqual([
      { id: "model-x", name: "model-x" },
    ]);
  });
  it("returns null when the CLI offers no model selector", () => {
    expect(modelOptionsOf([{ id: "mode", type: "select" }])).toBeNull();
    expect(modelOptionsOf(undefined)).toBeNull();
  });
});
describe("AntigravityClient model selection", () => {
  let mockSpawn: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    vi.clearAllMocks();
    mockSpawn = spawn as ReturnType<typeof vi.fn>;
  });
  it("sets the chosen model before the prompt is sent", async () => {
    const { proc } = createMockProcess();
    mockSpawn.mockReturnValue(proc);
    const client = new AntigravityClient({
      profile: TEST_PROFILE,
      model: "model-pro",
    });
    const result = await client.generateCompletion(
      singleUserTurn({ system: "s", user: "u" }),
    );
    const methods = sentMessages(proc.stdin.write).map((m) => m.method);
    const setAt = methods.indexOf("session/set_config_option");
    expect(setAt).toBeGreaterThan(methods.indexOf("session/new"));
    expect(setAt).toBeLessThan(methods.indexOf("session/prompt"));
    const setCall = sentMessages(proc.stdin.write).find(
      (m) => m.method === "session/set_config_option",
    );
    expect(setCall?.params).toEqual({
      sessionId: "test-session-123",
      configId: "model",
      value: "model-pro",
    });
    expect(result.model).toBe("model-pro");
  });
  it("keeps the CLI default and reports its model when no model is chosen", async () => {
    const { proc } = createMockProcess();
    mockSpawn.mockReturnValue(proc);
    const client = new AntigravityClient({ profile: TEST_PROFILE });
    const result = await client.generateCompletion(
      singleUserTurn({ system: "s", user: "u" }),
    );
    const methods = sentMessages(proc.stdin.write).map((m) => m.method);
    expect(methods).not.toContain("session/set_config_option");
    expect(result.model).toBe("model-fast");
  });
  it("does not send a change when the chosen model is already the current one", async () => {
    const { proc } = createMockProcess();
    mockSpawn.mockReturnValue(proc);
    const client = new AntigravityClient({
      profile: TEST_PROFILE,
      model: "model-fast",
    });
    await client.generateCompletion(singleUserTurn({ system: "s", user: "u" }));
    const methods = sentMessages(proc.stdin.write).map((m) => m.method);
    expect(methods).not.toContain("session/set_config_option");
  });
  it("fails before the prompt when the CLI does not offer the chosen model", async () => {
    const { proc } = createMockProcess();
    mockSpawn.mockReturnValue(proc);
    const client = new AntigravityClient({
      profile: TEST_PROFILE,
      model: "model-retired",
    });
    await expect(
      client.generateCompletion(singleUserTurn({ system: "s", user: "u" })),
    ).rejects.toMatchObject({ code: ANTIGRAVITY_ERRORS.MODEL_UNAVAILABLE });
    const methods = sentMessages(proc.stdin.write).map((m) => m.method);
    expect(methods).not.toContain("session/prompt");
    expect(proc.kill).toHaveBeenCalled();
  });
  it("fails before the prompt when the CLI rejects the model change", async () => {
    const { proc } = createMockProcess({ setConfigFails: true });
    mockSpawn.mockReturnValue(proc);
    const client = new AntigravityClient({
      profile: TEST_PROFILE,
      model: "model-pro",
    });
    await expect(
      client.generateCompletion(singleUserTurn({ system: "s", user: "u" })),
    ).rejects.toMatchObject({ code: ANTIGRAVITY_ERRORS.SESSION_FAILED });
    const methods = sentMessages(proc.stdin.write).map((m) => m.method);
    expect(methods).not.toContain("session/prompt");
  });
  it("fails when the CLI offers no model selector at all", async () => {
    const { proc } = createMockProcess({ configOptions: [] });
    mockSpawn.mockReturnValue(proc);
    const client = new AntigravityClient({
      profile: TEST_PROFILE,
      model: "model-pro",
    });
    await expect(
      client.generateCompletion(singleUserTurn({ system: "s", user: "u" })),
    ).rejects.toMatchObject({ code: ANTIGRAVITY_ERRORS.MODEL_UNAVAILABLE });
  });
});
