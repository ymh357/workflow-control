import type { WorkflowContext } from "../machine/types.js";
import type { SystemSettings } from "../lib/config-loader.js";

export interface ScriptMetadata {
  id: string;
  name: string;
  description: string;
  helpMd: string;
  argsSchema?: Record<string, { type: "string" | "number" | "boolean"; description: string; required?: boolean }>;
  requiredSettings?: string[]; // Declarative dependencies on system settings paths (e.g., ["notion.token"])
}

export type ScriptHandler = (params: {
  taskId: string;
  context: WorkflowContext;
  settings: SystemSettings;
  args?: Record<string, any>;
  inputs?: Record<string, any>;
}) => Promise<any>;

export interface AutomationScript {
  metadata: ScriptMetadata;
  handler: ScriptHandler;
}
