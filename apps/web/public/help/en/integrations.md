## Agent Engines

Two execution backends are supported. Set a default at the pipeline level,
override per stage. Both work in web and edge modes.

> **Claude (Agent SDK / CLI)**
> Web mode: `@anthropic-ai/claude-agent-sdk` with async iterator API.
> Edge mode: `claude` CLI via PTY.
> - Sub-agent support (specialized agents per stage)
> - Sandbox mode (filesystem/network isolation)
> - Hooks (interrupt check, spec-audit, safety-guard)
> - Permission modes (default, bypassPermissions, plan, etc.)
> - Extended thinking (web mode) / effort levels (both modes)

> **Gemini (CLI)**
> Both modes: `gemini` CLI as a subprocess.
> - Isolated MCP config per stage
> - Approval modes (yolo, auto_edit, plan, default)
> - Sandbox via CLI flags
> - Lower cost for analysis/review stages

> **Tip:** Mix engines in one pipeline: Gemini for analysis (cheaper), Claude for
> implementation (better coding). Set `engine: gemini` on specific stages.

## MCP Integration

MCP servers extend agent capabilities with external service access.
Defined in a central registry, selectively enabled per stage.

```yaml
# config/mcps/registry.yaml
notion:
  command: npx
  args: [-y, "@notionhq/notion-mcp-server"]
  env:
    OPENAPI_MCP_HEADERS:
      json:
        Authorization: "Bearer ${NOTION_TOKEN}"

context7:
  command: npx
  args: [-y, "@upstash/context7-mcp@latest"]
```

```yaml
# stage usage
- name: analyzing
  type: agent
  mcps: [notion, context7]    # Enable these MCPs for this stage
```

Injection differs by backend: Claude SDK receives MCP configs in query
options; Gemini gets a generated `.gemini/settings.json` scoped
to that stage. In edge mode, the runner connects to the server's
built-in MCP server via `--mcp-config`.

## Configuration UI

> **Infrastructure & Health**
> - System health preflight (OS, Node, MCPs, CLIs)
> - System settings editor (raw YAML)
> - MCP registry configuration
> - Sandbox settings (filesystem/network isolation)

> **Blueprints & Intelligence**
> - Pipeline CRUD with visual editor
> - Visual editor + raw YAML two-way sync
> - Global prompt editing (constraints, CLAUDE.md, fragments)
> - Real-time validation with error/warning feedback
> - AI pipeline generation (natural language → YAML config)
