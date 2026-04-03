#!/usr/bin/env tsx
/**
 * Registry CLI — search, install, update, and manage configuration packages
 * from the workflow-control-registry.
 *
 * Usage:
 *   npx tsx src/cli/registry.ts <command> [args...] [--flags]
 *
 * Commands:
 *   search [query] [--type=...]    Search registry packages
 *   install <name[@ver]> [...]     Install packages
 *   update [name]                  Update installed packages
 *   list [--type=...]              List installed packages
 *   outdated                       Show packages with available updates
 *   uninstall <name> [...]         Remove installed packages
 *   publish <directory>            Validate and publish a package to registry
 *   bootstrap                      Install all official packages
 */

import { parseArgs } from "node:util";
import { searchCommand } from "./commands/search.js";
import { installCommand } from "./commands/install.js";
import { updateCommand } from "./commands/update.js";
import { listCommand } from "./commands/list.js";
import { outdatedCommand } from "./commands/outdated.js";
import { uninstallCommand } from "./commands/uninstall.js";
import { publishCommand } from "./commands/publish.js";
import { bootstrapCommand } from "./commands/bootstrap.js";

const HELP = `
workflow-control registry CLI

Usage:
  registry <command> [args...] [--flags]

Commands:
  search [query]            Search registry packages
    --type=<type>           Filter by package type

  install <name> [name...]  Install packages from registry
  update [name]             Update installed packages (all if no name given)
  list                      List installed packages
    --type=<type>           Filter by package type

  outdated                  Show packages with available updates
  uninstall <name> [...]    Remove installed packages
  publish <directory>       Validate and publish a package to registry
  bootstrap                 Install all official packages

Options:
  --help, -h                Show this help message
`.trim();

export async function main(): Promise<void> {
  const rawArgs = process.argv.slice(2);

  if (rawArgs.length === 0 || rawArgs[0] === "--help" || rawArgs[0] === "-h") {
    console.log(HELP);
    process.exit(0);
  }

  const command = rawArgs[0];
  const rest = rawArgs.slice(1);

  try {
    switch (command) {
      case "search": {
        const { values, positionals } = parseArgs({
          args: rest,
          allowPositionals: true,
          options: {
            type: { type: "string" },
          },
        });
        await searchCommand(positionals[0], values.type);
        break;
      }

      case "install": {
        const { positionals } = parseArgs({
          args: rest,
          allowPositionals: true,
          options: {},
        });
        await installCommand(positionals);
        break;
      }

      case "update": {
        const { positionals } = parseArgs({
          args: rest,
          allowPositionals: true,
          options: {},
        });
        await updateCommand(positionals[0]);
        break;
      }

      case "list": {
        const { values } = parseArgs({
          args: rest,
          allowPositionals: true,
          options: {
            type: { type: "string" },
          },
        });
        listCommand(values.type);
        break;
      }

      case "outdated": {
        await outdatedCommand();
        break;
      }

      case "uninstall": {
        const { positionals } = parseArgs({
          args: rest,
          allowPositionals: true,
          options: {},
        });
        await uninstallCommand(positionals);
        break;
      }

      case "publish": {
        const { positionals } = parseArgs({
          args: rest,
          allowPositionals: true,
          options: {},
        });
        await publishCommand(positionals[0]);
        break;
      }

      case "bootstrap": {
        await bootstrapCommand();
        break;
      }

      default:
        console.error(`Unknown command: ${command}`);
        console.log(HELP);
        process.exit(1);
    }
  } catch (err) {
    console.error(`Error: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }
}

// Only auto-run when executed directly (not when imported by tests)
if (process.env.VITEST !== "true") {
  main();
}
