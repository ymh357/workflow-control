import { scriptRegistry } from "./registry.js";
import { createBranchScript } from "./create-branch.js";
import { gitWorktreeScript } from "./git-worktree.js";
import { notionSyncScript } from "./notion-sync.js";
import { prCreationScript } from "./pr-creation.js";
import { buildGateScript } from "./build-gate.js";
import { persistPipelineScript } from "./persist-pipeline.js";

// Register all core scripts
scriptRegistry.register(createBranchScript);
scriptRegistry.register(gitWorktreeScript);
scriptRegistry.register(notionSyncScript);
scriptRegistry.register(prCreationScript);
scriptRegistry.register(buildGateScript);
scriptRegistry.register(persistPipelineScript);

export { scriptRegistry };
export * from "./types.js";
