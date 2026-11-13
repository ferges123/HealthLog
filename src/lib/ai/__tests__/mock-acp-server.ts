/**
 * Mock ACP server for unit testing AntigravityClient.
 *
 * Simulates a minimal ACP JSON-RPC server over stdio for testing
 * without requiring the actual `agy` CLI.
 */

import { spawn, ChildProcess } from "child_process";
import { createWriteStream, mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { randomUUID } from "crypto";

interface MockACPServerOptions {
  /** Responses to return for session/prompt calls */
  promptResponses?: string[];
  /** Whether to simulate auth error */
  authRequired?: boolean;
  /** Whether to simulate quota exceeded */
  quotaExceeded?: boolean;
  /** Config options to return from session/new */
  configOptions?: Array<{ name: string; type: string; enum?: string[] }>;
}

/**
 * Creates a mock ACP script that behaves like `agy acp`.
 * Returns the child process and a cleanup function.
 */
export function createMockACPServer(
  options: MockACPServerOptions = {},
): { process: ChildProcess; cleanup: () => void } {
  const scriptDir = join(tmpdir(), `mock-acp-${randomUUID()}`);
  mkdirSync(scriptDir, { recursive: true });

  const scriptPath = join(scriptDir, "mock-acp.js");

  const script = `
const readline = require('readline');

const responses = ${JSON.stringify(options.promptResponses ?? ["OK"])};
const authRequired = ${options.authRequired ?? false};
const quotaExceeded = ${options.quotaExceeded ?? false};
const configOptions = ${JSON.stringify(options.configOptions ?? [
    { name: "Model", type: "select", enum: ["gemini-3.8-flash-medium"] },
    { name: "Thinking Level", type: "select", enum: ["low", "medium", "high"] },
  ])};

let responseIndex = 0;
let sessionId = "test-session-" + Math.random().toString(36).slice(2);

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: false
});

function sendResponse(id, result) {
  console.log(JSON.stringify({ jsonrpc: "2.0", id, result }));
}

function sendNotification(method, params) {
  console.log(JSON.stringify({ jsonrpc: "2.0", method, params }));
}

function sendError(id, message) {
  console.log(JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32000, message } }));
}

rl.on('line', (line) => {
  try {
    const msg = JSON.parse(line);
    
    if (msg.method === "initialize") {
      sendResponse(msg.id, {
        protocolVersion: 1,
        agentInfo: { name: "Mock ACP", version: "0.0.1" },
        capabilities: { promptCapabilities: { text: true, image: true } }
      });
    }
    else if (msg.method === "session/new") {
      if (authRequired) {
        sendError(msg.id, "Authentication required");
        return;
      }
      sendResponse(msg.id, {
        sessionId,
        configOptions
      });
    }
    else if (msg.method === "session/prompt") {
      if (quotaExceeded) {
        // Send message chunk with quota warning
        sendNotification("session/update", {
          sessionId: msg.params.sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "⚠ Individual quota reached." }
          }
        });
        sendResponse(msg.id, { stopReason: "end_turn" });
        return;
      }
      
      // Send a message chunk
      const response = responses[responseIndex % responses.length];
      responseIndex++;
      
      sendNotification("session/update", {
        sessionId: msg.params.sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: response }
        }
      });
      
      // Send completion
      sendResponse(msg.id, { stopReason: "end_turn" });
    }
    else if (msg.method === "session/reject_permission") {
      sendResponse(msg.id, {});
    }
    else if (msg.method === "session/cancel") {
      // Notification, no response
    }
    else {
      sendResponse(msg.id, {});
    }
  } catch (e) {
    // Ignore parse errors
  }
});
`;

  writeFileSync(scriptPath, script, { mode: 0o755 });

  const proc = spawn("node", [scriptPath], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, NODE_OPTIONS: undefined },
  });

  return {
    process: proc,
    cleanup: () => {
      proc.kill();
      rmSync(scriptDir, { recursive: true, force: true });
    },
  };
}
