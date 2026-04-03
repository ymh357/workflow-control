import { registryService } from "../../services/registry-service.js";

export async function uninstallCommand(packages: string[]): Promise<void> {
  if (packages.length === 0) {
    console.log("Usage: uninstall <name> [name...]");
    process.exit(1);
  }

  const result = await registryService.uninstall(packages);

  for (const name of result.removed) {
    console.log(`Uninstalled ${name}`);
  }
  for (const name of result.notFound) {
    console.error(`Package "${name}" is not installed.`);
  }

  console.log(`\nUninstalled ${result.removed.length} package(s).`);
}
