// Shared utility functions

export const getNestedValue = (obj: any, path: string): any => {
  if (!obj || !path) return undefined;
  return path.split(".").reduce((o: any, k: string) => o?.[k], obj);
};

export const humanizeKey = (key: string): string => {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
};

export const formatDuration = (ms: number): string => {
  if (ms < 1000) return `${ms}ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const remainder = s % 60;
  return remainder > 0 ? `${m}m ${remainder}s` : `${m}m`;
};
