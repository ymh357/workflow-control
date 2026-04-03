# Prompt: Add Store Reader MCP to Pipeline Agent Stages

## Goal

Give every pipeline agent stage on-demand access to the full workflow store via an in-process MCP tool. This complements static `reads` — `reads` declares must-have data injected into the prompt, while this tool provides dynamic access to any store value the agent discovers it needs at runtime.

## Current State

- `reads` in pipeline YAML maps specific store paths into tier-1 context
- `context-builder.ts` lists un-mapped store keys as tier-2 index:
  ```
  ## Other Available Context (Read files in .workflow/ to see details)
  - apiLayerResult
  - designSystemResult
  ```
- Edge mode agents already have `get_store_value` via edge MCP server
- SDK mode agents have NO way to access store beyond `reads`

## Implementation

### New file: `apps/server/src/lib/store-reader-mcp.ts`

Create a function that returns an MCP server config compatible with the Claude Agent SDK's `mcpServers` option.

**Important**: First check how existing MCP servers are passed to the SDK. Look at `apps/server/src/agent/stage-executor.ts` where `localMcp` is built and passed to `buildQueryOptions`, then look at `query-options-builder.ts` where it becomes `mcpServers`. Check the SDK types for `mcpServers` to determine what formats are accepted:

- If the SDK accepts in-process `McpServer` instances from `@modelcontextprotocol/sdk/server/mcp.js`: create an `McpServer` with a single `get_store_value` tool
- If the SDK only accepts stdio configs (`{ command, args, env }`): use the SDK's custom tool API instead (check for `customTools` or `tools` in the SDK options type)
- If neither works: use a `canUseTool` hook to intercept calls to a virtual tool name

The tool specification regardless of transport:

```
Tool name: get_store_value
Description: "Read a value from the workflow store by dot-notation path.
  Use when you see keys in 'Other Available Context' that you need."
Input: { path: string }  // e.g. "analysis.modules", "refactorPlan.foundationTasks"
Output: JSON-serialized value, truncated at 50KB with a note if larger
Error: list available top-level keys if path not found
```

Use `getNestedValue` from `../lib/config-loader.js` for path resolution.

Handle edge cases: empty store, circular refs in JSON.stringify (catch + error message), very large values (truncate at 50KB).

### Modify: `apps/server/src/agent/stage-executor.ts`

After building `localMcp` from `buildMcpServers(mcpServices, ...)`, inject the store reader. The injection method depends on which SDK format works (determined above). Use `"__store__"` as the server/tool name prefix.

### Modify: `apps/server/src/agent/context-builder.ts`

Update the tier-2 context hint:

```typescript
// Change:
parts.push("\n## Other Available Context (Read files in .workflow/ to see details)");
// To:
parts.push("\n## Other Available Context (use get_store_value tool to read these)");
```

### Tests

- Unit tests for the store reader: valid path, nested path, missing path, large value truncation, empty store, circular reference
- Integration check in stage-executor test: verify store reader is injected into MCP config

### Verification

1. `cd apps/server && npx tsc --noEmit` — zero new errors
2. `cd apps/server && npx vitest run` — all tests pass
3. Run a pipeline-generator task, check agent init message includes the store reader tool
4. Tier-2 context says "use get_store_value tool"
