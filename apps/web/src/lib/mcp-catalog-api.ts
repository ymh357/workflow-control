import { apiFetch } from "./api-client";

export interface CatalogEntryClient {
  id: string;
  source: "builtin" | "custom";
  schemaVersion: "1";
  name: string;
  description: string;
  useCases: string[];
  tags: string[];
  homepage?: string;
  command: string;
  args: string[];
  envKeys: { name: string; required: boolean; description: string; obtainUrl?: string; obtainSteps?: string }[];
  healthCheckTimeoutMs: number;
  packageName?: string;
  toolsPreview?: { name: string; brief: string }[];
  deprecatedAt?: number;
}

export type InventoryStatusClient = "not-equipped" | "pending-secret" | "equipped" | "unhealthy";

export interface InventoryRowClient {
  entryId: string;
  status: InventoryStatusClient;
  lastStatusChangeAt: number;
  lastUnhealthyAt?: number;
  lastUnhealthyReason?: string;
}

export interface InventorySecretReadoutClient {
  envKey: string;
  hasValue: boolean;
  lastUpdatedAt?: number;
}

export const fetchEntries = (): Promise<CatalogEntryClient[]> =>
  apiFetch<{ entries: CatalogEntryClient[] }>("/api/kernel/mcp-catalog/entries").then((r) => {
    if (!r.ok) throw new Error(r.diagnostics[0]?.message ?? "fetch failed");
    return r.data.entries;
  });

export const fetchInventory = (): Promise<{
  rows: InventoryRowClient[];
  readouts: Record<string, InventorySecretReadoutClient[]>;
}> =>
  apiFetch<{
    rows: InventoryRowClient[];
    readouts: Record<string, InventorySecretReadoutClient[]>;
  }>("/api/kernel/mcp-catalog/inventory").then((r) => {
    if (!r.ok) throw new Error(r.diagnostics[0]?.message ?? "fetch failed");
    return r.data;
  });

export const equip = (entryId: string, envValues: Record<string, string>) =>
  apiFetch<{ status: InventoryStatusClient }>("/api/kernel/mcp-catalog/equip", {
    method: "POST", body: { entryId, envValues },
  });

export const unequip = (entryId: string) =>
  apiFetch<Record<string, never>>("/api/kernel/mcp-catalog/unequip", {
    method: "POST", body: { entryId },
  });

export const recheck = (entryId: string) =>
  apiFetch<{ status: InventoryStatusClient }>("/api/kernel/mcp-catalog/recheck", {
    method: "POST", body: { entryId },
  });
