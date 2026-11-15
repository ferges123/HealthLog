/**
 * Per-user Antigravity capabilities, mirroring what the ACP `initialize`
 * result reports and what the connection test stores in the database.
 *
 * The cache sits in process memory (a plain Map). It is populated two ways:
 *
 *   1. `probeProviderChain` / `resolveProviderAvailability` read the user row
 *      from the database and call `setAntigravityCapabilities` on every read,
 *      so a fresh request always wins.
 *
 *   2. The connection test route (`POST /api/antigravity/test`) calls
 *      `setAntigravityCapabilities` after a successful probe, so the in-memory
 *      state stays current for the rest of the request and the next render
 *      without waiting for a database round-trip.
 *
 * The disconnect route calls `forgetAntigravityCapabilities` so an entry that
 * is no longer connected does not retain stale capabilities.
 *
 * This is the same approach `codex-slug-cache.ts` uses for the working Codex
 * slug and the account's model list.
 */

export interface AntigravityCapabilities {
  /** CLI reports `agentCapabilities.promptCapabilities.image`. */
  image: boolean;
  /** CLI reports `agentCapabilities.promptCapabilities.embeddedContext`. */
  embeddedContext: boolean;
}

const cache = new Map<string, AntigravityCapabilities>();

function readCapabilities(json: unknown): AntigravityCapabilities {
  if (json === null || typeof json !== "object") {
    return { image: false, embeddedContext: false };
  }
  const caps = json as { promptCapabilities?: { image?: unknown; embeddedContext?: unknown } };
  const pc = caps.promptCapabilities;
  if (!pc || typeof pc !== "object") return { image: false, embeddedContext: false };
  return {
    image: pc.image === true,
    embeddedContext: pc.embeddedContext === true,
  };
}

/**
 * Record the capabilities for a user. Pass the `antigravityCapabilitiesJson`
 * value from the user row. Null or undefined clears the entry (same effect
 * as `forgetAntigravityCapabilities`).
 */
export function setAntigravityCapabilities(
  userId: string,
  json: unknown,
): void {
  if (json == null) {
    cache.delete(userId);
    return;
  }
  cache.set(userId, readCapabilities(json));
}

/**
 * Whether this user's Antigravity session can process rich (non-text) input.
 * True when the CLI reported either image or embeddedContext support during
 * the last connection test.
 */
export function antigravityReadsMedia(userId: string): boolean {
  const caps = cache.get(userId);
  return (caps?.image ?? false) || (caps?.embeddedContext ?? false);
}

/**
 * Whether this user's Antigravity session can process PDFs. True only when
 * the CLI reported `embeddedContext: true` during the last connection test.
 */
export function antigravityReadsPdf(userId: string): boolean {
  return cache.get(userId)?.embeddedContext ?? false;
}

/** Remove the entry for a user, e.g. after a disconnect. */
export function forgetAntigravityCapabilities(userId: string): void {
  cache.delete(userId);
}

/** Clear the whole cache (test helper). */
export function clearAntigravityCapabilityCache(): void {
  cache.clear();
}
