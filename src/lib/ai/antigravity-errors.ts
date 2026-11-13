/**
 * Errors and failure reasons for the Antigravity CLI provider.
 *
 * Messages here never carry CLI output or user data. The CLI text, when it is
 * needed for diagnosis, sits on `originalError`.
 */

// ─── Errors ──────────────────────────────────────────────────

export const ANTIGRAVITY_ERRORS = {
  CLI_UNAVAILABLE: "cli_unavailable",
  AUTH_REQUIRED: "auth_required",
  SESSION_FAILED: "session_failed",
  PROMPT_FAILED: "prompt_failed",
  QUOTA_EXCEEDED: "quota_exceeded",
  CANCELLED: "cancelled",
  TIMEOUT: "timeout",
  PROCESS_ERROR: "process_error",
  MODEL_UNAVAILABLE: "model_unavailable",
} as const;

/** Why a probe of the CLI did not pass. */
export type AntigravityFailureReason =
  "cli_unavailable" | "auth_required" | "timeout" | "cli_error";

/** Map a failed call to the reason the settings screen shows. */
export function antigravityReasonOf(error: unknown): AntigravityFailureReason {
  if (!(error instanceof AntigravityError)) return "cli_error";
  switch (error.code) {
    case ANTIGRAVITY_ERRORS.AUTH_REQUIRED:
      return "auth_required";
    case ANTIGRAVITY_ERRORS.CLI_UNAVAILABLE:
      return "cli_unavailable";
    case ANTIGRAVITY_ERRORS.TIMEOUT:
      return "timeout";
    default:
      return "cli_error";
  }
}

export class AntigravityError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly originalError?: unknown,
  ) {
    super(message);
    this.name = "AntigravityError";
  }
}
