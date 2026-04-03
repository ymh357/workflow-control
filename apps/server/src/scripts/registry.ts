import type { AutomationScript, ScriptMetadata } from "./types.js";
import { loadDynamicScript } from "../lib/script-loader.js";

class ScriptRegistry {
  private scripts = new Map<string, AutomationScript>();

  register(script: AutomationScript) {
    this.scripts.set(script.metadata.id, script);
  }

  get(id: string): AutomationScript | undefined {
    return this.scripts.get(id);
  }

  /**
   * Returns a built-in script, or attempts to load a dynamic script from config/scripts/.
   */
  async getOrLoadDynamic(id: string): Promise<AutomationScript | undefined> {
    const builtin = this.scripts.get(id);
    if (builtin) return builtin;

    const dynamic = await loadDynamicScript(id);
    if (!dynamic) return undefined;

    const wrapped: AutomationScript = {
      metadata: {
        id,
        name: id,
        description: `Dynamic script: ${id}`,
        helpMd: "",
      },
      handler: async ({ taskId, context, args, inputs }) => {
        return dynamic({
          cwd: context.worktreePath || process.cwd(),
          store: context.store || {},
          args: { ...args, ...inputs },
          taskId,
        });
      },
    };
    return wrapped;
  }

  getAllScripts(): AutomationScript[] {
    return Array.from(this.scripts.values());
  }

  getAllMetadata(): ScriptMetadata[] {
    return Array.from(this.scripts.values()).map(s => s.metadata);
  }
}

export const scriptRegistry = new ScriptRegistry();
