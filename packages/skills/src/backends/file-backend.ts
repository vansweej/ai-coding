import { homedir } from "node:os";
import { join } from "node:path";

import { detectWorkspaceType } from "../detect-workspace-type";
import { resolveSkillNames } from "../skill-map";
import type { ResolvedSkill, RetrievalContext, SkillBackend } from "../skill-types";

/** Default skill root: Home Manager deploys all skills here. */
const DEFAULT_SKILL_ROOT = join(homedir(), ".config", "opencode", "skills");

/**
 * File-based skill backend that reads `SKILL.md` files from a local directory.
 *
 * Directory layout expected under `skillRoot`:
 * ```
 * skillRoot/
 *   programmer/SKILL.md
 *   debugger/SKILL.md
 *   rust/SKILL.md
 *   cpp/SKILL.md
 *   ...
 * ```
 *
 * Resolution strategy:
 *   1. Detect workspace type from marker files (Cargo.toml, CMakeLists.txt, package.json)
 *   2. Resolve ordered skill names via the static maps (action skills + workspace skills)
 *   3. Read each skill file; skip silently if a file does not exist
 *   4. Return ResolvedSkill[] in resolution order (action skills first, workspace last)
 *
 * This is the Phase 1 backend. The vector backend (Phase 2) will implement the
 * same SkillBackend interface and can be swapped in without changing consumers.
 */
export class FileBackend implements SkillBackend {
  private readonly skillRoot: string;

  /**
   * @param skillRoot - Absolute path to the skill root directory.
   *                    Defaults to `~/.config/opencode/skills`.
   */
  constructor(skillRoot: string = DEFAULT_SKILL_ROOT) {
    this.skillRoot = skillRoot;
  }

  /**
   * Resolve skills for the given context by reading SKILL.md files from disk.
   *
   * Missing skill files are skipped silently — this allows the system to work
   * even when only a subset of skills are installed.
   *
   * @param context - Narrow retrieval context (action + optional workspace path).
   * @returns Ordered array of resolved skills, action skills before workspace skills.
   */
  async resolve(context: RetrievalContext): Promise<readonly ResolvedSkill[]> {
    const workspaceType = await detectWorkspaceType(context.workspace);
    const skillNames = resolveSkillNames(context.action, workspaceType);

    const resolved: ResolvedSkill[] = [];

    for (const name of skillNames) {
      const skillPath = join(this.skillRoot, name, "SKILL.md");
      const file = Bun.file(skillPath);

      if (!(await file.exists())) {
        // Graceful degradation: skip missing skills without failing
        continue;
      }

      const content = await file.text();
      resolved.push({ name, content });
    }

    return resolved;
  }
}
