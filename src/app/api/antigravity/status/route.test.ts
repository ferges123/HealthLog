import { describe, it, expect, vi, beforeEach } from "vitest";
import { GET } from "./route";

// Mock dependencies
vi.mock("@/lib/api-handler", () => ({
  requireUser: vi.fn(() => Promise.resolve("test-user-id")),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    user: {
      findUnique: vi.fn(),
    },
  },
}));

vi.mock("child_process", () => ({
  execFile: vi.fn((cmd: string, args: string[], options: unknown, callback: (err: unknown, result: { stdout: string }) => void) => {
    if (cmd === "agy" && args[0] === "--version") {
      callback(null, { stdout: "agy version 1.5.8\n" });
    }
  }),
}));

import { requireUser } from "@/lib/api-handler";
import { prisma } from "@/lib/db";

describe("/api/antigravity/status", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns CLI installed status", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      antigravityProfileId: null,
      antigravityModel: null,
      antigravityConnectionStatus: "disconnected",
      antigravityConnectedAt: null,
      antigravityCapabilitiesJson: null,
    });

    const response = await GET();
    const data = await response.json();

    expect(data.cliInstalled).toBe(true);
    expect(data.cliVersion).toBe("1.5.8");
    expect(data.connectionStatus).toBe("disconnected");
  });

  it("returns stored configuration", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      antigravityProfileId: "abc123",
      antigravityModel: "gemini-2.0-flash-exp",
      antigravityConnectionStatus: "connected",
      antigravityConnectedAt: new Date("2024-01-01T00:00:00Z"),
      antigravityCapabilitiesJson: {
        promptCapabilities: { image: true, resourceBlob: true },
      },
    });

    const response = await GET();
    const data = await response.json();

    expect(data.profileId).toBe("abc123");
    expect(data.model).toBe("gemini-2.0-flash-exp");
    expect(data.connectionStatus).toBe("connected");
    expect(data.connectedAt).toBe("2024-01-01T00:00:00.000Z");
    expect(data.capabilities).toEqual({
      image: true,
      resourceBlob: true,
    });
  });

  it("returns 404 for non-existent user", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue(null);

    const response = await GET();

    expect(response.status).toBe(404);
  });
});
