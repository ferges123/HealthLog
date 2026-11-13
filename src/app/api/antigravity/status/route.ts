/**
 * GET /api/antigravity/status
 *
 * Returns the Antigravity CLI status for the authenticated user:
 * - CLI installation and version
 * - Saved configuration (profile ID, connection status, last test result)
 *
 * The connection status only changes through POST /api/antigravity/test, which
 * starts the CLI on the profile. This endpoint never claims a connection on its own.
 */
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { apiError, apiSuccess } from "@/lib/api-response";
import { prisma } from "@/lib/db";
import { antigravityChildEnv } from "@/lib/ai/antigravity-client";
import { execFile } from "child_process";
import { promisify } from "util";
import type { AntigravityConnectionStatus } from "../test/route";

export const dynamic = "force-dynamic";

const execFileAsync = promisify(execFile);

export interface AntigravityStatusResponse {
  /** Whether the CLI binary was found */
  cliInstalled: boolean;
  /** CLI version string, if available */
  cliVersion: string | null;
  /** Saved profile ID (not the path, just an opaque identifier) */
  profileId: string | null;
  /** Connection status from the last connection test */
  connectionStatus: AntigravityConnectionStatus;
  /** When the last successful connection test ran */
  connectedAt: string | null;
  /** Prompt input the CLI accepted in its last successful test */
  capabilities: {
    image: boolean;
    embeddedContext: boolean;
  } | null;
}

const CONNECTION_STATUSES: readonly AntigravityConnectionStatus[] = [
  "disconnected",
  "connected",
  "auth_required",
  "error",
];

function parseStatus(value: string): AntigravityConnectionStatus {
  return (CONNECTION_STATUSES as readonly string[]).includes(value)
    ? (value as AntigravityConnectionStatus)
    : "error";
}

export const GET = apiHandler(async () => {
  const { user: caller } = await requireAuth();

  // Check CLI installation. The child gets the same allowlisted environment as
  // the provider, so app secrets stay out of it.
  let cliInstalled = false;
  let cliVersion: string | null = null;

  try {
    const { stdout } = await execFileAsync("agy", ["--version"], {
      timeout: 5000,
      env: antigravityChildEnv(),
    });
    cliInstalled = true;
    // Version format: "agy version 1.5.8" or similar
    const match = stdout.match(/(\d+\.\d+\.\d+)/);
    if (match) {
      cliVersion = match[1];
    }
  } catch {
    // CLI not found or error
    cliInstalled = false;
  }

  const row = await prisma.user.findUnique({
    where: { id: caller.id },
    select: {
      antigravityProfileId: true,
      antigravityConnectionStatus: true,
      antigravityConnectedAt: true,
      antigravityCapabilitiesJson: true,
    },
  });

  if (!row) {
    return apiError("User not found", 404);
  }

  let capabilities: AntigravityStatusResponse["capabilities"] = null;
  const stored = row.antigravityCapabilitiesJson as {
    promptCapabilities?: { image?: boolean; embeddedContext?: boolean };
  } | null;
  if (stored?.promptCapabilities) {
    capabilities = {
      image: stored.promptCapabilities.image === true,
      embeddedContext: stored.promptCapabilities.embeddedContext === true,
    };
  }

  const response: AntigravityStatusResponse = {
    cliInstalled,
    cliVersion,
    profileId: row.antigravityProfileId,
    connectionStatus: parseStatus(row.antigravityConnectionStatus),
    connectedAt: row.antigravityConnectedAt?.toISOString() ?? null,
    capabilities,
  };

  return apiSuccess(response);
});
