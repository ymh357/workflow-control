import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { parse } from 'yaml';
import type { Config } from './types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

let cached: Config | null = null;

export const loadConfig = (): Config => {
  if (cached) return cached;

  const configPath = resolve(__dirname, '..', 'config.yaml');
  const raw = readFileSync(configPath, 'utf-8');
  const parsed = parse(raw);

  cached = {
    defaultCli: parsed.defaultCli ?? 'claude',
    defaultCwd: parsed.defaultCwd?.replace(/^~/, process.env.HOME ?? '') ?? process.cwd(),
    maxFileSize: parsed.maxFileSize ?? 52428800,
    sessionTtlHours: parsed.sessionTtlHours ?? 24,
    updateDebounceMs: parsed.updateDebounceMs ?? 1000,
    maxMessageLength: parsed.maxMessageLength ?? 3900,
  };
  return cached;
};
