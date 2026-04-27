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
    <main className="mx-auto w-full max-w-5xl p-6 text-zinc-100">
      <header className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold">MCP Catalog & Inventory</h1>
          <p className="mt-1 text-xs text-zinc-400">
            Equip MCP servers so pipelines can use them. Secrets are encrypted at rest and never returned by any GET.
          </p>
        </div>
        <button
          onClick={() => setShowAdd(true)}
          className="rounded border border-blue-700 bg-blue-700/40 px-3 py-1.5 text-sm text-blue-100 hover:bg-blue-700/60"
        >
          + Add custom entry
        </button>
      </header>

      {error && <ErrorBanner diagnostics={[{ code: "FETCH_ERROR", message: error }]} />}

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
