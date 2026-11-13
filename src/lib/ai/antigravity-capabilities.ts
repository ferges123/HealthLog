/**
 * Capability discovery for Antigravity CLI provider.
 *
 * Discovers available models, thought levels, and other config options
 * from ACP session/new response.
 */

export interface AntigravityCapabilities {
  models: string[];
  thoughtLevels: string[];
  modes: string[];
  promptCapabilities: {
    text: boolean;
    image: boolean;
    audio: boolean;
    resourceBlob: boolean;
  };
  defaultModel?: string;
  defaultThoughtLevel?: string;
}

/**
 * Parse config options from ACP session/new response.
 */
export function parseConfigOptions(configOptions: Array<{
  name: string;
  type: string;
  enum?: string[];
  default?: unknown;
  displayName?: string;
}>): AntigravityCapabilities {
  const caps: AntigravityCapabilities = {
    models: [],
    thoughtLevels: [],
    modes: [],
    promptCapabilities: {
      text: true, // Text is always supported
      image: false,
      audio: false,
      resourceBlob: false,
    },
  };

  for (const opt of configOptions) {
    switch (opt.name.toLowerCase()) {
      case "model":
        caps.models = opt.enum ?? [];
        caps.defaultModel = opt.default as string | undefined;
        break;

      case "thinking level":
      case "thought_level":
      case "thoughtlevel":
        caps.thoughtLevels = opt.enum ?? [];
        caps.defaultThoughtLevel = opt.default as string | undefined;
        break;

      case "mode":
        caps.modes = opt.enum ?? [];
        break;
    }
  }

  return caps;
}

/**
 * Check if a model supports images.
 * TODO: Query actual capabilities from initialize or session/update.
 */
export function modelSupportsImages(model: string): boolean {
  // Conservative: assume no image support until verified
  // Will be updated after PoC confirms capabilities
  return false;
}

/**
 * Check if a model supports PDF.
 * TODO: Query actual capabilities from initialize or session/update.
 */
export function modelSupportsPdf(model: string): boolean {
  // Conservative: assume PDF needs rasterization until verified
  return false;
}
