const basename = (path: unknown): string => {
  if (typeof path !== "string") return "unknown";
  return path.split("/").pop() ?? path;
};

export const humanizeToolCall = (toolName: string, input?: Record<string, unknown>): string => {
  if (!input) return `Tool: ${toolName}`;

  // MCP tools: mcp__server__tool
  if (toolName.startsWith("mcp__")) {
    const parts = toolName.split("__");
    const server = parts[1] ?? "mcp";
    const tool = parts.slice(2).join("__") || "call";
    return `${server}: ${tool}`;
  }

  switch (toolName) {
    case "Read":
      return `Read ${basename(input.file_path)}`;
    case "Write":
      return `Write ${basename(input.file_path)}`;
    case "Edit":
      return `Edit ${basename(input.file_path)}`;
    case "Bash":
      return `Run: ${String(input.command ?? "").slice(0, 60)}`;
    case "Grep":
      return `Search: ${input.pattern}`;
    case "Glob":
      return `Find: ${input.pattern}`;
    case "WebSearch":
      return `Web search: ${String(input.query ?? "").slice(0, 50)}`;
    case "WebFetch":
      return `Fetch: ${String(input.url ?? "").slice(0, 50)}`;
    case "Agent":
      return `Agent: ${String(input.description ?? input.prompt ?? "").slice(0, 50)}`;
    case "NotebookEdit":
      return `Notebook: ${basename(input.notebook_path)}`;
    default:
      return `Tool: ${toolName}`;
  }
};
