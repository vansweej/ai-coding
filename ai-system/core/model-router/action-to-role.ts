import type { AIAction } from "@ai-coding/shared";

import type { ModelRole } from "../../config/model-profiles";

/**
 * Map an AI action to its corresponding semantic model role.
 *
 * This allows pipeline steps to declare what they *do* semantically rather
 * than hard-coding model names. The role is then resolved to a model ID via
 * the active ModelProfile.
 *
 * @param action - The AIAction from the request event.
 * @returns The ModelRole that best represents the given action.
 */
export function actionToRole(action: AIAction): ModelRole {
  switch (action) {
    case "plan":
      return "planner";
    case "debug":
      return "debugger";
    case "edit":
    case "refactor":
    case "task":
      return "implementer";
    case "explore":
      return "explorer";
    case "explain":
    case "chat":
      return "default";
  }
}
