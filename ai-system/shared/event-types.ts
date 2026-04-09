export type AISource = "nvim" | "cli" | "agent" | "api";

export type AIModeHint = "editor" | "agentic" | "auto";

export type AIAction =
  | "explain"
  | "edit"
  | "refactor"
  | "plan"
  | "debug"
  | "chat"
  | "task";

export type AIRequestEvent = {
  id: string;
  timestamp: number;

  source: AISource;
  modeHint?: AIModeHint;

  action: AIAction;

  payload: {
    input?: string;
    file?: string;
    selection?: string;
    workspace?: string;
    metadata?: Record<string, any>;
  };

  context?: Record<string, any>;
};
