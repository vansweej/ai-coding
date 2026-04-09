import type { AIMode, AIRequestEvent } from "@ai-coding/shared";

/** Select the best model for a given request event and operating mode. */
export function selectModel(event: AIRequestEvent, mode: AIMode): string {
  if (mode === "agentic") {
    if (event.action === "plan") return "claude-sonnet";
    if (event.action === "debug") return "deepseek-coder-v2";
    return "qwen2.5-coder:7b";
  }

  // editor mode = always local
  return "qwen2.5-coder:7b";
}
