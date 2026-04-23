"use client";

// /kernel-next/pipelines — list all known pipelines with their latest
// version. Click-through navigates to the per-pipeline editor at
// /kernel-next/pipelines/[name].

import { useEffect, useState } from "react";
import Link from "next/link";

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";

interface PipelineSummary {
  name: string;
  latestVersion: string;
  latestCreatedAt: number;
}

export default function PipelinesPage() {
  const [pipelines, setPipelines] = useState<PipelineSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const res = await fetch(`${API_BASE}/api/kernel/pipelines`, { signal: controller.signal });
        if (!res.ok) {
          setError(`HTTP ${res.status}`);
          setPipelines([]);
          return;
        }
        const body = await res.json() as { ok: boolean; pipelines: PipelineSummary[] };
        setPipelines(body.ok ? body.pipelines : []);
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") return;
        setError(err instanceof Error ? err.message : String(err));
        setPipelines([]);
      }
    })();
    return () => controller.abort();
  }, []);

  if (pipelines === null) {
    return <p className="p-6 font-mono text-sm text-gray-600">Loading…</p>;
  }

  return (
    <div className="mx-auto max-w-4xl p-6 font-mono text-sm">
      <h1 className="mb-4 text-xl font-bold">Pipelines</h1>
      {error && <p className="mb-3 text-red-600">Error: {error}</p>}
      {pipelines.length === 0 ? (
        <p className="text-gray-600">No pipelines registered yet.</p>
      ) : (
        <table className="w-full border-collapse border border-gray-300">
          <thead className="bg-gray-100">
            <tr>
              <th className="border border-gray-300 px-2 py-1 text-left">Name</th>
              <th className="border border-gray-300 px-2 py-1 text-left">Latest version</th>
              <th className="border border-gray-300 px-2 py-1 text-left">Updated</th>
            </tr>
          </thead>
          <tbody>
            {pipelines.map((p) => (
              <tr key={p.name}>
                <td className="border border-gray-300 px-2 py-1">
                  <Link
                    href={`/kernel-next/pipelines/${p.name}`}
                    className="text-blue-600 hover:underline"
                  >
                    {p.name}
                  </Link>
                </td>
                <td className="border border-gray-300 px-2 py-1 text-xs text-gray-600">
                  {p.latestVersion.slice(0, 12)}…
                </td>
                <td className="border border-gray-300 px-2 py-1 text-xs text-gray-500">
                  {new Date(p.latestCreatedAt).toLocaleString()}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
