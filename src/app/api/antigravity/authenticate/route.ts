/**
 * POST /api/antigravity/authenticate
 *
 * Triggers Antigravity CLI authentication for the user.
 * Uses the official `agy acp --login` flow, which opens a browser for the user.
 *
 * IMPORTANT: HealthLog does NOT store or handle OAuth tokens.
 * The CLI manages authentication independently via its own credential store.
 * This route only:
 * 1. Generates a profile ID for the user
 * 2. Sets up the profile directory (if ANTIGRAVITY_PROFILE_ROOT is configured)
 * 3. Records the profile ID in the database
 * 4. Returns instructions for the user to run `agy acp --login`
 */
import { requireUser } from "@/lib/api-handler";
import { prisma } from "@/lib/db";
import { randomBytes } from "crypto";
import { mkdirSync, existsSync } from "fs";
import { join } from "path";
import { NextResponse } from "next/server";

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

export async function POST() {
  const userId = await requireUser();

  // Check if user already has a profile ID
  const existingUser = await prisma.user.findUnique({
    where: { id: userId },
    select: { antigravityProfileId: true },
  });

  let profileId = existingUser?.antigravityProfileId;

  if (!profileId) {
    // Generate new profile ID
    profileId = generateProfileId();
  }

  // Set up profile directory if ANTIGRAVITY_PROFILE_ROOT is configured
  let profileDir: string | null = null;
  const profileRoot = process.env.ANTIGRAVITY_PROFILE_ROOT;

  if (profileRoot) {
    profileDir = join(profileRoot, profileId);

    // Create directory with secure permissions
    if (!existsSync(profileDir)) {
      try {
        mkdirSync(profileDir, { recursive: true, mode: 0o700 });
      } catch (error) {
        // Log error but continue - user may need to create manually
        console.error("Failed to create Antigravity profile directory:", error);
      }
    }
  }

  // Save profile ID to database
  await prisma.user.update({
    where: { id: userId },
    data: {
      antigravityProfileId: profileId,
      antigravityConnectionStatus: "disconnected",
      antigravityConnectedAt: null,
    },
  });

  const instructions = [
    "To complete Antigravity setup, you need to authenticate with your Antigravity account:",
    "",
    "1. Run the following command in your terminal:",
    `   agy acp --login${profileDir ? ` --app-data-dir ${profileDir}` : ""}`,
    "",
    "2. A browser window will open for you to sign in",
    "3. Complete the authentication flow",
    "4. Return to HealthLog and test the connection",
  ];

  const response: AntigravityAuthenticateResponse = {
    profileId,
    profileDir,
    instructions,
    manualLoginRequired: true,
  };

  return NextResponse.json(response);
}
