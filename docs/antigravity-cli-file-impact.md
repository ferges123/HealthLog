# Antigravity CLI Integration — File Impact Matrix

**Status**: Stage 0 audit complete  
**Date**: 2026-11-13

---

## Summary

This document provides a comprehensive impact analysis for integrating Antigravity CLI as an AI provider in HealthLog. It lists every file that requires modification, new implementation, or is intentionally excluded from the integration.

---

## File Categories

| Category | Count | Risk Level |
|----------|-------|------------|
| New files | ~15 | Medium (new code) |
| Modified files | ~25 | Low (extensions) |
| Test files | ~20 | Medium (coverage) |
| Excluded files | 6 | Zero (intentional) |

---

## 1. NEW FILES

### 1.1 Core Provider Implementation (Stage 2)

| File | Purpose | Dependencies |
|------|---------|--------------|
| `src/lib/ai/antigravity-client.ts` | ACP client, implements `AIProvider` | `types.ts`, ACP SDK or custom wire |
| `src/lib/ai/antigravity-runner.ts` | Process management, session lifecycle | `antigravity-client.ts`, `provider-runner.ts` |
| `src/lib/ai/antigravity-capabilities.ts` | Capability discovery, model options | ACP `initialize`, `configOptions` |
| `src/lib/ai/antigravity-errors.ts` | Error normalization, stable error codes | `failure-kind.ts` |

**Key implementations**:
- `type = "antigravity"`
- `supportsTools = false`
- `generateCompletion()` with ACP `session/new`, `session/prompt`, `session/cancel`
- Optional `generateCompletionStream()` with `agent_message_chunk` events

### 1.2 API Routes (Stage 4)

| File | Method | Purpose |
|------|--------|---------|
| `src/app/api/antigravity/status/route.ts` | GET | CLI version, profile status, last error |
| `src/app/api/antigravity/models/route.ts` | GET | Available models from `configOptions` |
| `src/app/api/antigravity/authenticate/route.ts` | POST | Initiate CLI auth flow |
| `src/app/api/antigravity/disconnect/route.ts` | POST | Disconnect profile, cleanup |

**Error codes** (stable, never raw stderr):
- `cli_unavailable` — `agy` not found or not executable
- `cli_version_unsupported` — Version mismatch
- `auth_required` — CLI needs authentication
- `model_unavailable` — Selected model not found
- `permission_denied` — Operation not allowed

### 1.3 UI Components (Stage 4)

| File | Purpose |
|------|---------|
| `src/components/settings/ai/antigravity-provider-form.tsx` | Provider config UI |
| `e2e/antigravity-provider.spec.ts` | E2E tests with mocks |

**Form fields**:
- CLI detected/not detected indicator
- Connection status (honest: `unknown`, `connected`, `auth_required`, `error`)
- Model selector (from `configOptions`)
- Thought level selector (if supported)
- Test connection button
- Enable/disable toggle

### 1.4 Test Files (Stage 2+)

| File | Type | Purpose |
|------|------|---------|
| `src/lib/ai/__tests__/antigravity-client.test.ts` | Unit | Client contract tests |
| `src/lib/ai/__tests__/antigravity-runner.test.ts` | Unit | Process management |
| `src/lib/ai/__tests__/antigravity-capabilities.test.ts` | Unit | Capability discovery |
| `src/lib/ai/__tests__/antigravity-errors.test.ts` | Unit | Error normalization |
| `src/lib/ai/__tests__/antigravity-multimodal.test.ts` | Unit | Image/PDF handling |
| `tests/integration/antigravity-provider.test.ts` | Integration | Full provider flow |
| `tests/integration/antigravity-consent.test.ts` | Integration | Consent requirements |
| `tests/integration/antigravity-session-isolation.test.ts` | Integration | Profile isolation |
| `tests/fixtures/antigravity/acp/*.jsonl` | Fixture | Mock ACP responses |
| `tests/fixtures/antigravity/documents/*` | Fixture | Synthetic test documents |

### 1.5 PoC Scripts (Stage 1)

| File | Purpose |
|------|---------|
| `scripts/antigravity-acp-poc.ts` | Manual ACP testing, opt-in only |
| `scripts/antigravity-headless-poc.ts` | Optional headless comparison |
| `docs/antigravity-cli-transport-decision.md` | Transport choice documentation |

**PoC constraints**:
- Synthetic data only
- Never available from web app
- No medical data in fixtures
- Requires explicit opt-in

---

## 2. MODIFIED FILES

### 2.1 Core Types

| File | Changes | Lines (approx) |
|------|---------|----------------|
| `src/lib/ai/types.ts` | Add `"antigravity"` to `ProviderType` union | 1 |
| `src/lib/ai/provider-chain.ts` | Add `"antigravity"` to `PROVIDER_CHAIN_TYPES` | 1 |
| `src/lib/ai/provider-chain.ts` | Do NOT add to `PROVIDER_CHAIN_DEFAULT` | 0 |

**Note**: Adding to `PROVIDER_CHAIN_TYPES` enables configuration, but `PROVIDER_CHAIN_DEFAULT` stays unchanged — users must explicitly enable Antigravity.

### 2.2 Provider Resolution

| File | Changes | New Functions/Exports |
|------|---------|----------------------|
| `src/lib/ai/provider.ts` | Resolver for `antigravity` type | `resolveAntigravityProvider()` |
| `src/lib/ai/provider.ts` | Presence check | Profile status, not auth status |
| `src/lib/ai/provider.ts` | Connection test | Test without side effects |

**Key constraint**: Do NOT run CLI in `probeProviderChain()`. Presence uses saved profile status and last successful test.

### 2.3 Vision and Multimodal

| File | Changes |
|------|---------|
| `src/lib/ai/vision-capability.ts` | Add `antigravity` case to `supportsVisionForConfig()` |
| `src/lib/ai/vision-capability.ts` | Add `antigravity` case to `supportsPdfForProvider()` (false initially) |
| `src/lib/labs/ocr-capability.ts` | Update `resolveVisionProvider()` for Antigravity |
| `src/lib/documents/ai-route-support.ts` | Route Antigravity through document pipeline |
| `src/lib/documents/provider-rank.ts` | Add Antigravity to rank 3 (external account) |
| `src/lib/documents/provider-order.ts` | Sort Antigravity in document chain |
| `src/lib/ai/codex-slug-chain.ts` | Extend `chainEntryReadsImages()` for Antigravity |

**Initial vision support**: Conservative — assume images work only after PoC confirms. PDF = raster fallback by default.

### 2.4 Reasoning

| File | Changes |
|------|---------|
| `src/lib/ai/reasoning/support.ts` | Add `antigravity` to capability matrix |
| `src/lib/ai/reasoning/resolve.ts` | Add `case "antigravity"` to `reasoningSupportForChainEntry()` |

**Initial reasoning support**: 
- `effort`: only if confirmed by ACP capabilities
- `summaries: false` (not equivalent to thought chunks)

### 2.5 Egress and Consent

| File | Changes |
|------|---------|
| `src/lib/ai/provider-egress.ts` | `isExternalProvider("antigravity") === true` |
| `src/lib/documents/provider-rank.ts` | Rank 3 (same as Codex) |

**Implication**: Antigravity requires consent before first use. Data leaves the instance.

### 2.6 Validation

| File | Changes |
|------|---------|
| `src/lib/validations/ai-provider.ts` | Add `ANTIGRAVITY_CLI` to `aiProvider` enum |
| `src/lib/validations/ai-provider.ts` | Validate `antigravityModel` selection |
| `src/lib/validations/ai-provider.ts` | Validate reasoning effort for Antigravity |

### 2.7 OpenAPI

| File | Changes |
|------|---------|
| `src/lib/openapi/routes/profile.ts` | Add `antigravityProfileId` field |
| `src/lib/openapi/routes/insights/schemas.ts` | Add Antigravity provider variant |
| OpenAPI registry | Register new `/api/antigravity/*` routes |
| `docs/api/openapi.yaml` | Generated (do not edit) |

### 2.8 API Routes (Modifications)

| File | Changes |
|------|---------|
| `src/app/api/user/ai-provider/route.ts` | Handle `antigravity` selection |
| `src/app/api/ai/test/route.ts` | Test Antigravity connection |
| `src/app/api/insights/provider-chain/route.ts` | Include Antigravity in chain |

**Critical**: `/api/ai/test` must use stable error codes, never log raw stderr.

### 2.9 UI Components (Modifications)

| File | Changes |
|------|---------|
| `src/components/settings/ai/shared.ts` | Add `antigravity` to provider UI constants |
| `src/components/settings/ai/ai-insights-card.tsx` | Show Antigravity status |
| `src/components/settings/ai/fallback-chain-card.tsx` | Allow Antigravity in chain config |
| `src/components/settings/ai/reasoning-effort-field.tsx` | Conditionally show for Antigravity |
| `src/components/insights/coach-panel/coach-model-picker.tsx` | Show Antigravity models when active |

### 2.10 Internationalization

| File | New Keys |
|------|----------|
| `messages/en.json` | ~20 keys for Antigravity UI |
| `messages/de.json` | Translations |
| `messages/fr.json` | Translations |
| `messages/es.json` | Translations |
| `messages/it.json` | Translations |
| `messages/pl.json` | Translations |
| `messages/ko.json` | Translations |
| `messages/nl.json` | Translations |
| `messages/pt-BR.json` | Translations |
| `messages/ru.json` | Translations |

### 2.11 Database

| File | Changes |
|------|---------|
| `prisma/schema.prisma` | Add Antigravity fields to `User` model |
| `prisma/migrations/<timestamp>_antigravity_cli_provider/migration.sql` | Migration script |

**Schema additions** (draft):
```prisma
model User {
  // Antigravity CLI provider
  antigravityProfileId        String?
  antigravityModel            String?
  antigravityConnectionStatus String?
  antigravityConnectedAt      DateTime?
  antigravityCapabilitiesJson Json?
}
```

### 2.12 Docker (Stage 5)

| File | Changes |
|------|---------|
| `Dockerfile` | Install pinned `agy` binary |
| `docker-compose.yml` | Optional profile volume |
| `docker-entrypoint.sh` | Profile directory setup (no auto-login) |
| `docs/integrations/ai-providers.md` | Antigravity deployment docs |
| `docs/self-hosting/*.md` | Auth and security instructions |

### 2.13 E2E Tests

| File | Changes |
|------|---------|
| `e2e/ai-provider-dropdown.spec.ts` | Test Antigravity option |
| `e2e/antigravity-provider.spec.ts` | **New file** with mock tests |

---

## 3. TEST FILE EXTENSIONS

### 3.1 Unit Test Extensions

| File | New Test Cases |
|------|----------------|
| `src/lib/ai/__tests__/provider.test.ts` | Antigravity resolution |
| `src/lib/ai/__tests__/provider-contract.test.ts` | Antigravity contract compliance |
| `src/lib/ai/__tests__/provider-chain.test.ts` | Antigravity in chain |
| `src/lib/ai/__tests__/provider-presence.test.ts` | Antigravity presence |
| `src/lib/ai/__tests__/provider-runner.test.ts` | Antigravity fallback |
| `src/lib/ai/__tests__/resolve-chain.test.ts` | Chain resolution with Antigravity |
| `src/lib/ai/__tests__/reasoning-effort.test.ts` | Antigravity reasoning |
| `src/lib/ai/reasoning/__tests__/support.test.ts` | Antigravity reasoning support |
| `src/lib/ai/capabilities/__tests__/resolve.test.ts` | Capability resolution |
| `src/lib/ai/capabilities/__tests__/egress.test.ts` | Egress classification |
| `src/lib/ai/__tests__/consent-guard.test.ts` | Consent for Antigravity |
| `src/lib/documents/__tests__/provider-order.test.ts` | Document chain order |

---

## 4. FILES INTENTIONALLY UNCHANGED

### 4.1 OAuth and Token Management

| File | Reason |
|------|--------|
| `src/lib/ai/codex-oauth.ts` | Antigravity uses CLI auth, not HealthLog OAuth |
| `src/lib/integrations/oauth-refresh.ts` | No token refresh for Antigravity |
| `scripts/rotate-encryption-key.ts` | No new secrets in DB |

### 4.2 Central Provider

| File | Reason |
|------|--------|
| `src/components/admin/central-codex-section.tsx` | No `admin-antigravity` in Stage 1 |
| `src/app/api/admin/central-codex/*` | No central Antigravity routes |

### 4.3 Static Model Catalog

| File | Reason |
|------|--------|
| `src/lib/ai/codex-model-catalog.ts` | Antigravity models discovered at runtime |
| `src/lib/ai/codex-slug-cache.ts` | No slug cache for Antigravity |
| `src/lib/ai/codex-slug-chain.ts` | No static fallback chain |

### 4.4 Default Chain

| File | Reason |
|------|--------|
| `src/lib/ai/provider-chain.ts` (`PROVIDER_CHAIN_DEFAULT`) | Antigravity not in default chain |
| `src/components/settings/ai/*.tsx` (`DEFAULT_CHAIN`) | UI default unchanged |

---

## 5. DIRECTORY STRUCTURE

```
src/lib/ai/
├── antigravity-client.ts          # NEW: ACP client
├── antigravity-runner.ts          # NEW: Process manager
├── antigravity-capabilities.ts    # NEW: Capability discovery
├── antigravity-errors.ts          # NEW: Error normalization
├── types.ts                       # MODIFIED: ProviderType
├── provider-chain.ts              # MODIFIED: ProviderChainType
├── provider.ts                    # MODIFIED: Resolver
├── vision-capability.ts           # MODIFIED: Vision support
└── reasoning/
    └── resolve.ts                 # MODIFIED: Reasoning support

src/app/api/antigravity/           # NEW: API routes
├── status/route.ts
├── models/route.ts
├── authenticate/route.ts
└── disconnect/route.ts

src/components/settings/ai/
└── antigravity-provider-form.tsx  # NEW: UI component

tests/fixtures/antigravity/        # NEW: Test fixtures
├── acp/*.jsonl
└── documents/*

scripts/
├── antigravity-acp-poc.ts         # NEW: PoC script
└── antigravity-headless-poc.ts    # NEW: Optional PoC

docs/
├── antigravity-cli-architecture.md  # NEW: Architecture doc
├── antigravity-cli-file-impact.md   # NEW: This file
└── antigravity-cli-transport-decision.md  # NEW: PoC result
```

---

## 6. RISK ASSESSMENT

### High Risk Areas

1. **Profile isolation** — Must verify `--app-data-dir` behavior
2. **Concurrent sessions** — Multiple users/requests simultaneously
3. **Error handling** — No raw stderr leakage
4. **Consent flow** — Clear external processing acknowledgment

### Medium Risk Areas

1. **Multimodal support** — Image/PDF capability uncertain until PoC
2. **Streaming** — New implementation path
3. **Model discovery** — Runtime capability negotation
4. **Docker deployment** — Binary installation, volume setup

### Low Risk Areas

1. **Type extensions** — Simple union additions
2. **Provider runner** — Existing fallback logic
3. **Health ledger** — Existing infrastructure
4. **Consent guard** — Existing egress classification

---

## 7. MIGRATION PATH

**Stage 0** (this document): Audit complete, no code changes
**Stage 1**: PoC with synthetic data, verify capabilities
**Stage 2**: Core provider implementation
**Stage 3**: Multimodal support
**Stage 4**: Settings, UI, API routes
**Stage 5**: Docker, security, deployment
**Stage 6**: Tests, documentation, PR prep

---

## Appendix: Complete File List

### NEW FILES (15)

```
src/lib/ai/antigravity-client.ts
src/lib/ai/antigravity-runner.ts
src/lib/ai/antigravity-capabilities.ts
src/lib/ai/antigravity-errors.ts
src/app/api/antigravity/status/route.ts
src/app/api/antigravity/models/route.ts
src/app/api/antigravity/authenticate/route.ts
src/app/api/antigravity/disconnect/route.ts
src/components/settings/ai/antigravity-provider-form.tsx
scripts/antigravity-acp-poc.ts
scripts/antigravity-headless-poc.ts
docs/antigravity-cli-architecture.md
docs/antigravity-cli-file-impact.md
docs/antigravity-cli-transport-decision.md
e2e/antigravity-provider.spec.ts
```

### MODIFIED FILES (25+)

```
prisma/schema.prisma
src/lib/ai/types.ts
src/lib/ai/provider-chain.ts
src/lib/ai/provider.ts
src/lib/ai/vision-capability.ts
src/lib/ai/reasoning/support.ts
src/lib/ai/reasoning/resolve.ts
src/lib/ai/provider-egress.ts
src/lib/documents/provider-rank.ts
src/lib/documents/provider-order.ts
src/lib/documents/ai-route-support.ts
src/lib/labs/ocr-capability.ts
src/lib/validations/ai-provider.ts
src/lib/openapi/routes/profile.ts
src/lib/openapi/routes/insights/schemas.ts
src/app/api/user/ai-provider/route.ts
src/app/api/ai/test/route.ts
src/app/api/insights/provider-chain/route.ts
src/components/settings/ai/shared.ts
src/components/settings/ai/ai-insights-card.tsx
src/components/settings/ai/fallback-chain-card.tsx
src/components/settings/ai/reasoning-effort-field.tsx
src/components/insights/coach-panel/coach-model-picker.tsx
messages/*.json (11 files)
Dockerfile
docker-compose.yml
docker-entrypoint.sh
docs/integrations/ai-providers.md
```

### EXCLUDED FILES (6)

```
src/lib/ai/codex-oauth.ts
src/lib/integrations/oauth-refresh.ts
scripts/rotate-encryption-key.ts
src/components/admin/central-codex-section.tsx
src/lib/ai/codex-model-catalog.ts
src/lib/ai/codex-slug-cache.ts
```

---

**End of Document**
