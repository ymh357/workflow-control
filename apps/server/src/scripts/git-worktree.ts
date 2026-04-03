import { createWorktreeForTask } from "../agent/executor.js";
import type { AutomationScript } from "./types.js";

export const gitWorktreeScript: AutomationScript = {
  metadata: {
    id: "git_worktree",
    name: "Git Worktree Setup",
    description: "Creates an isolated git worktree for the task feature branch.",
    helpMd: `
### Git Worktree Setup
This script creates a new directory linked to your main repository, checked out to the feature branch.

**Inputs (via \`reads\`):**
- \`repoName\` — Repository name. Map from \`analysis.repoName\` or similar.
  Do NOT add \`branch\` to reads — the engine automatically syncs \`context.branch\`
  from the store after \`create_branch\` runs, so this script picks it up without reads.

**Output (via \`writes\`):**
- \`worktreePath\` — Object: \`{ worktreePath: "/absolute/path/..." }\`.
  To read the path string in downstream stages, use dot notation: \`worktreePath.worktreePath\`.
  The engine also auto-syncs \`context.worktreePath\`, so downstream scripts that read
  from context directly (like \`pr_creation\`) do NOT need \`reads: { worktreePath: ... }\`.

**Pipeline example:**
\`\`\`yaml
- name: setupWorktree
  type: script
  runtime:
    engine: script
    script_id: git_worktree
    reads:
      repoName: analysis.repoName
    writes: [worktreePath]
\`\`\`
`,
    requiredSettings: [],
  },
  handler: async ({ taskId, context, inputs }) => {
    const repoName = inputs?.repoName ?? context.explicitRepoName ?? "";
    const branch = context.branch ?? "";
    const worktreePath = await createWorktreeForTask(taskId, repoName, branch);
    return { worktreePath };
  },
};
