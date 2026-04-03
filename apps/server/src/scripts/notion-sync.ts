import { scriptRegistration } from "../lib/scripts.js";
import type { AutomationScript } from "./types.js";


export const notionSyncScript: AutomationScript = {
  metadata: {
    id: "notion_sync",
    name: "Notion Sync",
    description: "Registers the task in Notion and synchronizes metadata.",
    helpMd: `
### Notion Sync
Synchronizes task metadata (title, branch, etc.) with the Notion sprint board.

**Inputs (via \`reads\`):**
- \`analysis\` — Map from store key \`analysis\` (written by the analysis stage).
  Do NOT add \`branch\` or \`worktreePath\` to reads — the engine automatically
  syncs these to context, which this script reads directly.

**Output (via \`writes\`):**
- \`notionSync\` — Object: \`{ notionPageId: "..." }\`. Contains the Notion page ID for the task.

**Optional args:**
- \`notion_status_label\` — Custom status label to set on the Notion page (via \`runtime.args\`).

**Prerequisites:**
- \`notion.token\` and \`notion.sprint_board_id\` must be configured in system-settings.yaml (supports \${VAR} interpolation).
`,
    requiredSettings: ["notion.sprint_board_id"],
  },
  handler: async ({ taskId, context, settings, inputs, args }) => {
    return scriptRegistration({
      taskId,
      analysis: inputs?.analysis ?? {},
      branch: context.branch ?? "",
      worktreePath: context.worktreePath,
      notionStatusLabel: args?.notion_status_label,
      settings,
    });
  },
};
