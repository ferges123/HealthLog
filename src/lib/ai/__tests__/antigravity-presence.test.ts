/**
 * Antigravity provider presence: `embeddedContext` capability wired into
 * the document-pick vision flag.
 *
 * The `antigravityCapabilitiesJson` stored in the user row (written by the
 * connection test route at `/api/antigravity/test`) controls whether
 * `probeProviderChain` marks the antigravity entry as vision-capable.
 * Only when `promptCapabilities.embeddedContext === true` does the entry
 * get `vision: true`, making `documentPick` able to select it.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    appSettings: { findUnique: vi.fn() },
  },
}));
vi.mock("@/lib/crypto", () => ({
  decrypt: vi.fn(() => {
    throw new Error("the presence probe must never decrypt");
  }),
  encrypt: vi.fn(),
}));
vi.mock("../antigravity-client", () => ({
  antigravityAvailable: vi.fn(() => true),
}));

import { prisma } from "@/lib/db";
import { probeProviderChain, probeProviderPresence } from "../provider";
import type { ProviderWorkAuthority } from "@/lib/sharing/provider-work-authority";

const OWNER: ProviderWorkAuthority = {
  origin: "owner",
  recordUserId: "u1",
  actorUserId: "u1",
  grantId: null,
};

/** A minimal row that has antigravity connected with a valid profile. */
function agyRow(overrides: Record<string, unknown> = {}) {
  return {
    aiProvider: null,
    aiProviderChain: [{ providerType: "antigravity", enabled: true, priority: 0 }],
    aiAnthropicKeyEncrypted: null,
    aiLocalKeyEncrypted: null,
    aiOpenaiKeyEncrypted: null,
    aiBaseUrl: null,
    aiCompatBaseUrl: null,
    aiCompatModel: null,
    aiModel: null,
    antigravityProfileId: "aabbccddeeff00112233445566778899",
    antigravityConnectionStatus: "connected",
    antigravityCapabilitiesJson: null,
    codexConnectionStatus: null,
    codexAccessTokenEncrypted: null,
    codexRefreshTokenEncrypted: null,
    useCentralCodex: false,
    managedProfileAt: null,
    labsLocalOcrEnabled: false,
    aiResponseTimeoutSeconds: null,
    ...overrides,
  };
}

function emptySettings() {
  return {
    adminAiKeyEncrypted: null,
    adminAiModel: null,
    adminAiBaseUrl: null,
    adminCodexConnectionStatus: null,
    adminCodexAccessTokenEncrypted: null,
    adminCodexRefreshTokenEncrypted: null,
    adminCodexAccountIdEncrypted: null,
  };
}

function load(user: unknown, app: unknown = emptySettings()) {
  vi.mocked(prisma.user.findUnique).mockResolvedValue(user as never);
  vi.mocked(prisma.appSettings.findUnique).mockResolvedValue(app as never);
}

beforeEach(() => {
  vi.mocked(prisma.user.findUnique).mockReset();
  vi.mocked(prisma.appSettings.findUnique).mockReset();
});

describe("antigravity presence: embeddedContext wired into vision flag", () => {
  it("sets vision:false when antigravityCapabilitiesJson is null", async () => {
    load(agyRow({ antigravityCapabilitiesJson: null }));
    const presence = await probeProviderChain("u1", OWNER);
    expect(presence.entries).toEqual([
      { providerType: "antigravity", vision: false },
    ]);
  });

  it("sets vision:false when capabilities JSON has embeddedContext:false", async () => {
    load(
      agyRow({
        antigravityCapabilitiesJson: {
          promptCapabilities: { image: true, embeddedContext: false },
        },
      }),
    );
    const presence = await probeProviderChain("u1", OWNER);
    expect(presence.entries).toEqual([
      { providerType: "antigravity", vision: false },
    ]);
  });

  it("sets vision:false when capabilities JSON is missing promptCapabilities", async () => {
    load(agyRow({ antigravityCapabilitiesJson: {} }));
    const presence = await probeProviderChain("u1", OWNER);
    expect(presence.entries).toEqual([
      { providerType: "antigravity", vision: false },
    ]);
  });

  it("sets vision:true when embeddedContext is true", async () => {
    load(
      agyRow({
        antigravityCapabilitiesJson: {
          promptCapabilities: { image: true, embeddedContext: true },
        },
      }),
    );
    const presence = await probeProviderChain("u1", OWNER);
    expect(presence.entries).toEqual([
      { providerType: "antigravity", vision: true },
    ]);
  });

  it("probeProviderPresence returns true for 'document' when embeddedContext is true", async () => {
    load(
      agyRow({
        antigravityCapabilitiesJson: {
          promptCapabilities: { image: false, embeddedContext: true },
        },
      }),
    );
    expect(await probeProviderPresence("u1", "document")).toBe(true);
  });

  it("probeProviderPresence returns false for 'document' when embeddedContext is false", async () => {
    load(
      agyRow({
        antigravityCapabilitiesJson: {
          promptCapabilities: { image: true, embeddedContext: false },
        },
      }),
    );
    expect(await probeProviderPresence("u1", "document")).toBe(false);
  });

  it("probeProviderPresence returns false for 'document' when capabilities JSON is null", async () => {
    load(agyRow({ antigravityCapabilitiesJson: null }));
    expect(await probeProviderPresence("u1", "document")).toBe(false);
  });

  it("sets vision:false when antigravity is not connected", async () => {
    load(
      agyRow({
        antigravityConnectionStatus: "disconnected",
        antigravityCapabilitiesJson: {
          promptCapabilities: { embeddedContext: true },
        },
      }),
    );
    // The entry never makes it into the chain (credentialPresent returns false)
    // so entries is empty.
    const presence = await probeProviderChain("u1", OWNER);
    expect(presence.entries).toEqual([]);
  });
});
