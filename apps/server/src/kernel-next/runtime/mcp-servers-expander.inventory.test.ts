import { describe, it, expect } from "vitest";
import { expandMcpServers } from "./mcp-servers-expander.js";
import type { McpServerDecl } from "../ir/schema.js";

const decl: McpServerDecl = {
  name: "etherscan",
  command: "npx",
  args: ["-y", "@scope/etherscan-mcp"],
  envKeys: ["ETHERSCAN_API_KEY"],
  env: { ETHERSCAN_API_KEY: "${ETHERSCAN_API_KEY}" },
};

describe("expandMcpServers — inventory layer", () => {
  it("inventory resolver value beats process.env", () => {
    const result = expandMcpServers(
      [decl], {}, { ETHERSCAN_API_KEY: "from-process-env" } as NodeJS.ProcessEnv,
      { resolveInventorySecret: (k) => (k === "ETHERSCAN_API_KEY" ? "from-inventory" : null) },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error();
    expect(result.servers.etherscan.env?.ETHERSCAN_API_KEY).toBe("from-inventory");
  });

  it("task_env_values still beats inventory", () => {
    const result = expandMcpServers(
      [decl], { ETHERSCAN_API_KEY: "from-task-env" }, {} as NodeJS.ProcessEnv,
      { resolveInventorySecret: (k) => (k === "ETHERSCAN_API_KEY" ? "from-inventory" : null) },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error();
    expect(result.servers.etherscan.env?.ETHERSCAN_API_KEY).toBe("from-task-env");
  });

  it("falls through to process.env when inventory has no value", () => {
    const result = expandMcpServers(
      [decl], {}, { ETHERSCAN_API_KEY: "from-process-env" } as NodeJS.ProcessEnv,
      { resolveInventorySecret: () => null },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error();
    expect(result.servers.etherscan.env?.ETHERSCAN_API_KEY).toBe("from-process-env");
  });

  it("missingKeys still enumerated when no source has the value", () => {
    const result = expandMcpServers(
      [decl], {}, {} as NodeJS.ProcessEnv,
      { resolveInventorySecret: () => null },
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error();
    expect(result.missingKeys).toEqual(["ETHERSCAN_API_KEY"]);
  });

  it("legacy 3-arg form (no inventory option) still works", () => {
    const result = expandMcpServers(
      [decl], { ETHERSCAN_API_KEY: "x" }, {} as NodeJS.ProcessEnv,
    );
    expect(result.ok).toBe(true);
  });
});
