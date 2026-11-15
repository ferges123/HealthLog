/**
 * POST /api/antigravity/disconnect
 *
 * Disconnects the Antigravity CLI provider for the authenticated user.
 *
 * This route:
 * 1. Clears the profile ID, the connection status and the stored capabilities
 * 2. Leaves the login files in the profile folder untouched
 * 3. Returns the folder path so the operator can delete the login on the host
 *
 * The CLI has no logout command, so HealthLog cannot revoke the login itself.
 */
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { apiSuccess } from "@/lib/api-response";
import { prisma } from "@/lib/db";
import { Prisma } from "@/generated/prisma/client";
import { forgetAntigravityCapabilities } from "@/lib/ai/antigravity-capability-cache";
import { envValue } from "@/lib/env";
import { join } from "path";

export interface AntigravityDisconnectResponse {
  /** Whether the disconnect was successful */
  success: boolean;
  /** Instructions for the user */
  instructions: string[];
}

export const dynamic = "force-dynamic";

export const POST = apiHandler(async () => {
  const { user: caller } = await requireAuth();
  const userId = caller.id;

  const existing = await prisma.user.findUnique({
    where: { id: userId },
    select: { antigravityProfileId: true },
  });

  await prisma.user.update({
    where: { id: userId },
    data: {
      antigravityProfileId: null,
      antigravityModel: null,
      antigravityConnectionStatus: "disconnected",
      antigravityConnectedAt: null,
      antigravityCapabilitiesJson: Prisma.DbNull,
    },
  });

  // Drop the in-process capabilities cache immediately, mirroring forgetCodexSignIn.
  forgetAntigravityCapabilities(userId);

  const profileRoot = envValue("ANTIGRAVITY_PROFILE_ROOT");
  const folder =
    profileRoot && existing?.antigravityProfileId
      ? join(profileRoot, existing.antigravityProfileId)
      : null;

  const instructions = [
    "HealthLog has disconnected from Antigravity.",
    "",
    "The login is still stored in the profile folder on the HealthLog host.",
    ...(folder
      ? ["To remove it, delete this folder on the host:", `   ${folder}`]
      : []),
  ];

  const response: AntigravityDisconnectResponse = {
    success: true,
    instructions,
  };

  return apiSuccess(response);
});
