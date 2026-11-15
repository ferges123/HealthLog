/**
 * POST /api/antigravity/authenticate
 *
 * Prepares the Antigravity profile for the user and returns the login steps.
 * HealthLog does not handle OAuth tokens. The CLI stores the login in the
 * profile folder, and `agy acp --login` writes it there when the user runs it.
 *
 * This route only:
 * 1. Generates a profile ID for the user
 * 2. Creates the profile folder when ANTIGRAVITY_PROFILE_ROOT is configured
 * 3. Records the profile ID in the database
 * 4. Returns the login command for the user to run on the HealthLog host
 */
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { apiSuccess } from "@/lib/api-response";
import { prisma } from "@/lib/db";
import { randomBytes } from "crypto";
import { envValue } from "@/lib/env";
import { mkdirSync, existsSync } from "fs";
import { join } from "path";

export const dynamic = "force-dynamic";

export interface AntigravityAuthenticateResponse {
  /** Generated profile ID for this user */
  profileId: string;
  /** Profile directory path (if ANTIGRAVITY_PROFILE_ROOT is set) */
  profileDir: string | null;
  /** Instructions for the user */
  instructions: string[];
  /** Whether manual login is required */
  manualLoginRequired: boolean;
}

/**
 * Generate a random profile ID (not a path, not a token).
 * This is an opaque identifier used to locate the profile directory.
 */
function generateProfileId(): string {
  return randomBytes(16).toString("hex");
}

export const POST = apiHandler(async () => {
  const { user: caller } = await requireAuth();

  const existing = await prisma.user.findUnique({
    where: { id: caller.id },
    select: {
      antigravityProfileId: true,
      antigravityConnectionStatus: true,
    },
  });

  const profileId = existing?.antigravityProfileId ?? generateProfileId();

  // Set up the profile folder if ANTIGRAVITY_PROFILE_ROOT is configured
  const profileRoot = envValue("ANTIGRAVITY_PROFILE_ROOT") ?? null;
  let profileDir: string | null = null;

  if (profileRoot) {
    profileDir = join(profileRoot, profileId);
    if (!existsSync(profileDir)) {
      try {
        mkdirSync(profileDir, { recursive: true, mode: 0o700 });
      } catch (error) {
        // The operator may need to create the folder by hand. Log the cause.
        console.error("Failed to create Antigravity profile directory:", error);
      }
    }
    // agy 1.5.8+ stores the OAuth token at
    // {XDG_CONFIG_HOME}/antigravity/plugin-secrets.json.
    // antigravityChildEnv sets XDG_CONFIG_HOME = {profileDir}/.config, so the
    // directory must exist before the user runs `agy acp --login`; otherwise
    // agy cannot write the token and every session/new call returns
    // AUTH_REQUIRED. Create the full chain at profile-setup time so it is
    // ready when the login command runs.
    const xdgConfigDir = join(profileDir, ".config", "antigravity");
    if (!existsSync(xdgConfigDir)) {
      try {
        mkdirSync(xdgConfigDir, { recursive: true, mode: 0o700 });
      } catch (error) {
        console.error("Failed to create Antigravity XDG config directory:", error);
      }
    }
  }

  await prisma.user.update({
    where: { id: caller.id },
    data: {
      antigravityProfileId: profileId,
      // Only reset status on new profile or if not already connected
      ...(existing?.antigravityConnectionStatus !== "connected"
        ? {
            antigravityConnectionStatus: "disconnected",
            antigravityConnectedAt: null,
          }
        : {}),
    },
  });

  const instructions = profileRoot
    ? [
        "To connect Antigravity, sign in once on the machine that runs HealthLog.",
        "The login must run on that host, because the profile folder lives there.",
        "",
        "1. Open a terminal on the HealthLog host (inside its container, for example with docker exec -it) and run:",
        `   agy acp --login --gemini-dir ${profileRoot}/${profileId}`,
        "   (No --app-data-dir needed; the per-user gemini-dir already isolates the profile.)",
        "2. Open the printed link in a browser, sign in, then paste the code back into the terminal",
        "3. Back in HealthLog, run the connection test",
      ]
    : [
        "Antigravity is not set up on this server yet.",
        "The operator must set ANTIGRAVITY_PROFILE_ROOT to an absolute folder path, then restart HealthLog.",
      ];

  const response: AntigravityAuthenticateResponse = {
    profileId,
    profileDir,
    instructions,
    manualLoginRequired: true,
  };

  return apiSuccess(response);
});
