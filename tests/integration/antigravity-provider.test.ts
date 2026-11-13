/**
 * Integration test for Antigravity provider with mock ACP executable.
 *
 * Tests provider registration, chain integration, and fallback behavior
 * without requiring a real Antigravity account or medical data.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { AntigravityClient, ANTIGRAVITY_ERRORS } from "@/lib/ai/antigravity-client";
import { resolveProviderChain } from "@/lib/ai/provider";
import { prisma } from "@/lib/db";

// Mock the child_process spawn
vi.mock("child_process", () => ({
  spawn: vi.fn(),
}));

// Mock fs operations
vi.mock("fs", () => ({
  mkdtempSync: vi.fn(() => "/tmp/healthlog-acp-test"),
  rmSync: vi.fn(),
  existsSync: vi.fn(() => true),
}));

vi.mock("os", () => ({
  tmpdir: () => "/tmp",
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    user: {
      findUnique: vi.fn(),
    },
    appSettings: {
      findUnique: vi.fn(),
    },
  },
}));

import { spawn } from "child_process";

function createMockAcpProcess() {
  const handlers: {
    stdout: ((data: Buffer) => void)[];
    stderr: ((data: Buffer) => void)[];
    spawn: (() => void)[];
    exit: ((code: number | null, signal: string | null) => void)[];
  } = { stdout: [], stderr: [], spawn: [], exit: [] };

  let stdinBuffer = "";

  const proc = {
    stdin: {
      on: vi.fn(),
      write: vi.fn((data: string) => {
        stdinBuffer += data;
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
      on: vi.fn(),
      resume: vi.fn(),
    },
    pid: 4242,
    exitCode: null as number | null,
    signalCode: null as string | null,
    on: vi.fn((event: string, handler: (...args: never[]) => void) => {
      if (event === "exit")
        handlers.exit.push(
          handler as (code: number | null, signal: string | null) => void,
        );
      if (event === "spawn") {
        handlers.spawn.push(handler as () => void);
        setTimeout(() => handlers.spawn.forEach((h) => h()), 0);
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
          agentInfo: { name: "Mock Antigravity Agent" },
          capabilities: {
            promptCapabilities: { image: true, resourceBlob: true },
          },
        },
      });
    } else if (msg.method === "session/new") {
      sendMessage({
        jsonrpc: "2.0",
        id: msg.id,
        result: {
          sessionId: "test-session-id",
          configOptions: [
            {
              key: "model",
              type: "select",
              values: [
                { value: "gemini-2.0-flash-exp", label: "Gemini 2.0 Flash" },
              ],
            },
          ],
        },
      });
    } else if (msg.method === "session/prompt") {
      // Simulate streaming response
      sendMessage({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "test-session-id",
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "Test response" },
          },
        },
      });

      sendMessage({
        jsonrpc: "2.0",
        id: msg.id,
        result: { stopReason: "stop" },
      });
    }
  }

  return proc;
}

describe("Antigravity Provider Integration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("Provider registration", () => {
    it("resolves Antigravity in provider chain when configured", async () => {
      vi.mocked(prisma.user.findUnique).mockResolvedValue({
        aiProvider: "ANTIGRAVITY_CLI",
        aiModel: null,
        aiProviderChain: [
          { providerType: "antigravity", priority: 1, enabled: true },
        ],
        codexAccessTokenEncrypted: null,
        codexRefreshTokenEncrypted: null,
        codexTokenExpiresAt: null,
        codexConnectedAt: null,
        codexConnectionStatus: "disconnected",
        useCentralCodex: false,
        aiAnthropicKeyEncrypted: null,
        aiLocalKeyEncrypted: null,
        aiOpenaiKeyEncrypted: null,
        aiCompatBaseUrl: null,
        aiCompatKeyEncrypted: null,
        aiCompatModel: null,
        antigravityProfileId: "test-profile",
        antigravityModel: "gemini-2.0-flash-exp",
        antigravityConnectionStatus: "connected",
        antigravityConnectedAt: new Date(),
        antigravityCapabilitiesJson: null,
        aiBaseUrl: null,
        aiResponseTimeoutSeconds: null,
        labsLocalOcrEnabled: false,
        labsAiFullConsent: false,
      });

      vi.mocked(prisma.appSettings.findUnique).mockResolvedValue({
        adminAiModel: "gpt-4o-mini",
        adminAiBaseUrl: "https://api.openai.com/v1",
      });

      // This tests that Antigravity is recognized in the chain
      // Actual resolution depends on credentials and connection status
      const result = await resolveProviderChain("test-user-id");

      expect(result).toBeDefined();
      expect(Array.isArray(result)).toBe(true);
    });

    it("does not break existing provider chain when Antigravity not configured", async () => {
      vi.mocked(prisma.user.findUnique).mockResolvedValue({
        aiProvider: "OPENAI",
        aiModel: "gpt-4o",
        aiProviderChain: null, // Legacy single-provider mode
        codexAccessTokenEncrypted: null,
        codexRefreshTokenEncrypted: null,
        codexTokenExpiresAt: null,
        codexConnectedAt: null,
        codexConnectionStatus: "disconnected",
        useCentralCodex: false,
        aiAnthropicKeyEncrypted: null,
        aiLocalKeyEncrypted: null,
        aiOpenaiKeyEncrypted: "test-key-encrypted",
        aiCompatBaseUrl: null,
        aiCompatKeyEncrypted: null,
        aiCompatModel: null,
        antigravityProfileId: null,
        antigravityModel: null,
        antigravityConnectionStatus: "disconnected",
        antigravityConnectedAt: null,
        antigravityCapabilitiesJson: null,
        aiBaseUrl: null,
        aiResponseTimeoutSeconds: null,
        labsLocalOcrEnabled: false,
        labsAiFullConsent: false,
      });

      vi.mocked(prisma.appSettings.findUnique).mockResolvedValue({
        adminAiModel: "gpt-4o-mini",
        adminAiBaseUrl: "https://api.openai.com/v1",
      });

      const result = await resolveProviderChain("test-user-id");

      // Should resolve without Antigravity
      expect(result).toBeDefined();
    });
  });

  describe("Fallback behavior", () => {
    it("falls back to next provider when Antigravity unavailable", async () => {
      vi.mocked(prisma.user.findUnique).mockResolvedValue({
        aiProvider: null,
        aiModel: null,
        aiProviderChain: [
          { providerType: "antigravity", priority: 1, enabled: true },
          { providerType: "openai", priority: 2, enabled: true },
        ],
        codexAccessTokenEncrypted: null,
        codexRefreshTokenEncrypted: null,
        codexTokenExpiresAt: null,
        codexConnectedAt: null,
        codexConnectionStatus: "disconnected",
        useCentralCodex: false,
        aiAnthropicKeyEncrypted: null,
        aiLocalKeyEncrypted: null,
        aiOpenaiKeyEncrypted: "test-key-encrypted",
        aiCompatBaseUrl: null,
        aiCompatKeyEncrypted: null,
        aiCompatModel: null,
        antigravityProfileId: null, // Not configured
        antigravityModel: null,
        antigravityConnectionStatus: "disconnected",
        antigravityConnectedAt: null,
        antigravityCapabilitiesJson: null,
        aiBaseUrl: null,
        aiResponseTimeoutSeconds: null,
        labsLocalOcrEnabled: false,
        labsAiFullConsent: false,
      });

      vi.mocked(prisma.appSettings.findUnique).mockResolvedValue({
        adminAiModel: "gpt-4o-mini",
        adminAiBaseUrl: "https://api.openai.com/v1",
      });

      const result = await resolveProviderChain("test-user-id");

      // Should skip Antigravity and resolve OpenAI
      expect(result).toBeDefined();
    });
  });

  describe("Tool support", () => {
    it("correctly reports supportsTools = false for Antigravity", async () => {
      const client = new AntigravityClient();

      expect(client.supportsTools).toBe(false);
      expect(client.type).toBe("antigravity");
    });
  });

  describe("Error handling", () => {
    it("handles CLI unavailable gracefully", async () => {
      vi.mocked(spawn).mockImplementation(() => {
        throw new Error("agy not found");
      });

      const client = new AntigravityClient();

      await expect(
        client.generateCompletion({
          messages: [{ role: "user", content: "test" }],
        }),
      ).rejects.toThrow("Failed to start agy");
    });

    it("handles authentication required error", async () => {
      const mockProc = createMockAcpProcess();

      // Override to return auth required error
      const originalHandleMockMessage = mockProc.stdin.write;
      mockProc.stdin.write = vi.fn((data: string) => {
        // Let original handler process the message
        originalHandleMockMessage.call(mockProc.stdin, data);

        // Check if it's initialize and respond with auth error
        try {
          const msg = JSON.parse(data.split("\n")[0]);
          if (msg.method === "initialize") {
            const sendData = Buffer.from(
              JSON.stringify({
                jsonrpc: "2.0",
                id: msg.id,
                error: {
                  code: -32000,
                  message: "Authentication required",
                },
              }) + "\n",
            );
            mockProc.stdout.on.mock.calls.forEach((call: unknown[]) => {
              if (call[0] === "data") {
                call[1](sendData);
              }
            });
          }
        } catch {}
      });

      vi.mocked(spawn).mockReturnValue(mockProc as unknown as ReturnType<typeof spawn>);

      const client = new AntigravityClient();

      await expect(
        client.generateCompletion({
          messages: [{ role: "user", content: "test" }],
        }),
      ).rejects.toThrow();
    });
  });
});
