import { registryService } from "../../services/registry-service.js";
import { fetchIndex } from "../lib/fetch.js";

export async function bootstrapCommand(): Promise<void> {
  console.log("Bootstrapping: installing all registry packages...\n");

  const index = await fetchIndex();
  const allPackages = index.packages.map((p) => p.name);

  const result = await registryService.bootstrap(allPackages);

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
