/**
 * Antigravity CLI (`agy acp`) provider for HealthLog.
 *
 * Speaks ACP v1 (JSON-RPC 2.0, one message per line) over the stdio of an
 * `agy acp` child process. Each call starts its own child process and ACP
 * session, and nothing is shared between calls.
 *
 * Guarantees:
 * - The child runs in an empty temporary workspace, deleted when the call ends.
 * - The child gets an allowlisted environment only, so app secrets stay out.
 * - The child runs with `--gemini-dir` set to the operator's profile root and
 *   `--app-data-dir` set to the user's profile id. Without `--gemini-dir` the
 *   CLI keeps its state under $HOME/.gemini, which every user would share.
 * - The agent gets no MCP servers and no fs or terminal capabilities.
 * - Every permission request from the agent is refused.
 *
 * Checked against agy 1.5.8: the flags, the `initialize` shape, the
 * "Authentication required" error on a fresh profile, and a live E2E run on
 * 2026-11-13 (probe + text completion + streaming, gemini-3.8-flash,
 * image/PDF capabilities confirmed).
 *
 * @see docs/antigravity-cli-architecture.md
 * @see docs/antigravity-cli-transport-decision.md
 */

import { existsSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { isAbsolute, join } from "path";
import { AcpConnection, type JsonRpcResponse } from "./antigravity-acp";
import { ANTIGRAVITY_ERRORS, AntigravityError } from "./antigravity-errors";

export {
  ANTIGRAVITY_ERRORS,
  AntigravityError,
  antigravityReasonOf,
  type AntigravityFailureReason,
} from "./antigravity-errors";
import type {
  AIProvider,
  AiContentPart,
  AiMessage,
  CompletionParams,
  CompletionResult,
  ProviderType,
} from "./types";

// ─── Constants ───────────────────────────────────────────────

/** Operator-set root that holds one profile directory per user id. */
const PROFILE_ROOT_ENV = "ANTIGRAVITY_PROFILE_ROOT";
const USER_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/** Image MIME types accepted by ACP `image` blocks. */
const ALLOWED_IMAGE_MIMES = new Set(["image/jpeg", "image/png", "image/webp"]);

/** Document MIME types accepted by ACP `resource` blocks. */
const ALLOWED_DOCUMENT_MIMES = new Set(["application/pdf"]);

/** Environment variables passed to the child. Everything else is dropped. */
const CHILD_ENV_ALLOWLIST = [
  "PATH",
  "HOME",
  "USER",
  "LANG",
  "LC_ALL",
  "TZ",
  "TMPDIR",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_CACHE_HOME",
  "XDG_STATE_HOME",
] as const;

const PROTOCOL_VERSION = 1;
const SETUP_TIMEOUT_MS = 30_000;
const DEFAULT_PROMPT_TIMEOUT_MS = 60_000;

const ROLE_LABEL: Record<AiMessage["role"], string> = {
  user: "User",
  assistant: "Assistant",
  tool: "Tool result",
};

// ─── Profile directory ───────────────────────────────────────

/**
 * The profile directory the CLI must use for this user, or null when none is
 * set up. Null means the provider must not run: without an isolated profile
 * the CLI would fall back to the server's login, which every user shares.
 *
 * The directory must already exist. Nothing in HealthLog creates it yet.
 *
 * IMPORTANT: When ANTIGRAVITY_PROFILE_ROOT is set, HealthLog stores a
 * profileId (32-char hex) in the user record and uses that as the directory
 * name, NOT the user's database ID. This function accepts the stored
 * profileId, not the database userId.
 */
export function antigravityProfileDir(profileId: string): string | null {
  const root = process.env[PROFILE_ROOT_ENV];
  if (!root || !isAbsolute(root) || !USER_ID_PATTERN.test(profileId))
    return null;
  const dir = join(root, profileId);
  return existsSync(dir) ? dir : null;
}

/**
 * Where the CLI keeps one user's state, as the two flags that select it.
 * `geminiDir` is the per-user directory. `appDataDir` is left empty; with
 * the per-user geminiDir the `--app-data-dir` flag is not needed and would
 * create an unwanted nested subdirectory.
 */
export interface AntigravityProfileLocation {
  geminiDir: string;
}

/** The location for this user, or null when the profile does not exist yet. */
export function antigravityProfileLocation(
  profileId: string,
): AntigravityProfileLocation | null {
  if (antigravityProfileDir(profileId) === null) return null;
  // geminiDir is the per-user directory (not the shared root). The CLI stores
  // the OAuth token at <geminiDir>/antigravity-oauth-token, so it must point
  // to the user's own directory to keep credentials isolated and to place the
  // token file inside the volume-mounted path where it survives container
  // recreates.
  const root = process.env[PROFILE_ROOT_ENV] as string;
  return {
    geminiDir: join(root, profileId),
  };
}

// ─── ACP wire types ──────────────────────────────────────────

interface AcpInitializeResult {
  agentInfo?: { name?: string };
  /** The CLI reports prompt support here. `embeddedContext` covers embedded resources such as PDFs. */
  agentCapabilities?: {
    promptCapabilities?: {
      image?: boolean;
      audio?: boolean;
      embeddedContext?: boolean;
    };
  };
}

/** Prompt input the CLI accepts, as negotiated in `initialize`. */
export type AntigravityPromptCapabilities = {
  image: boolean;
  embeddedContext: boolean;
};

interface AcpSessionNewResult {
  sessionId?: string;
  configOptions?: unknown;
}

/** One model the CLI offers in a profile. */
export interface AntigravityModel {
  id: string;
  name: string;
}

/** The model selector from a session's `configOptions`. */
export interface AntigravityModelOptions {
  /** The `configId` that `session/set_config_option` takes. */
  configId: string;
  models: AntigravityModel[];
  /** The model the CLI uses when none is selected. */
  currentModel: string | null;
}

/**
 * Read the model selector out of a session's `configOptions`. The option is
 * the one with category `model` (or id `model`) and type `select`. Grouped
 * option lists are flattened. Null when the CLI offers no model selector.
 */
export function modelOptionsOf(
  configOptions: unknown,
): AntigravityModelOptions | null {
  if (!Array.isArray(configOptions)) return null;
  const option = configOptions.find(
    (o): o is Record<string, unknown> =>
      typeof o === "object" &&
      o !== null &&
      ((o as { category?: unknown }).category === "model" ||
        (o as { id?: unknown }).id === "model") &&
      (o as { type?: unknown }).type === "select",
  );
  if (!option || typeof option.id !== "string") return null;
  if (!Array.isArray(option.options)) return null;

  const entries: unknown[] = [];
  for (const entry of option.options as unknown[]) {
    if (typeof entry === "object" && entry !== null && "options" in entry) {
      const group = (entry as { options?: unknown }).options;
      if (Array.isArray(group)) entries.push(...group);
    } else {
      entries.push(entry);
    }
  }

  const models: AntigravityModel[] = [];
  for (const entry of entries) {
    if (typeof entry !== "object" || entry === null) continue;
    const { value, name } = entry as { value?: unknown; name?: unknown };
    if (typeof value !== "string" || value.length === 0) continue;
    models.push({
      id: value,
      name: typeof name === "string" && name.length > 0 ? name : value,
    });
  }

  return {
    configId: option.id,
    models,
    currentModel:
      typeof option.currentValue === "string" ? option.currentValue : null,
  };
}

interface AcpPromptResult {
  stopReason?: string;
}

type AcpPromptBlock =
  | { type: "text"; text: string }
  | { type: "image"; mimeType: string; data: string }
  | {
      type: "resource";
      resource: { uri: string; mimeType: string; blob: string };
    };

// ─── Request helpers ─────────────────────────────────────────

/** The environment every `agy` child runs with. Only allowlisted variables pass.
 * HOME is overridden to the user's profile directory so that agy's file-based
 * token storage writes to the volume-mounted path instead of the container's
 * ephemeral $HOME. Without this, the OAuth token disappears on every container
 * recreate and the user must re-login.
 */
export function antigravityChildEnv(
  profileDir?: string,
): NodeJS.ProcessEnv {
  const env = {} as NodeJS.ProcessEnv;
  for (const key of CHILD_ENV_ALLOWLIST) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  // Override $HOME so agy stores its token (and other home-relative files)
  // under the per-user profile directory, which is volume-mounted and persists
  // across container recreates. The XDG variables follow the same override so
  // nothing leaks into the container's default home directory.
  // When profileDir is not provided (e.g. for the CLI version probe in the
  // status route) the app's own HOME is used as-is.
  if (profileDir) {
    env.HOME = profileDir;
    env.XDG_DATA_HOME = join(profileDir, ".local", "share");
    env.XDG_CONFIG_HOME = join(profileDir, ".config");
    env.XDG_CACHE_HOME = join(profileDir, ".cache");
    env.XDG_STATE_HOME = join(profileDir, ".local", "state");
  }
  return env;
}

/** Arguments that start the ACP server for one user's profile. */
function acpArgs(profile: AntigravityProfileLocation): string[] {
  return [
    "acp",
    "--sandbox",
    "--disable-telemetry",
    "--gemini-dir",
    profile.geminiDir,
  ];
}

function initializeParams() {
  return {
    protocolVersion: PROTOCOL_VERSION,
    clientInfo: { name: "HealthLog", version: "1.0.0" },
    // The server advertises systemPrompt.append: true in its initialize
    // response. Sending systemPrompt here injects it into the model's
    // actual system instructions (not just the conversation text), making
    // it effective against cascade/planning mode.
    systemPrompt: AGY_NO_TOOL_HINT,
  };
}

/** Read the prompt capabilities out of an `initialize` result. Missing means unsupported. */
function promptCapabilitiesOf(
  init: AcpInitializeResult | undefined,
): AntigravityPromptCapabilities {
  const caps = init?.agentCapabilities?.promptCapabilities;
  return {
    image: caps?.image === true,
    embeddedContext: caps?.embeddedContext === true,
  };
}

/** The text of a message's content, with media parts left out. */
function textOf(content: AiMessage["content"]): string {
  if (typeof content === "string") return content;
  return content
    .filter(
      (part): part is Extract<AiContentPart, { type: "text" }> =>
        part.type === "text",
    )
    .map((part) => part.text)
    .join("\n");
}

/**
 * Turn the request into ACP prompt blocks: one text block (system prompt
 * followed by the conversation), then one block per attached image or PDF.
 */

/**
 * Injected into every agy session via two channels:
 *   1. The ACP `initialize` systemPrompt field (model's actual system prompt)
 *   2. Prepended to every conversation text block (belt-and-suspenders)
 *
 * Without it the model enters cascade/agentic mode (jetski) and attempts to
 * execute internal planning steps (Step_Generic). With --sandbox those steps
 * are refused and the session returns empty content; without --sandbox the
 * cascade runs indefinitely (jetski_mode_turbo, 3-min timeout).
 */
const AGY_NO_TOOL_HINT =
  "You are a conversational assistant. Respond directly with plain text. Do not use any internal tools, planning steps, or execution steps. Provide your complete answer in a single text reply.";

function buildPromptBlocks(params: CompletionParams): AcpPromptBlock[] {
  const { messages } = params;
  const single = messages.length === 1 && messages[0].role === "user";
  const body = single
    ? textOf(messages[0].content)
    : messages
        .map((m) => `${ROLE_LABEL[m.role]}: ${textOf(m.content)}`)
        .join("\n\n");
  // Append the no-tool hint to the system prompt. It keeps the model from
  // entering agentic mode; placing it in the system block ensures agy treats
  // it as an instruction rather than part of the conversation.
  const system = params.system
    ? `${params.system}\n\n${AGY_NO_TOOL_HINT}`
    : AGY_NO_TOOL_HINT;
  const text = [system, body].filter(Boolean).join("\n\n");

  const blocks: AcpPromptBlock[] = [];
  if (text) blocks.push({ type: "text", text });

  let documents = 0;
  for (const message of messages) {
    if (typeof message.content === "string") continue;
    for (const part of message.content) {
      if (part.type === "image") {
        if (!ALLOWED_IMAGE_MIMES.has(part.mediaType)) {
          throw new AntigravityError(
            `Unsupported image MIME type: ${part.mediaType}`,
            ANTIGRAVITY_ERRORS.PROMPT_FAILED,
          );
        }
        blocks.push({
          type: "image",
          mimeType: part.mediaType,
          data: part.dataBase64,
        });
      } else if (part.type === "document") {
        if (!ALLOWED_DOCUMENT_MIMES.has(part.mediaType)) {
          throw new AntigravityError(
            `Unsupported document MIME type: ${part.mediaType}`,
            ANTIGRAVITY_ERRORS.PROMPT_FAILED,
          );
        }
        documents += 1;
        blocks.push({
          type: "resource",
          resource: {
            uri: `healthlog://attachment-${documents}.pdf`,
            mimeType: part.mediaType,
            blob: part.dataBase64,
          },
        });
      }
    }
  }
  return blocks;
}

/**
 * Make the session use `model`. The model must be one the CLI offers in this
 * session, otherwise the call fails before any prompt is sent.
 */
async function selectModel(
  connection: AcpConnection,
  sessionId: string,
  options: AntigravityModelOptions | null,
  model: string,
): Promise<void> {
  if (!options || !options.models.some((m) => m.id === model)) {
    throw new AntigravityError(
      "Antigravity model is not available",
      ANTIGRAVITY_ERRORS.MODEL_UNAVAILABLE,
    );
  }
  if (options.currentModel === model) return;
  resultOrThrow(
    await connection.call(
      "session/set_config_option",
      { sessionId, configId: options.configId, value: model },
      SETUP_TIMEOUT_MS,
    ),
    ANTIGRAVITY_ERRORS.SESSION_FAILED,
    "Antigravity model could not be selected",
  );
}

function cancelledError(): AntigravityError {
  return new AntigravityError(
    "Request cancelled",
    ANTIGRAVITY_ERRORS.CANCELLED,
  );
}

/** Unwrap a response, or throw with a generic message. The CLI text stays in originalError. */
function resultOrThrow<T>(
  response: JsonRpcResponse,
  code: string,
  label: string,
): T {
  if (response.error) {
    const authRequired = /authentication required/i.test(
      response.error.message,
    );
    throw new AntigravityError(
      label,
      authRequired ? ANTIGRAVITY_ERRORS.AUTH_REQUIRED : code,
      response.error,
    );
  }
  return response.result as T;
}

// ─── Client ──────────────────────────────────────────────────

interface AntigravityClientOptions {
  /**
   * The user's profile. Get it from {@link antigravityProfileLocation}. A
   * client without a profile would run under the shared login, so there is no
   * default.
   */
  profile: AntigravityProfileLocation;
  /**
   * The model the user picked. Null or missing keeps the CLI's own default.
   * A model the CLI does not offer fails the call.
   */
  model?: string | null;
  /** Prompt timeout used when the call does not set `timeoutMs`. */
  timeoutMs?: number;
}

export class AntigravityClient implements AIProvider {
  readonly type: ProviderType = "antigravity";
  /** ACP tools are the agent's own tools, not HealthLog function calling. */
  readonly supportsTools = false;

  constructor(private readonly options: AntigravityClientOptions) {}

  async generateCompletion(
    params: CompletionParams,
  ): Promise<CompletionResult> {
    return this.run(params);
  }

  async generateCompletionStream(
    params: CompletionParams,
    onDelta: (delta: string) => void,
  ): Promise<CompletionResult> {
    return this.run(params, onDelta);
  }

  private async run(
    params: CompletionParams,
    onDelta?: (delta: string) => void,
  ): Promise<CompletionResult> {
    const { signal } = params;
    if (signal?.aborted) throw cancelledError();

    const blocks = buildPromptBlocks(params);
    const workDir = mkdtempSync(join(tmpdir(), "healthlog-acp-"));
    const state: { connection: AcpConnection | null; done: boolean } = {
      connection: null,
      done: false,
    };

    let onAbort: (() => void) | undefined;
    const cancelled = new Promise<never>((_, reject) => {
      onAbort = () => reject(cancelledError());
      signal?.addEventListener("abort", onAbort, { once: true });
    });
    // The race below handles the rejection. This keeps it from surfacing as
    // unhandled when the work finishes first.
    cancelled.catch(() => undefined);

    try {
      const execution = this.execute(workDir, blocks, params, onDelta, state);
      execution.catch(() => undefined);
      return await Promise.race([execution, cancelled]);
    } finally {
      state.done = true;
      if (onAbort) signal?.removeEventListener("abort", onAbort);
      await state.connection?.close();
      rmSync(workDir, { recursive: true, force: true });
    }
  }

  private async execute(
    workDir: string,
    blocks: AcpPromptBlock[],
    params: CompletionParams,
    onDelta: ((delta: string) => void) | undefined,
    state: { connection: AcpConnection | null; done: boolean },
  ): Promise<CompletionResult> {
    const args = acpArgs(this.options.profile);

    const connection = await AcpConnection.start(args, {
      cwd: workDir,
      env: antigravityChildEnv(
        join(this.options.profile.geminiDir),
      ),
    });
    state.connection = connection;
    if (state.done) {
      // The call was cancelled while the process was starting.
      await connection.close();
      throw cancelledError();
    }

    const chunks: string[] = [];
    connection.onSessionUpdate = (update) => {
      if (
        update.sessionUpdate === "agent_message_chunk" &&
        update.content?.type === "text" &&
        typeof update.content.text === "string"
      ) {
        chunks.push(update.content.text);
        onDelta?.(update.content.text);
      }
    };

    const init = resultOrThrow<AcpInitializeResult>(
      await connection.call("initialize", initializeParams(), SETUP_TIMEOUT_MS),
      ANTIGRAVITY_ERRORS.SESSION_FAILED,
      "Antigravity initialize failed",
    );

    const promptCaps = promptCapabilitiesOf(init);
    if (blocks.some((b) => b.type === "image") && !promptCaps.image) {
      throw new AntigravityError(
        "Antigravity does not accept image input",
        ANTIGRAVITY_ERRORS.PROMPT_FAILED,
      );
    }
    if (
      blocks.some((b) => b.type === "resource") &&
      !promptCaps.embeddedContext
    ) {
      throw new AntigravityError(
        "Antigravity does not accept PDF input",
        ANTIGRAVITY_ERRORS.PROMPT_FAILED,
      );
    }

    const session = resultOrThrow<AcpSessionNewResult>(
      await connection.call(
        "session/new",
        // agentScript: true was tested and had no effect — agy ignores it.
        // The cascade is suppressed instead via systemPrompt in initializeParams.
        { cwd: workDir, mcpServers: [] },
        SETUP_TIMEOUT_MS,
      ),
      ANTIGRAVITY_ERRORS.SESSION_FAILED,
      "Antigravity session could not be created",
    );
    if (typeof session?.sessionId !== "string") {
      throw new AntigravityError(
        "Antigravity session could not be created",
        ANTIGRAVITY_ERRORS.SESSION_FAILED,
      );
    }

    const modelOptions = modelOptionsOf(session.configOptions);
    const selected = this.options.model ?? null;
    if (selected) {
      await selectModel(connection, session.sessionId, modelOptions, selected);
    }

    const timeoutMs =
      params.timeoutMs ?? this.options.timeoutMs ?? DEFAULT_PROMPT_TIMEOUT_MS;
    const response = await connection.call(
      "session/prompt",
      { sessionId: session.sessionId, prompt: blocks },
      timeoutMs,
    );
    const stopReason = (response.result as AcpPromptResult | undefined)
      ?.stopReason;
    const content = chunks.join("");
    if (response.error) {
      const quota = /quota/i.test(response.error.message);
      throw new AntigravityError(
        quota ? "Antigravity quota exceeded" : "Antigravity prompt failed",
        quota
          ? ANTIGRAVITY_ERRORS.QUOTA_EXCEEDED
          : ANTIGRAVITY_ERRORS.PROMPT_FAILED,
        response.error,
      );
    }

    // A "cancelled" stop reason can appear when the CLI's sandbox rejects an
    // internal step (e.g. a Step_Generic from the agy backend), even though
    // the AI already emitted a complete text reply. Only treat it as an error
    // when no content arrived at all.
    if (stopReason === "cancelled" && !content) {
      throw new AntigravityError(
        "Antigravity cancelled the turn",
        ANTIGRAVITY_ERRORS.PROMPT_FAILED,
      );
    }
    if (!content) {
      throw new AntigravityError(
        "Antigravity returned an empty reply",
        ANTIGRAVITY_ERRORS.PROMPT_FAILED,
      );
    }

    return {
      content,
      tokensUsed: null,
      // The model the session ran on, as the CLI reports it. Without a
      // reported model, the provider id is recorded.
      model: selected ?? modelOptions?.currentModel ?? "antigravity",
      providerType: "antigravity",
      finishReason: stopReason === "max_tokens" ? "length" : "stop",
    };
  }
}

/**
 * Start the CLI for one profile and open a session, without sending any
 * prompt. The connection test uses this. It proves the profile is logged in,
 * and it reports the prompt capabilities. The profile's auth state decides the
 * outcome: "Authentication required" maps to AUTH_REQUIRED.
 */
export async function probeAntigravity(
  profile: AntigravityProfileLocation,
): Promise<{
  capabilities: AntigravityPromptCapabilities;
  agentName: string | null;
  /** The model selector the CLI offers, or null when it offers none. */
  modelOptions: AntigravityModelOptions | null;
}> {
  const workDir = mkdtempSync(join(tmpdir(), "healthlog-acp-"));
  let connection: AcpConnection | null = null;
  try {
    connection = await AcpConnection.start(acpArgs(profile), {
      cwd: workDir,
      env: antigravityChildEnv(profile.geminiDir),
    });
    const init = resultOrThrow<AcpInitializeResult>(
      await connection.call("initialize", initializeParams(), SETUP_TIMEOUT_MS),
      ANTIGRAVITY_ERRORS.SESSION_FAILED,
      "Antigravity initialize failed",
    );
    const session = resultOrThrow<AcpSessionNewResult>(
      await connection.call(
        "session/new",
        { cwd: workDir, mcpServers: [] },
        SETUP_TIMEOUT_MS,
      ),
      ANTIGRAVITY_ERRORS.SESSION_FAILED,
      "Antigravity session could not be created",
    );
    return {
      capabilities: promptCapabilitiesOf(init),
      agentName: init?.agentInfo?.name ?? null,
      modelOptions: modelOptionsOf(session?.configOptions),
    };
  } finally {
    await connection?.close();
    rmSync(workDir, { recursive: true, force: true });
  }
}

// ─── Provider wiring ─────────────────────────────────────────

/** Whether a stored profile id has a profile folder on the server. */
export function antigravityAvailable(profileId: string | null): boolean {
  return profileId !== null && antigravityProfileLocation(profileId) !== null;
}

/**
 * The client for a user's stored profile and model. Null when the user has no
 * profile, or the profile folder is gone.
 */
export function antigravityProviderFor(user: {
  antigravityProfileId: string | null;
  antigravityModel: string | null;
}): AntigravityClient | null {
  if (!user.antigravityProfileId) return null;
  const profile = antigravityProfileLocation(user.antigravityProfileId);
  if (!profile) return null;
  return new AntigravityClient({ profile, model: user.antigravityModel });
}
