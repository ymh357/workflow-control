import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER_ROOT = resolve(__dirname, "../..");

function parseEnvFile(filePath: string): Record<string, string> {
  try {
    const content = readFileSync(filePath, "utf-8");
    const result: Record<string, string> = {};
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx === -1) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      let val = trimmed.slice(eqIdx + 1).trim();
      // Strip matching surrounding quotes
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      result[key] = val;
    }
    return result;
  } catch {
    return {};
  }
}

export function loadEnv(): void {
  const teamVars = parseEnvFile(resolve(SERVER_ROOT, ".env.team"));
  const localVars = parseEnvFile(resolve(SERVER_ROOT, ".env.local"));

  // Priority: process.env > .env.local > .env.team
  // Spread order means .env.local values override .env.team for the same key
  for (const [key, val] of Object.entries({ ...teamVars, ...localVars })) {
    if (process.env[key] === undefined) {
      process.env[key] = val;
    }
  }
}
