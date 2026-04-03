import { existsSync, cpSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_DIR } from "./config/settings.js";
import { logger } from "./logger.js";

const BUILTIN_DIR = join(import.meta.dirname ?? new URL(".", import.meta.url).pathname, "..", "builtin-pipelines");
const BUILTIN_PIPELINES = ["pipeline-generator"];

export function installBuiltinPipelines(): void {
  const targetDir = join(CONFIG_DIR, "pipelines");
  mkdirSync(targetDir, { recursive: true });

  for (const name of BUILTIN_PIPELINES) {
    const sourcePath = join(BUILTIN_DIR, name);
    const destPath = join(targetDir, name);

    if (!existsSync(sourcePath)) {
      logger.warn({ name, sourcePath }, "Builtin pipeline source not found, skipping");
      continue;
    }

    if (!existsSync(join(destPath, "pipeline.yaml"))) {
      logger.info({ name }, "Installing builtin pipeline");
      cpSync(sourcePath, destPath, { recursive: true });
    }
  }
}
