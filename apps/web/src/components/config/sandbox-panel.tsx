"use client";

import React from "react";
import { useTranslations } from "next-intl";

export interface SandboxConfig {
  enabled?: boolean;
  auto_allow_bash?: boolean;
  allow_unsandboxed_commands?: boolean;
  network?: { allowed_domains?: string[] };
  filesystem?: {
    allow_write?: string[];
    deny_write?: string[];
    deny_read?: string[];
  };
}

interface SandboxPanelProps {
  value: SandboxConfig;
  onChange: (config: SandboxConfig) => void;
  readOnly?: boolean;
  description?: string;
}

const SandboxPanel = ({ value, onChange, readOnly = false, description }: SandboxPanelProps) => {
  const t = useTranslations("Config");
  const update = (partial: Partial<SandboxConfig>) => {
    if (readOnly) return;
    onChange({ ...value, ...partial });
  };

  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900/30 p-6">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h3 className="text-sm font-bold text-zinc-100">{t("sandboxMode")}</h3>
          <p className="text-xs text-zinc-500 mt-1">{description ?? t("sandboxDesc")}</p>
        </div>
        <button
          onClick={() => update({ enabled: !value.enabled })}
          disabled={readOnly}
          className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${value.enabled ? "bg-emerald-600" : "bg-zinc-700"}`}
        >
          <span className={`inline-block h-4 w-4 rounded-full bg-white transition-transform ${value.enabled ? "translate-x-6" : "translate-x-1"}`} />
        </button>
      </div>

      <div className={`space-y-5 ${value.enabled ? "opacity-100" : "opacity-40 pointer-events-none"}`}>
        <ToggleRow
          label={t("autoAllowBash")}
          hint={t("autoAllowBashDesc")}
          checked={value.auto_allow_bash !== false}
          onToggle={() => update({ auto_allow_bash: !(value.auto_allow_bash !== false) })}
          disabled={readOnly}
        />

        <ToggleRow
          label={t("allowUnsandboxed")}
          hint={t("allowUnsandboxedDesc")}
          checked={value.allow_unsandboxed_commands !== false}
          onToggle={() => update({ allow_unsandboxed_commands: !(value.allow_unsandboxed_commands !== false) })}
          disabled={readOnly}
        />

        <div className="py-3 border-t border-zinc-800">
          <p className="text-xs font-medium text-zinc-300 mb-2">{t("networkDomains")}</p>
          <p className="text-[10px] text-zinc-600 mb-3">{t("networkDomainsDesc")}</p>
          <textarea
            value={(value.network?.allowed_domains ?? []).join("\n")}
            onChange={(e) => {
              if (readOnly) return;
              const domains = e.target.value.split("\n");
              onChange({ ...value, network: { ...value.network, allowed_domains: domains } });
            }}
            onBlur={(e) => {
              const domains = e.target.value.split("\n").map(d => d.trim()).filter(Boolean);
              onChange({ ...value, network: { ...value.network, allowed_domains: domains } });
            }}
            placeholder="registry.npmjs.org&#10;api.github.com"
            rows={3}
            readOnly={readOnly}
            className="w-full rounded-lg bg-zinc-950 border border-zinc-800 px-3 py-2 text-xs text-zinc-300 font-mono placeholder:text-zinc-700 focus:border-blue-800 focus:outline-none resize-none"
          />
        </div>

        <div className="py-3 border-t border-zinc-800">
          <p className="text-xs font-medium text-zinc-300 mb-2">{t("filesystemRules")}</p>
          <div className="grid grid-cols-3 gap-3">
            {(["allow_write", "deny_write", "deny_read"] as const).map((field) => (
              <div key={field}>
                <label className="text-[10px] text-zinc-500 font-bold uppercase tracking-wider">{field.replace(/_/g, " ")}</label>
                <textarea
                  value={(value.filesystem?.[field] ?? []).join("\n")}
                  onChange={(e) => {
                    if (readOnly) return;
                    const paths = e.target.value.split("\n");
                    onChange({ ...value, filesystem: { ...value.filesystem, [field]: paths } });
                  }}
                  onBlur={(e) => {
                    const paths = e.target.value.split("\n").map(p => p.trim()).filter(Boolean);
                    onChange({ ...value, filesystem: { ...value.filesystem, [field]: paths } });
                  }}
                  rows={3}
                  readOnly={readOnly}
                  className="w-full mt-1 rounded-lg bg-zinc-950 border border-zinc-800 px-2 py-1.5 text-[11px] text-zinc-300 font-mono placeholder:text-zinc-700 focus:border-blue-800 focus:outline-none resize-none"
                />
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
};

const ToggleRow = ({ label, hint, checked, onToggle, disabled }: {
  label: string;
  hint: string;
  checked: boolean;
  onToggle: () => void;
  disabled?: boolean;
}) => (
  <div className="flex items-center justify-between py-3 border-t border-zinc-800">
    <div>
      <p className="text-xs font-medium text-zinc-300">{label}</p>
      <p className="text-[10px] text-zinc-600 mt-0.5">{hint}</p>
    </div>
    <button
      onClick={onToggle}
      disabled={disabled}
      className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${checked ? "bg-blue-600" : "bg-zinc-700"}`}
    >
      <span className={`inline-block h-3 w-3 rounded-full bg-white transition-transform ${checked ? "translate-x-5" : "translate-x-1"}`} />
    </button>
  </div>
);

export default SandboxPanel;
