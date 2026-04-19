import { existsSync, cpSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_DIR } from "./config/settings.js";
import { logger } from "./logger.js";

const BUILTIN_DIR = join(
  import.meta.dirname ?? new URL(".", import.meta.url).pathname,
  "..",
  "builtin-pipelines",
);

/**
 * Discover builtin pipelines by scanning the source tree. Each
 * direct subdirectory of src/builtin-pipelines/ that contains a
 * pipeline.yaml is treated as a shippable builtin. This keeps the
 * code path additive — dropping a new directory under
 * builtin-pipelines/ ships it on the next server start without a
 * code change. Returns an empty list if the source dir is missing
 * (e.g. unusual install layout) so the caller stays no-op safe.
 */
export function discoverBuiltinPipelines(sourceDir: string = BUILTIN_DIR): string[] {
  if (!existsSync(sourceDir)) return [];
  const entries = readdirSync(sourceDir);
  const discovered: string[] = [];
  for (const name of entries) {
    const entryPath = join(sourceDir, name);
    try {
      if (!statSync(entryPath).isDirectory()) continue;
    } catch {
      continue;
    }
    if (!existsSync(join(entryPath, "pipeline.yaml"))) continue;
    discovered.push(name);
  }
  return discovered.sort();
}

export function installBuiltinPipelines(): void {
  const targetDir = join(CONFIG_DIR, "pipelines");
  mkdirSync(targetDir, { recursive: true });

  const names = discoverBuiltinPipelines();
  for (const name of names) {
    const sourcePath = join(BUILTIN_DIR, name);
    const destPath = join(targetDir, name);

    if (!existsSync(join(destPath, "pipeline.yaml"))) {
      logger.info({ name }, "Installing builtin pipeline");
      cpSync(sourcePath, destPath, { recursive: true });
    }
  }
}
