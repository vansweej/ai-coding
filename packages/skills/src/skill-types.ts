import type { AIAction } from "@ai-coding/shared";

/**
 * Narrow context passed to skill resolution.
 * Deliberately minimal — evolved only when consumers need more.
 */
export interface RetrievalContext {
  /** The AI action being performed — primary routing signal for action skills. */
  readonly action: AIAction;
  /**
   * Absolute path to the workspace directory.
   * Used to detect project type (Rust, C++, TypeScript) for domain skill selection.
   * When omitted, workspace-type detection returns "unknown".
   */
  readonly workspace?: string;
  /**
   * The user's request text (e.g. event.payload.input).
   * Used by the vector backend to build a richer semantic query so retrieval
   * matches the actual task, not just the action label.
   * Ignored by the file backend.
   */
  readonly query?: string;
}

/**
 * A single resolved skill with its content and optional relevance score.
 * The relevance field is populated by the vector backend (Phase 2);
 * the file backend always leaves it undefined.
 */
export interface ResolvedSkill {
  /** Skill name matching the directory under the skill root (e.g. "programmer"). */
  readonly name: string;
  /** Full content of the skill file, ready for injection into a system prompt. */
  readonly content: string;
  /**
   * Relevance score from the vector backend (0.0–1.0).
   * Undefined when using the file backend.
   */
  readonly relevance?: number;
}

/**
 * Pluggable backend interface for skill resolution.
 * Consumers are blind to whether the backend reads files or queries a vector DB.
 */
export interface SkillBackend {
  resolve(context: RetrievalContext): Promise<readonly ResolvedSkill[]>;
}

/**
 * Detected workspace project type, derived from filesystem marker files.
 * Used to select domain-specific skills (rust, cpp) in addition to action skills.
 */
export type WorkspaceType = "rust" | "cpp" | "typescript" | "unknown";
