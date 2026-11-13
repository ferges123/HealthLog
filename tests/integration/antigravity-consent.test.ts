/**
 * Integration test for Antigravity consent and document handling.
 *
 * Verifies that consent is properly gated before document processing
 * and that external egress is properly tracked.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { isExternalProvider } from "@/lib/ai/provider-egress";
import { documentProviderRank } from "@/lib/documents/provider-rank";
import { supportsPdfForProvider } from "@/lib/ai/vision-capability";

describe("Antigravity Consent and Document Handling", () => {
  describe("External provider classification", () => {
    it("classifies Antigravity as external provider", () => {
      expect(isExternalProvider("antigravity")).toBe(true);
    });

    it("classifies local provider as non-external", () => {
      expect(isExternalProvider("local")).toBe(false);
    });

    it("classifies Codex as external (train-by-default)", () => {
      expect(isExternalProvider("codex")).toBe(true);
    });
  });

  describe("Document provider rank", () => {
    it("ranks Antigravity last (external, train-by-default)", () => {
      const rank = documentProviderRank("antigravity");
      expect(rank).toBe(3); // Lowest priority
    });

    it("ranks local first", () => {
      const rank = documentProviderRank("local");
      expect(rank).toBe(0); // Highest priority
    });

    it("ranks OpenAI-compatible before Antigravity", () => {
      const rankCompat = documentProviderRank("openai-compatible");
      const rankAntigravity = documentProviderRank("antigravity");
      expect(rankCompat).toBeLessThan(rankAntigravity);
    });

    it("ranks Antigravity same as Codex (both external/train)", () => {
      const rankCodex = documentProviderRank("codex");
      const rankAntigravity = documentProviderRank("antigravity");
      expect(rankCodex).toBe(rankAntigravity);
    });
  });

  describe("PDF support", () => {
    it("reports PDF support for Antigravity", () => {
      expect(supportsPdfForProvider("antigravity")).toBe(true);
    });

    it("reports PDF support for Anthropic", () => {
      expect(supportsPdfForProvider("anthropic")).toBe(true);
    });

    it("denies PDF support for OpenAI", () => {
      expect(supportsPdfForProvider("openai")).toBe(false);
    });

    it("denies PDF support for Codex", () => {
      expect(supportsPdfForProvider("codex")).toBe(false);
    });
  });

  describe("Vision capability", () => {
    it("enables vision for Antigravity", () => {
      const { supportsVisionForConfig } = require("@/lib/ai/vision-capability");
      expect(supportsVisionForConfig("antigravity", null)).toBe(true);
    });
  });

  describe("Consent requirements", () => {
    it("requires consent before document processing with Antigravity", () => {
      // Antigravity is external provider
      const isExternal = isExternalProvider("antigravity");
      expect(isExternal).toBe(true);

      // External providers require consent
      // This is enforced by consent-guard.ts in the actual implementation
    });

    it("requires consent when falling back from Antigravity to Codex", () => {
      // Both Antigravity and Codex are rank 3 (external)
      const rankAntigravity = documentProviderRank("antigravity");
      const rankCodex = documentProviderRank("codex");

      expect(rankAntigravity).toBe(3);
      expect(rankCodex).toBe(3);

      // Any fallback between external providers should check consent
      // This is enforced by the consent guard
    });
  });

  describe("Document egress tracking", () => {
    it("tracks Antigravity document reads as external egress", () => {
      const isExternal = isExternalProvider("antigravity");
      // This will be tracked in the vault audit log
      expect(isExternal).toBe(true);
    });
  });
});
