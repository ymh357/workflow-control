// Minimal tsconfig.json content used by validator/types.ts to run tsc on a
// generated pipeline.ts. Keep this file data-only so it can be serialized to
// disk without reaching for the filesystem at import time.

export const MINIMAL_TSCONFIG = {
  compilerOptions: {
    strict: true,
    noEmit: true,
    target: "ES2022",
    module: "ESNext",
    moduleResolution: "Bundler",
    skipLibCheck: true,
    // We want the wire-check assignments to surface errors, so do NOT allow
    // implicit any (strict: true already handles most).
    allowImportingTsExtensions: false,
    types: [],
    lib: ["ES2022"],
  },
  include: ["pipeline.ts"],
} as const;

export function renderTsconfigJson(): string {
  return JSON.stringify(MINIMAL_TSCONFIG, null, 2);
}
