// Hardcoded fallback for global constraints.
// In normal operation, constraints are loaded from the pipeline's prompts/global-constraints.md
// via the task config snapshot. This fallback is only used if privateConfig is missing.

export const DEFAULT_GLOBAL_CONSTRAINTS = `## Global Constraints
- Read files at most once — prefer parallel reads for multiple files
- Do NOT create files outside .workflow/ unless the spec explicitly requires it

## Dependency Management
- Do NOT install new dependencies unless absolutely necessary.
- If a critical dependency is missing, document it and proceed with workarounds.`;
