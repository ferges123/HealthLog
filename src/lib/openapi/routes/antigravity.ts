/**
 * OpenAPI paths for Antigravity CLI provider routes.
 */

import { z } from "zod";
import { createRoute } from "zod-openapi";

import { standardErrors } from "./shared";

const antigravityStatusResponse = z.object({
  cliInstalled: z.boolean(),
  cliVersion: z.string().nullable(),
  profileId: z.string().nullable(),
  model: z.string().nullable(),
  connectionStatus: z.enum(["disconnected", "connected", "auth_required", "error"]),
  connectedAt: z.string().nullable(),
  lastError: z.string().nullable(),
  capabilities: z
    .object({
      image: z.boolean(),
      resourceBlob: z.boolean(),
    })
    .nullable(),
});

const antigravityModelsResponse = z.object({
  models: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      thinkingLevels: z.array(z.string()).nullable(),
    }),
  ),
  defaultModel: z.string().nullable(),
  thinkingLevels: z.array(z.string()),
  error: z.string().nullable(),
});

const antigravityAuthenticateResponse = z.object({
  profileId: z.string(),
  profileDir: z.string().nullable(),
  instructions: z.array(z.string()),
  manualLoginRequired: z.boolean(),
});

const antigravityDisconnectResponse = z.object({
  success: z.boolean(),
  instructions: z.array(z.string()),
});

export const antigravityPaths = {
  "/api/antigravity/status": {
    get: createRoute({
      tags: ["ai"],
      summary: "Get Antigravity CLI status for the authenticated user",
      security: [{ cookieAuth: [] }],
      responses: {
        200: {
          description: "Antigravity CLI status",
          content: {
            "application/json": {
              schema: antigravityStatusResponse,
            },
          },
        },
        ...standardErrors,
      },
    }),
  },

  "/api/antigravity/models": {
    get: createRoute({
      tags: ["ai"],
      summary: "Get available models from Antigravity CLI",
      security: [{ cookieAuth: [] }],
      responses: {
        200: {
          description: "Available models",
          content: {
            "application/json": {
              schema: antigravityModelsResponse,
            },
          },
        },
        ...standardErrors,
      },
    }),
  },

  "/api/antigravity/authenticate": {
    post: createRoute({
      tags: ["ai"],
      summary: "Trigger Antigravity CLI authentication",
      security: [{ cookieAuth: [] }],
      responses: {
        200: {
          description: "Authentication response with instructions",
          content: {
            "application/json": {
              schema: antigravityAuthenticateResponse,
            },
          },
        },
        ...standardErrors,
      },
    }),
  },

  "/api/antigravity/disconnect": {
    post: createRoute({
      tags: ["ai"],
      summary: "Disconnect the Antigravity CLI provider",
      security: [{ cookieAuth: [] }],
      responses: {
        200: {
          description: "Disconnect response with instructions",
          content: {
            "application/json": {
              schema: antigravityDisconnectResponse,
            },
          },
        },
        ...standardErrors,
      },
    }),
  },
};
