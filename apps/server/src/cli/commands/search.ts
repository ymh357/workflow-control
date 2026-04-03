import { registryService } from "../../services/registry-service.js";
import type { RegistryPackageSummary } from "../lib/types.js";

export async function searchCommand(
  query: string | undefined,
  typeFilter: string | undefined,
): Promise<void> {
  const results = await registryService.search(query, typeFilter);

  if (results.length === 0) {
    console.log("No packages found.");
    return;
  }

  printTable(results);
}

function printTable(packages: RegistryPackageSummary[]): void {
  const nameW = Math.max(4, ...packages.map((p) => p.name.length));
  const verW = Math.max(7, ...packages.map((p) => p.version.length));
  const typeW = Math.max(4, ...packages.map((p) => p.type.length));
  const descW = Math.max(11, ...packages.map((p) => p.description.length));

  const header = [
    "Name".padEnd(nameW),
    "Version".padEnd(verW),
    "Type".padEnd(typeW),
    "Description".padEnd(descW),
  ].join("  ");

  console.log(header);
  console.log("-".repeat(header.length));

  for (const p of packages) {
    console.log(
      [
        p.name.padEnd(nameW),
        p.version.padEnd(verW),
        p.type.padEnd(typeW),
        p.description.padEnd(descW),
      ].join("  "),
    );
  }
}
