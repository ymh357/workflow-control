import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const REGISTRY_BASE_URL =
  process.env.OG_REGISTRY_URL ||
  "https://raw.githubusercontent.com/ymh357/workflow-control-registry/main/";

export const REGISTRY_DIR =
  process.env.OG_REGISTRY_DIR ||
  path.resolve(__dirname, "../../../../../registry");

export const CONFIG_DIR = path.resolve(__dirname, "../../../config");

export const LOCK_FILE_NAME = ".wfctl-registry.lock";
export const LOCK_VERSION = 1;

// Map package type to config subdirectory
export const TYPE_DIR_MAP: Record<string, string> = {
  pipeline: "pipelines",
  skill: "skills",
  fragment: "prompts/fragments",
  hook: "hooks",
  gate: "gates",
  script: "scripts",
  mcp: "mcps",
};
