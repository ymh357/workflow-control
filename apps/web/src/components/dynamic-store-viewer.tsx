"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import type { OutputFieldSchema, StageOutputSchema, PipelineStageSchema, PipelineStageEntry } from "@/lib/pipeline-types";
import { flattenPipelineStages } from "@/lib/pipeline-types";
import MarkdownBlock from "./markdown-block";

interface DynamicStoreViewerProps {
  store?: Record<string, any>;
  pipelineStages?: PipelineStageEntry[];
  // Legacy props
  branch?: string;
  error?: string;
  enabledSteps?: string[];
}

const FieldRenderer = ({ value, schema }: { value: any; schema?: OutputFieldSchema }) => {
  if (value === undefined || value === null) return null;

  const type = schema?.type ?? (Array.isArray(value) ? "string[]" : typeof value);

  switch (type) {
    case "string[]":
      if (!Array.isArray(value) || value.length === 0) return <span className="text-zinc-500">none</span>;
      return (
        <div className="flex flex-wrap gap-1">
          {value.map((v: string, i: number) => (
            <span key={i} className="rounded bg-zinc-800 px-2 py-0.5 text-xs text-zinc-300 font-mono">{v}</span>
          ))}
        </div>
      );
    case "boolean":
      if (schema?.display_hint === "badge") {
        return <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${
          value ? "bg-green-900/60 text-green-300" : "bg-red-900/60 text-red-300"
        }`}>{schema.key ?? ""}: {value ? "PASSED" : "FAILED"}</span>;
      }
      return <span className={value ? "text-green-400" : "text-zinc-500"}>{value ? "Yes" : "No"}</span>;
    case "number":
      return <span className="text-zinc-200">{value}</span>;
    case "markdown":
      return <div className="mt-1 max-h-60 overflow-auto rounded bg-zinc-900/50 p-3"><MarkdownBlock content={String(value)} /></div>;
    case "object":
      if (schema?.fields?.length) {
        return (
          <div className="ml-2 mt-1 border-l border-zinc-800 pl-3 space-y-1">
            {schema.fields.map((f) => (
              <FieldRow key={f.key} label={f.key} value={value?.[f.key]} schema={f} />
            ))}
          </div>
        );
      }
      return <pre className="mt-1 max-h-40 overflow-auto text-xs text-zinc-400 bg-zinc-900 p-2 rounded">{JSON.stringify(value, null, 2)}</pre>;
    case "object[]":
      if (!Array.isArray(value) || value.length === 0) return <span className="text-zinc-500">none</span>;
      return (
        <div className="ml-2 mt-1 space-y-2">
          {value.map((item: any, i: number) => (
            <div key={i} className="border-l border-zinc-800 pl-3 space-y-1">
              <span className="text-[10px] text-zinc-600">[{i}]</span>
              {schema?.fields?.length
                ? schema.fields.map((f) => (
                    <FieldRow key={f.key} label={f.key} value={item?.[f.key]} schema={f} />
                  ))
                : <pre className="text-xs text-zinc-400">{JSON.stringify(item, null, 2)}</pre>}
            </div>
          ))}
        </div>
      );
    default: {
      const str = String(value);
      if (schema?.display_hint === "link" || str.startsWith("http://") || str.startsWith("https://")) {
        return <a href={str} target="_blank" rel="noopener noreferrer" className="text-blue-400 underline text-xs break-all">{str}</a>;
      }
      return <span className="text-zinc-200">{str}</span>;
    }
  }
};

const FieldRow = ({ label, value, schema }: { label: string; value: any; schema?: OutputFieldSchema }) => {
  if (value === undefined || value === null) return null;
  return (
    <div className="text-sm">
      <span className="text-zinc-500">{label}:</span>{" "}
      <FieldRenderer value={value} schema={schema} />
    </div>
  );
};

// Render a schema-driven section for a single store key
const SchemaSection = ({ storeKey, data, schema }: {
  storeKey: string;
  data: any;
  schema: { label?: string; fields: OutputFieldSchema[] };
}) => {
  if (!data) return null;

  // If the data is a primitive (e.g. specSummary is just a string), render it directly
  if (typeof data !== "object" || Array.isArray(data)) {
    return (
      <div>
        <h4 className="text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-2">
          {schema.label ?? storeKey}
        </h4>
        <FieldRenderer value={data} />
      </div>
    );
  }

  return (
    <div>
      <h4 className="text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-2">
        {schema.label ?? storeKey}
      </h4>
      <div className="grid gap-1.5">
        {schema.fields.map((field) => (
          <FieldRow key={field.key} label={field.key} value={data[field.key]} schema={field} />
        ))}
      </div>
    </div>
  );
};

// Render unknown store data as a collapsible JSON viewer
const RawSection = ({ storeKey, data }: { storeKey: string; data: any }) => {
  const [open, setOpen] = useState(false);
  if (!data) return null;

  if (typeof data === "string") {
    return (
      <div className="text-sm">
        <span className="text-zinc-500">{storeKey}:</span> <span className="text-zinc-300">{data}</span>
      </div>
    );
  }

  return (
    <div>
      <button onClick={() => setOpen(!open)} className="text-xs text-zinc-500 hover:text-zinc-300 flex items-center gap-1">
        <span className="font-mono">{open ? "v" : ">"}</span> {storeKey}
      </button>
      {open && (
        <pre className="mt-1 max-h-40 overflow-auto rounded bg-zinc-900 p-2 text-xs text-zinc-400">
          {JSON.stringify(data, null, 2)}
        </pre>
      )}
    </div>
  );
};

const DynamicStoreViewer = ({ store, pipelineStages, branch, error, enabledSteps }: DynamicStoreViewerProps) => {
  const t = useTranslations("Panels");
  if (!store || Object.keys(store).length === 0) {
    if (!branch && !error) return null;
  }

  const flatStages = pipelineStages ? flattenPipelineStages(pipelineStages) : [];

  // Build a map of storeKey -> schema from pipeline stages
  const schemaMap = new Map<string, { label?: string; fields: OutputFieldSchema[] }>();
  if (flatStages.length > 0) {
    for (const stage of flatStages) {
      if (stage.outputs) {
        for (const [key, schema] of Object.entries(stage.outputs)) {
          schemaMap.set(key, schema);
        }
      }
    }
  }

  // Derive hidden keys from pipeline schema
  const hiddenKeys = new Set<string>();
  if (flatStages.length > 0) {
    for (const stage of flatStages) {
      if (!stage.outputs) continue;
      for (const [key, schema] of Object.entries(stage.outputs)) {
        if ((schema as any).hidden) hiddenKeys.add(key);
      }
    }
  }

  // Split store keys into schema-backed and raw
  const storeKeys = store ? Object.keys(store) : [];
  const schemaKeys = storeKeys.filter((k) => schemaMap.has(k) && !hiddenKeys.has(k));
  const rawKeys = storeKeys.filter((k) => !schemaMap.has(k) && !hiddenKeys.has(k));

  return (
    <div className="space-y-3 rounded-md border border-zinc-800 bg-zinc-900/50 p-4">
      <h3 className="text-sm font-semibold text-zinc-400">{t("taskSummary")}</h3>

      {/* Schema-driven sections */}
      {schemaKeys.map((key) => (
        <SchemaSection key={key} storeKey={key} data={store![key]} schema={schemaMap.get(key)!} />
      ))}

      {/* Top-level context fields */}
      {branch && <FieldRow label={t("branch")} value={branch} />}
      {error && (
        <div className="text-sm">
          <span className="text-zinc-500">{t("errorLabel")}</span> <span className="text-red-400">{error}</span>
        </div>
      )}

      {/* Raw store entries without schema */}
      {rawKeys.length > 0 && (
        <div className="space-y-1.5 pt-2 border-t border-zinc-800">
          {rawKeys.map((key) => (
            <RawSection key={key} storeKey={key} data={store![key]} />
          ))}
        </div>
      )}

      {/* Enabled steps */}
      {enabledSteps && enabledSteps.length > 0 && (
        <div>
          <span className="text-xs text-zinc-500">{t("enabledSteps")}</span>
          <div className="mt-1 flex flex-wrap gap-1">
            {enabledSteps.map((step) => (
              <span key={step} className="rounded bg-zinc-800 px-2 py-0.5 text-[10px] font-medium text-zinc-400">{step}</span>
            ))}
          </div>
        </div>
      )}

      <p className="text-xs text-zinc-600">{t("noLiveStream")}</p>
    </div>
  );
};

export default DynamicStoreViewer;
