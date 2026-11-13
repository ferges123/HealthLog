/**
 * OpenAPI route table — Antigravity CLI provider: setup status, login steps,
 * the connection test and disconnect.
 *
 * Part of the OpenAPI route table; aggregated in `./index.ts`. The response
 * bodies mirror the handlers under `src/app/api/antigravity/*`.
 */
import { z } from "zod/v4";
import type { ZodOpenApiObject } from "zod-openapi";

import { antigravityModelPatchSchema } from "@/lib/validations/antigravity";
import { dataEnvelope, stdResponses } from "./shared";

const connectionStatus = z
  .enum(["disconnected", "connected", "auth_required", "error"])
  .describe("State of the profile as of the last connection test.");

const promptCapabilities = z
  .object({
    image: z.boolean(),
    embeddedContext: z
      .boolean()
      .describe(
        "Embedded resources such as PDFs. The CLI calls this embeddedContext.",
      ),
  })
  .describe(
    "Prompt input the CLI accepted in its last successful connection test.",
  );

const antigravityStatusResponse = z.object({
  cliInstalled: z.boolean(),
  cliVersion: z.string().nullable(),
  profileId: z.string().nullable(),
  connectionStatus,
  connectedAt: z.string().nullable(),
  capabilities: promptCapabilities.nullable(),
});

const antigravityAuthenticateResponse = z.object({
  profileId: z.string(),
  profileDir: z.string().nullable(),
  instructions: z.array(z.string()),
  manualLoginRequired: z.boolean(),
});

const antigravityTestResponse = z.object({
  status: connectionStatus,
  reason: z
    .enum([
      "not_set_up",
      "profile_missing",
      "cli_unavailable",
      "auth_required",
      "timeout",
      "cli_error",
    ])
    .nullable()
    .describe("Why the test did not pass. Null when the profile is connected."),
  capabilities: promptCapabilities.nullable(),
});

const antigravityModel = z.object({
  id: z.string().describe("Model id as the CLI names it."),
  name: z.string(),
});

const antigravityModelsResponse = z.object({
  models: z.array(antigravityModel),
  selectedModel: z
    .string()
    .nullable()
    .describe("The model the user picked, or null for the CLI's default."),
  reason: z
    .enum([
      "not_set_up",
      "profile_missing",
      "cli_unavailable",
      "auth_required",
      "timeout",
      "cli_error",
      "no_models",
    ])
    .nullable()
    .describe("Why `models` is empty. Null when the CLI offered models."),
});

const antigravityModelResponse = z.object({
  selectedModel: z.string().nullable(),
});

const antigravityDisconnectResponse = z.object({
  success: z.boolean(),
  instructions: z.array(z.string()),
});

const ok = (description: string, schema: z.ZodType) => ({
  description,
  content: { "application/json": { schema } },
});

export const antigravityPaths: NonNullable<ZodOpenApiObject["paths"]> = {
  "/api/antigravity/status": {
    get: {
      tags: ["ai"],
      summary: "Get the Antigravity CLI status for the authenticated user",
      description:
        "Reports the CLI installation and the stored profile state. It never sets the connection to connected. Only the connection test does that.",
      responses: {
        "200": ok(
          "Antigravity CLI status",
          dataEnvelope(antigravityStatusResponse, "AntigravityStatusResponse"),
        ),
        ...stdResponses,
      },
    },
  },

  "/api/antigravity/authenticate": {
    post: {
      tags: ["ai"],
      summary: "Prepare an Antigravity profile and return the login steps",
      description:
        "Creates or reuses the user's profile ID. The login itself runs in a terminal on the HealthLog host with `agy acp --login`.",
      responses: {
        "200": ok(
          "Profile ID and login steps",
          dataEnvelope(
            antigravityAuthenticateResponse,
            "AntigravityAuthenticateResponse",
          ),
        ),
        ...stdResponses,
      },
    },
  },

  "/api/antigravity/test": {
    post: {
      tags: ["ai"],
      summary: "Test the Antigravity profile connection",
      description:
        "Starts the CLI on the user's profile and opens a session. No prompt and no health data are sent. The result is stored and returned.",
      responses: {
        "200": ok(
          "Connection test result",
          dataEnvelope(antigravityTestResponse, "AntigravityTestResponse"),
        ),
        ...stdResponses,
      },
    },
  },

  "/api/antigravity/models": {
    get: {
      tags: ["ai"],
      summary: "List the models the Antigravity profile offers",
      description:
        "Starts the CLI on the user's profile and reads the model selector from the session. The list is never static. An empty list comes with a `reason`.",
      responses: {
        "200": ok(
          "Models and the selected model",
          dataEnvelope(antigravityModelsResponse, "AntigravityModelsResponse"),
        ),
        ...stdResponses,
      },
    },
  },

  "/api/antigravity/model": {
    patch: {
      tags: ["ai"],
      summary: "Choose the Antigravity model, or return to the CLI default",
      description:
        "Saves the model id, or clears it with `null`. Requires a profile set up with `authenticate`. A model the CLI does not offer fails the next completion with a clear error.",
      requestBody: {
        required: true,
        content: {
          "application/json": { schema: antigravityModelPatchSchema },
        },
      },
      responses: {
        "200": ok(
          "The saved model",
          dataEnvelope(antigravityModelResponse, "AntigravityModelResponse"),
        ),
        ...stdResponses,
      },
    },
  },

  "/api/antigravity/disconnect": {
    post: {
      tags: ["ai"],
      summary: "Disconnect the Antigravity CLI provider",
      description:
        "Clears the profile ID and the stored state. The login files stay on the host. The response says where they are.",
      responses: {
        "200": ok(
          "Disconnect result and host cleanup steps",
          dataEnvelope(
            antigravityDisconnectResponse,
            "AntigravityDisconnectResponse",
          ),
        ),
        ...stdResponses,
      },
    },
  },
};
