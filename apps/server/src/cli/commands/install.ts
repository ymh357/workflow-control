import { registryService } from "../../services/registry-service.js";

export async function installCommand(packages: string[]): Promise<void> {
  if (packages.length === 0) {
    console.log("Usage: install <name[@version]> [name[@version]...]");
    process.exit(1);
  }

  const result = await registryService.install(packages);

  for (const pkg of result.installed) {
    console.log(`Installed ${pkg.name}@${pkg.version} (${pkg.type})`);
  }
  for (const skip of result.skipped) {
    console.log(`Skipped ${skip.name}: ${skip.reason}`);
  }

  console.log(`\nInstalled ${result.installed.length} package(s).`);
}
