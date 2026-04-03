type EnabledStep = string;

export function buildStepHints(
  enabledSteps: EnabledStep[],
  relevantSteps: { key: EnabledStep; label: string }[],
): string {
  return (
    `Steps for this stage (SKIP means do NOT perform this step):\n` +
    relevantSteps
      .map(
        ({ key, label }) =>
          `- [${enabledSteps.includes(key) ? "ENABLED" : "SKIP"}] ${label}`,
      )
      .join("\n")
  );
}
