export * from "./settings.js";

import { clearSettingsCache } from "./settings.js";

export function clearConfigCache(): void {
  clearSettingsCache();
}
