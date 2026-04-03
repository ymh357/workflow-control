import { scriptPRCreation } from "../lib/scripts.js";
import type { AutomationScript } from "./types.js";

export const prCreationScript: AutomationScript = {
  metadata: {
    id: "pr_creation",
    name: "GitHub PR Creation",
    description: "Creates a Pull Request on GitHub with the task results and QA report.",
    helpMd: `
### GitHub PR Creation
Automatically creates a PR on GitHub. Includes the AI-generated description and QA summary.

**Inputs (via \`reads\`):**
- \`analysis\` — Map from store key \`analysis\` (written by the analysis stage).
- \`qaResult\` — Map from store key \`qaResult\` (written by the QA stage).
  Do NOT add \`worktreePath\` or \`branch\` to reads — the engine automatically syncs
  these to \`context.worktreePath\` and \`context.branch\`, which this script reads directly.

**Output (via \`writes\`):**
- \`prUrl\` — Object: \`{ prUrl: "https://github.com/..." }\`.

**Pipeline example:**
\`\`\`yaml
- name: createPR
  type: script
  runtime:
    engine: script
    script_id: pr_creation
    reads:
      analysis: analysis
      qaResult: qaResult
    writes: [prUrl]
\`\`\`

**Prerequisites:**
- \`gh\` CLI must be installed and authenticated.
`,
    requiredSettings: ["github.org"],
  },
  handler: async ({ taskId, context, settings, inputs }) => {
    return scriptPRCreation({
      taskId,
      worktreePath: context.worktreePath ?? "",
      branch: context.branch ?? "",
      analysis: inputs?.analysis ?? {},
      qaResult: inputs?.qaResult ?? {},
      settings,
    });
  },
};
