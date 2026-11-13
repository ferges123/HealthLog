/**
 * POST /api/antigravity/test
 *
 * Connection test for the user's Antigravity profile. It starts the CLI on that
 * profile and opens a session. No prompt and no health data are sent. The
 * outcome is stored on the user record, so the status endpoint reports it.
 */
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { apiSuccess } from "@/lib/api-response";
import { prisma } from "@/lib/db";
import {
  antigravityProfileLocation,
  antigravityReasonOf,
  probeAntigravity,
  type AntigravityFailureReason,
  type AntigravityPromptCapabilities,
} from "@/lib/ai/antigravity-client";

export const dynamic = "force-dynamic";

export type AntigravityConnectionStatus =
  "disconnected" | "connected" | "auth_required" | "error";

type AntigravityTestReason =
  AntigravityFailureReason | "not_set_up" | "profile_missing";

export interface AntigravityTestResponse {
  status: AntigravityConnectionStatus;
  /** Why the test did not pass. Null when the profile is connected. */
  reason: AntigravityTestReason | null;
  capabilities: AntigravityPromptCapabilities | null;
}

async function probe(profileId: string): Promise<AntigravityTestResponse> {
  const profile = antigravityProfileLocation(profileId);
  if (!profile) {
    return { status: "error", reason: "profile_missing", capabilities: null };
  }
  try {
    const { capabilities } = await probeAntigravity(profile);
    return { status: "connected", reason: null, capabilities };
  } catch (error) {
    const reason = antigravityReasonOf(error);
    const status: AntigravityConnectionStatus =
      reason === "auth_required" ? "auth_required" : "error";
    return { status, reason, capabilities: null };
  }
}

export const POST = apiHandler(async () => {
  const { user: caller } = await requireAuth();

  const row = await prisma.user.findUnique({
    where: { id: caller.id },
    select: { antigravityProfileId: true },
  });
  const profileId = row?.antigravityProfileId ?? null;

  const result: AntigravityTestResponse = profileId
    ? await probe(profileId)
    : { status: "disconnected", reason: "not_set_up", capabilities: null };

  await prisma.user.update({
    where: { id: caller.id },
    data: {
      antigravityConnectionStatus: result.status,
      antigravityConnectedAt:
        result.status === "connected" ? new Date() : undefined,
      antigravityCapabilitiesJson: result.capabilities
        ? { promptCapabilities: result.capabilities }
        : undefined,
    },
  });

  return apiSuccess(result);
});
