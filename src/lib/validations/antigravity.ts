/**
 * Request schemas for the Antigravity CLI provider endpoints under
 * `/api/antigravity/*`. The OpenAPI registry in
 * `src/lib/openapi/routes/antigravity.ts` reads the same definitions.
 */
import { z } from "zod/v4";

/**
 * A model id as the CLI names it. The id goes into an ACP message and a
 * settings row, never a shell or a path, so the check only keeps it to a
 * short, plain token.
 */
export const ANTIGRAVITY_MODEL_ID_PATTERN =
  /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;

/** `PATCH /api/antigravity/model`. `null` returns to the CLI's default model. */
export const antigravityModelPatchSchema = z
  .object({
    model: z.string().regex(ANTIGRAVITY_MODEL_ID_PATTERN).nullable(),
  })
  .strict();
