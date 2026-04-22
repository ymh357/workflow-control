export * from "./settings.js";

import { clearSettingsCache } from "./settings.js";
import { clearDynamicScriptCache } from "../script-loader.js";

export function clearConfigCache(): void {
  clearSettingsCache();
  clearDynamicScriptCache();
}
