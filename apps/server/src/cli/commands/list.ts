import { registryService } from "../../services/registry-service.js";

export function listCommand(typeFilter: string | undefined): void {
  const packages = registryService.listInstalled(typeFilter);
  const entries = Object.entries(packages);

  if (entries.length === 0) {
    console.log("No packages installed.");
    return;
  }

  const nameW = Math.max(4, ...entries.map(([n]) => n.length));
  const verW = Math.max(7, ...entries.map(([, e]) => e.version.length));
  const typeW = Math.max(4, ...entries.map(([, e]) => e.type.length));
  const authorW = Math.max(6, ...entries.map(([, e]) => e.author.length));

  const header = [
    "Name".padEnd(nameW),
    "Version".padEnd(verW),
    "Type".padEnd(typeW),
    "Author".padEnd(authorW),
  ].join("  ");

  console.log(header);
  console.log("-".repeat(header.length));

  for (const [name, entry] of entries) {
    console.log(
      [
        name.padEnd(nameW),
        entry.version.padEnd(verW),
        entry.type.padEnd(typeW),
        entry.author.padEnd(authorW),
      ].join("  "),
    );
  }
}
