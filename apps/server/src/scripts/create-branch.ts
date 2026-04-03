import { buildBranchName } from "../lib/git.js";
import { getNestedValue } from "../lib/config-loader.js";
import type { AutomationScript } from "./types.js";

export const createBranchScript: AutomationScript = {
  metadata: {
    id: "create_branch",
    name: "Create Feature Branch",
    description: "Generates a feature branch name from the task ID and a title derived from the store.",
    helpMd: `
### Create Feature Branch
Derives a branch name from the task ID and a configurable title path in the store.

**Inputs (via \`reads\`):**
- \`title\` — The human-readable title used to build the branch slug.
  Typically mapped from \`analysis.title\` or any store path.

**Output (via \`writes\`):**
- \`branch\` — The generated branch name, e.g. \`feature/a8f6ab1e-add-login-page\`.

**Pipeline example:**
\`\`\`yaml
- name: create_branch
  type: script
  runtime:
    engine: script
    script_id: create_branch
    reads: { title: "analysis.title" }
    writes: [branch]
\`\`\`
`,
    requiredSettings: [],
  },
  handler: async ({ taskId, context, inputs }) => {
    const title = inputs?.title
      ?? getNestedValue(context.store, context.config?.pipeline?.display?.title_path ?? "")
      ?? taskId;
    const branch = buildBranchName(taskId, String(title));
    return { branch };
  },
};
