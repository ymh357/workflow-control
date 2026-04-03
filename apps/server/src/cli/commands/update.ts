import { registryService } from "../../services/registry-service.js";

export async function updateCommand(name: string | undefined): Promise<void> {
  const result = await registryService.update(name);

  for (const pkg of result.updated) {
    console.log(`Updated ${pkg.name}: ${pkg.from} -> ${pkg.to}`);
  }
  for (const pkg of result.upToDate) {
    console.log(`${pkg} is already up to date.`);
  }

  console.log(`\nUpdated ${result.updated.length} package(s).`);
}
