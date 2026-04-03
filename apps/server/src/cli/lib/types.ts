export interface RegistryIndex {
  version: number;
  updated_at: string;
  packages: RegistryPackageSummary[];
}

export interface RegistryPackageSummary {
  name: string;
  version: string;
  type: string;
  description: string;
  author: string;
  tags: string[];
  engine_compat?: string;
}

export type PackageType =
  | "pipeline"
  | "skill"
  | "fragment"
  | "hook"
  | "gate"
  | "script"
  | "mcp";

export interface PackageManifest {
  name: string;
  version: string;
  type: PackageType;
  description: string;
  author: string;
  tags: string[];
  engine_compat?: string;
  license?: string;
  dependencies?: {
    skills?: string[];
    fragments?: string[];
    hooks?: string[];
    scripts?: string[];
    mcps?: string[];
  };
  files: string[];
  // script-specific
  script_id?: string;
  entry?: string;
  // mcp-specific: the registry.yaml entry to merge
  mcp_entry?: {
    description?: string;
    command: string;
    args?: string[];
    env?: Record<string, string | { json: Record<string, string> }>;
    gemini?: {
      command: string;
      args?: string[];
      env?: Record<string, string | { json: Record<string, string> }>;
    };
  };
}

export interface LockFileEntry {
  version: string;
  type: string;
  author: string;
  installed_at: string;
  files: string[]; // relative to apps/server/
}

export interface LockFile {
  lockVersion: number;
  packages: Record<string, LockFileEntry>;
}
