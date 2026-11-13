/**
 * POST /api/antigravity/disconnect
 *
 * Disconnects the Antigravity CLI provider for the authenticated user.
 *
 * This route:
 * 1. Clears the stored connection status and metadata
 * 2. Does NOT delete the Antigravity account (that's done via `agy logout`)
 * 3. Does NOT claim to have logged out from the CLI
 * 4. Optionally instructs user to run `agy logout` if they want to revoke CLI access
 *
 * IMPORTANT: The credential state in the CLI's own store is unchanged.
 * HealthLog only forgets the profile ID and connection status.
 */
import { requireUser } from "@/lib/api-handler";
import { prisma } from "@/lib/db";
import { NextResponse } from "next/server";

export interface AntigravityDisconnectResponse {
  /** Whether the disconnect was successful */
  success: boolean;
  /** Instructions for the user */
  instructions: string[];
}

export async function POST() {
  const userId = await requireUser();

  // Clear Antigravity configuration from database
  await prisma.user.update({
    where: { id: userId },
    data: {
      antigravityProfileId: null,
      antigravityModel: null,
      antigravityConnectionStatus: "disconnected",
      antigravityConnectedAt: null,
      antigravityCapabilitiesJson: null,
    },
  });

  const instructions = [
    "HealthLog has disconnected from Antigravity.",
    "",
    "Your Antigravity account credentials are still stored by the CLI.",
    "To revoke CLI access completely, run:",
    "   agy logout",
    "",
    "This will remove all stored credentials from the CLI.",
  ];

  const response: AntigravityDisconnectResponse = {
    success: true,
    instructions,
  };

  return NextResponse.json(response);
}
