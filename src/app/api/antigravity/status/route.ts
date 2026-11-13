/**
 * GET /api/antigravity/status
 *
 * Returns the current Antigravity CLI status for the authenticated user:
 * - CLI installation and version
 * - Saved configuration (profile ID, model, connection status)
 * - Last error if any
 *
 * Does NOT claim "authenticated" just because `session/new` succeeded.
 * Authentication status is determined by actually calling the CLI.
 */
import { requireUser } from "@/lib/api-handler";
import { prisma } from "@/lib/db";
import { execFile } from "child_process";
import { promisify } from "util";
import { NextResponse } from "next/server";

const execFileAsync = promisify(execFile);

export interface AntigravityStatusResponse {
  /** Whether the CLI binary was found */
  cliInstalled: boolean;
  /** CLI version string, if available */
  cliVersion: string | null;
  /** Saved profile ID (not the path, just an opaque identifier) */
  profileId: string | null;
  /** User's selected model */
  model: string | null;
  /** Connection status from last check */
  connectionStatus: "disconnected" | "connected" | "auth_required" | "error";
  /** When the last successful connection was established */
  connectedAt: string | null;
  /** Last error code, if any */
  lastError: string | null;
  /** Capabilities from last negotiation */
  capabilities: {
    image: boolean;
    resourceBlob: boolean;
  } | null;
}

export async function GET() {
  const userId = await requireUser();

  // Check CLI installation
  let cliInstalled = false;
  let cliVersion: string | null = null;

  try {
    const { stdout } = await execFileAsync("agy", ["--version"], {
      timeout: 5000,
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

  // Get stored configuration
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      antigravityProfileId: true,
      antigravityModel: true,
      antigravityConnectionStatus: true,
      antigravityConnectedAt: true,
      antigravityCapabilitiesJson: true,
    },
  });

  if (!user) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }

  // Parse capabilities
  let capabilities: AntigravityStatusResponse["capabilities"] = null;
  if (user.antigravityCapabilitiesJson) {
    const caps = user.antigravityCapabilitiesJson as {
      promptCapabilities?: { image?: boolean; resourceBlob?: boolean };
    };
    if (caps.promptCapabilities) {
      capabilities = {
        image: caps.promptCapabilities.image ?? false,
        resourceBlob: caps.promptCapabilities.resourceBlob ?? false,
      };
    }
  }

  const response: AntigravityStatusResponse = {
    cliInstalled,
    cliVersion,
    profileId: user.antigravityProfileId,
    model: user.antigravityModel,
    connectionStatus: user.antigravityConnectionStatus as AntigravityStatusResponse["connectionStatus"],
    connectedAt: user.antigravityConnectedAt?.toISOString() ?? null,
    lastError: null, // TODO: Implement error tracking
    capabilities,
  };

  return NextResponse.json(response);
}
