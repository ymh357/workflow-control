import { registryService } from "../../services/registry-service.js";

export async function outdatedCommand(): Promise<void> {
  const outdated = await registryService.checkOutdated();

  if (outdated.length === 0) {
    console.log("All packages are up to date.");
    return;
  }

  const nameW = Math.max(4, ...outdated.map((o) => o.name.length));
  const instW = Math.max(9, ...outdated.map((o) => o.installed.length));
  const latW = Math.max(6, ...outdated.map((o) => o.latest.length));
  const typeW = Math.max(4, ...outdated.map((o) => o.type.length));

  const header = [
    "Name".padEnd(nameW),
    "Installed".padEnd(instW),
    "Latest".padEnd(latW),
    "Type".padEnd(typeW),
  ].join("  ");

  console.log(header);
  console.log("-".repeat(header.length));

  for (const o of outdated) {
    console.log(
      [
        o.name.padEnd(nameW),
        o.installed.padEnd(instW),
        o.latest.padEnd(latW),
        o.type.padEnd(typeW),
      ].join("  "),
    );
  }
}
