import { registryService } from "../../services/registry-service.js";

const BOOTSTRAP_PACKAGES = ["test-mixed"];

export async function bootstrapCommand(): Promise<void> {
  console.log("Bootstrapping: installing default packages + all fragments...\n");

  const result = await registryService.bootstrap(BOOTSTRAP_PACKAGES);

  if (result.installed.length > 0) {
    console.log(`Installed ${result.installed.length} package(s):`);
    for (const pkg of result.installed) {
      console.log(`  + ${pkg.name}@${pkg.version} (${pkg.type})`);
    }
  }

  if (result.skipped.length > 0) {
    console.log(`\nSkipped ${result.skipped.length} package(s):`);
    for (const pkg of result.skipped) {
      console.log(`  - ${pkg.name}: ${pkg.reason}`);
    }
  }

  console.log("\nBootstrap complete.");
}
