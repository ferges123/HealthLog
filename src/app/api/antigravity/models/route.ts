/**
 * GET /api/antigravity/models
 *
 * Returns available models from the ACP session/new configOptions.
 * No static list - models are discovered at runtime from the CLI.
 *
 * Requires an active CLI installation; returns empty array if CLI not found
 * or if model discovery fails.
 */
import { requireUser } from "@/lib/api-handler";
import { spawn } from "child_process";
import { NextResponse } from "next/server";

interface ConfigOption {
  key: string;
  type: "select" | "text" | "boolean";
  label?: string;
  values?: Array<{ value: string; label: string }>;
  default?: string | boolean;
}

interface AntigravityModel {
  id: string;
  name: string;
  /** Thinking level options for this model */
  thinkingLevels?: string[];
}

export interface AntigravityModelsResponse {
  models: AntigravityModel[];
  /** Default model ID */
  defaultModel: string | null;
  /** Available thinking levels across all models */
  thinkingLevels: string[];
  /** Error if model discovery failed */
  error: string | null;
}

/**
 * Discover models from ACP by querying configOptions after session/new.
 * This is a best-effort discovery; if it fails, return empty arrays.
 */
async function discoverModels(): Promise<{
  models: AntigravityModel[];
  thinkingLevels: string[];
  error: string | null;
}> {
  return new Promise((resolve) => {
    const proc = spawn("agy", ["acp", "--sandbox", "--disable-telemetry"], {
      stdio: ["pipe", "pipe", "pipe"],
    });

    let buffer = "";
    let initialized = false;
    const models: AntigravityModel[] = [];
    const thinkingLevels: string[] = [];

    const cleanup = () => {
      proc.kill();
    };

    proc.stdout?.on("data", (data: Buffer) => {
      buffer += data.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);
          // Check for initialize response (id: 1) - handle both result and error
          if (msg.id === 1) {
            if (msg.result) {
              initialized = true;
            } else if (msg.error) {
              // Initialize failed
              resolve({
                models: [],
                thinkingLevels: [],
                error: msg.error.message || "initialize_failed",
              });
            }
          } else if (msg.id === 2) {
            // session/new response
            if (msg.error) {
              cleanup();
              resolve({
                models: [],
                thinkingLevels: [],
                error: msg.error.message || "session_failed",
              });
            } else if (msg.result?.configOptions) {
              const options = msg.result.configOptions as ConfigOption[];
              for (const opt of options) {
                if (opt.key === "model" && opt.type === "select" && opt.values) {
                  for (const value of opt.values) {
                    models.push({
                      id: value.value,
                      name: value.label || value.value,
                    });
                  }
                } else if (
                  opt.key === "thinkingLevel" &&
                  opt.type === "select" &&
                  opt.values
                ) {
                  for (const value of opt.values) {
                    thinkingLevels.push(value.value);
                  }
                }
              }

              // Close session and exit
              proc.stdin?.write(
                JSON.stringify({
                  jsonrpc: "2.0",
                  id: 999,
                  method: "session/close",
                  params: { sessionId: msg.result.sessionId },
                }) + "\n"
              );

              setTimeout(() => {
                cleanup();
                resolve({ models, thinkingLevels, error: null });
              }, 100);
            }
          }
        } catch {
          // Ignore parse errors
        }
      }
    });

    proc.stderr?.resume(); // Drain stderr

    proc.on("error", () => {
      resolve({
        models: [],
        thinkingLevels: [],
        error: "cli_unavailable",
      });
    });

    proc.on("exit", (code, signal) => {
      if (!initialized) {
        resolve({
          models: [],
          thinkingLevels: [],
          error: "cli_unavailable",
        });
      }
      // If session/new failed, we still get exit but models/thinkingLevels are empty
      // This is fine - empty arrays with null error indicate success but no models found
    });

    // Initialize
    proc.stdin?.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: 1,
          clientInfo: { name: "HealthLog", version: "1.0.0" },
        },
      }) + "\n"
    );

    // Create session
    setTimeout(() => {
      if (initialized) {
        proc.stdin?.write(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 2,
            method: "session/new",
            params: { cwd: "/tmp", mcpServers: [] },
          }) + "\n"
        );
      }
    }, 500);

    // Timeout after 10 seconds
    setTimeout(() => {
      cleanup();
      resolve({
        models: [],
        thinkingLevels: [],
        error: "timeout",
      });
    }, 10000);
  });
}

export async function GET() {
  await requireUser();

  const { models, thinkingLevels, error } = await discoverModels();

  const response: AntigravityModelsResponse = {
    models,
    defaultModel: models.length > 0 ? models[0].id : null,
    thinkingLevels,
    error,
  };

  return NextResponse.json(response);
}
