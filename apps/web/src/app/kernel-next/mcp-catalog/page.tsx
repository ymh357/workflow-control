"use client";

import { useEffect, useState } from "react";
import { fetchEntries, fetchInventory } from "../../../lib/mcp-catalog-api";
import type { CatalogEntryClient, InventoryRowClient, InventorySecretReadoutClient } from "../../../lib/mcp-catalog-api";
import { EntryCard } from "./entry-card";
import { AddEntryDialog } from "./add-entry-dialog";
import { ErrorBanner } from "../../../components/error-banner";

const DEFAULT_INVENTORY: { rows: InventoryRowClient[]; readouts: Record<string, InventorySecretReadoutClient[]> } = {
  rows: [],
  readouts: {},
};

export default function McpCatalogPage() {
  const [entries, setEntries] = useState<CatalogEntryClient[]>([]);
  const [inventory, setInventory] = useState(DEFAULT_INVENTORY);
  const [error, setError] = useState<string | null>(null);
  const [showAdd, setShowAdd] = useState(false);

  const refresh = async () => {
    try {
      const [es, inv] = await Promise.all([fetchEntries(), fetchInventory()]);
      setEntries(es);
      setInventory(inv);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  useEffect(() => { void refresh(); }, []);

  const inventoryByEntry = new Map(inventory.rows.map((r) => [r.entryId, r]));

  return (
    <main className="mx-auto w-full max-w-5xl p-6 text-primary">
      <header className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold">MCP Catalog & Inventory</h1>
          <p className="mt-1 text-xs text-secondary">
            Equip MCP servers so pipelines can use them. Secrets are encrypted at rest and never returned by any GET.
          </p>
        </div>
        <button
          onClick={() => setShowAdd(true)}
          className="rounded border border-info-border bg-info-bg px-3 py-1.5 text-sm text-info-fg hover:bg-accent/60"
        >
          + Add custom entry
        </button>
      </header>

      {error && <ErrorBanner diagnostics={[{ code: "FETCH_ERROR", message: error }]} />}

      {/* Phase 2: "Recommended for this pipeline" appears when launcher links here
          with ?neededByPipelineHash=...; the launcher banner (Task 11) populates
          the link. This empty placeholder section reserves the layout slot so a
          later patch can fill it without restructuring the page. */}

      <ul className="space-y-3">
        {entries.map((e) => (
          <EntryCard
            key={e.id}
            entry={e}
            inventory={inventoryByEntry.get(e.id) ?? null}
            readouts={inventory.readouts[e.id] ?? []}
            onChanged={() => void refresh()}
          />
        ))}
      </ul>

      {showAdd && (
        <AddEntryDialog
          onClose={() => setShowAdd(false)}
          onAdded={() => { setShowAdd(false); void refresh(); }}
        />
      )}
    </main>
  );
}
