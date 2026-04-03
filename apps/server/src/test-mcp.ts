import { query } from "@anthropic-ai/claude-agent-sdk";
import { loadEnv } from "./lib/env.js";
loadEnv();

const claudePath = process.env.CLAUDE_PATH ?? "claude";

async function main() {
  console.log("=== Debug MCP loading ===\n");

  const env = { ...process.env } as Record<string, string>;
  delete env.CLAUDECODE;
  delete env.CLAUDE_CODE_ENTRYPOINT;
  env.DEBUG_CLAUDE_AGENT_SDK = "1";

  const stderrLines: string[] = [];
  const agentQuery = query({
    prompt: "Say hello.",
    options: {
      systemPrompt: "Say hello.",
      pathToClaudeCodeExecutable: claudePath,
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      thinking: { type: "disabled" },
      maxTurns: 2,
      maxBudgetUsd: 0.1,
      includePartialMessages: true,
      env,
      stderr: (data: string) => { stderrLines.push(data); },
    },
  });

  for await (const message of agentQuery) {
    if (message.type === "system") {
      const tools = (message as Record<string, unknown>).tools as string[] | undefined;
      if (tools) {
        const mcpTools = tools.filter((t) => t.startsWith("mcp__"));
        console.log(`System: ${tools.length} total, ${mcpTools.length} MCP`);
        for (const t of mcpTools.slice(0, 5)) console.log(`  ${t}`);
      }
    }
  }

  // Print MCP-related debug output
  const mcpLines = stderrLines.filter((l) =>
    l.includes("claudeai-mcp") || l.includes("mcp") && l.includes("server") ||
    l.includes("oauth") || l.includes("OAuth") || l.includes("gate") ||
    l.includes("scope") || l.includes("token")
  );
  console.log(`\n--- MCP debug output (${mcpLines.length} lines) ---`);
  for (const l of mcpLines) console.log(l.trimEnd());

  if (mcpLines.length === 0) {
    console.log("(no MCP debug lines found)");
    console.log(`Total stderr lines: ${stderrLines.length}`);
    // Print lines containing "mcp" case-insensitive
    const anyMcp = stderrLines.filter((l) => l.toLowerCase().includes("mcp"));
    if (anyMcp.length > 0) {
      console.log(`\n--- Lines containing 'mcp' ---`);
      for (const l of anyMcp.slice(0, 20)) console.log(l.trimEnd());
    }
  }
}
main().catch(console.error);
