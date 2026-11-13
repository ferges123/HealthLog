/**
 * Error normalization for Antigravity CLI provider.
 *
 * Maps ACP/CLI errors to stable HealthLog error codes for consistent
 * handling across providers.
 */

import { AntigravityError, ANTIGRAVITY_ERRORS } from "./antigravity-client";

/**
 * Map an AntigravityError to a stable error code for API responses.
 */
export function normalizeAntigravityError(
  error: unknown,
): {
  code: string;
  message: string;
  httpStatus: number;
} {
  if (!(error instanceof AntigravityError)) {
    return {
      code: "unknown",
      message: error instanceof Error ? error.message : "Unknown error",
      httpStatus: 500,
    };
  }

  switch (error.code) {
    case ANTIGRAVITY_ERRORS.CLI_UNAVAILABLE:
      return {
        code: "cli_unavailable",
        message: "Antigravity CLI not found or not executable",
        httpStatus: 503,
      };

    case ANTIGRAVITY_ERRORS.AUTH_REQUIRED:
      return {
        code: "auth_required",
        message: "Antigravity CLI requires authentication",
        httpStatus: 401,
      };

    case ANTIGRAVITY_ERRORS.QUOTA_EXCEEDED:
      return {
        code: "quota_exceeded",
        message: "Antigravity quota exceeded",
        httpStatus: 429,
      };

    case ANTIGRAVITY_ERRORS.MODEL_UNAVAILABLE:
      return {
        code: "model_unavailable",
        message: "Requested model not available",
        httpStatus: 400,
      };

    case ANTIGRAVITY_ERRORS.CANCELLED:
      return {
        code: "cancelled",
        message: "Request cancelled",
        httpStatus: 499, // Client closed request
      };

    case ANTIGRAVITY_ERRORS.TIMEOUT:
      return {
        code: "timeout",
        message: "Request timed out",
        httpStatus: 504,
      };

    case ANTIGRAVITY_ERRORS.SESSION_FAILED:
    case ANTIGRAVITY_ERRORS.PROMPT_FAILED:
    case ANTIGRAVITY_ERRORS.PROCESS_ERROR:
    default:
      return {
        code: "upstream_error",
        message: error.message,
        httpStatus: 502,
      };
  }
}
