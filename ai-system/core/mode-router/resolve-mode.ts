import type { AIMode, AISource } from "@ai-coding/shared";

/**
 * Resolve the operating mode from the request source.
 * Source-based: nvim always maps to editor, everything else to agentic.
 */
export function resolveMode(source: AISource): AIMode {
  if (source === "nvim") return "editor";
  return "agentic";
}
