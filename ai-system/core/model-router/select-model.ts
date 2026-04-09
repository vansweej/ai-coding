export function selectModel(event, mode) {
  if (mode === "agentic") {
    if (event.action === "plan") return "claude-sonnet";
    if (event.action === "debug") return "deepseek-coder-v2";
    return "qwen2.5-coder:7b";
  }

  // editor mode = always local
  return "qwen2.5-coder:7b";
}
