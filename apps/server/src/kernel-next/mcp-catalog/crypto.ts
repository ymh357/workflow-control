import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const ALG = "aes-256-gcm";
const IV_LEN = 12;
const TAG_LEN = 16;

const ENV_OVERRIDE = "WORKFLOW_CONTROL_SECRET_KEY";

function defaultKeyPath(): string {
  return join(homedir(), ".workflow-control", ".secret-key");
}

let cachedKey: Buffer | null = null;

function generateAndStoreKey(path: string): Buffer {
  const key = randomBytes(32);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.tmp.${process.pid}.${Date.now()}`;
  writeFileSync(tmp, key.toString("base64"), { mode: 0o600 });
  renameSync(tmp, path);
  return key;
}

function loadKey(): Buffer {
  if (cachedKey) return cachedKey;
  const fromEnv = process.env[ENV_OVERRIDE];
  if (fromEnv && fromEnv.length > 0) {
    const buf = Buffer.from(fromEnv, "base64");
    if (buf.length !== 32) {
      throw new Error(`${ENV_OVERRIDE} must be base64 of exactly 32 bytes (got ${buf.length})`);
    }
    cachedKey = buf;
    return buf;
  }
  const path = defaultKeyPath();
  if (!existsSync(path)) {
    cachedKey = generateAndStoreKey(path);
    return cachedKey;
  }
  const raw = readFileSync(path, "utf8").trim();
  const buf = Buffer.from(raw, "base64");
  if (buf.length !== 32) {
    throw new Error(`secret-key file at ${path} did not decode to 32 bytes`);
  }
  cachedKey = buf;
  return buf;
}

export function encryptValue(plaintext: string): string {
  const key = loadKey();
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALG, key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, ct, tag]).toString("base64");
}

export function decryptValue(ciphertextB64: string): string {
  const buf = Buffer.from(ciphertextB64, "base64");
  if (buf.length < IV_LEN + TAG_LEN) {
    throw new Error("ciphertext too short");
  }
  const iv = buf.subarray(0, IV_LEN);
  const tag = buf.subarray(buf.length - TAG_LEN);
  const ct = buf.subarray(IV_LEN, buf.length - TAG_LEN);
  const key = loadKey();
  const decipher = createDecipheriv(ALG, key, iv);
  decipher.setAuthTag(tag);
  const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
  return pt.toString("utf8");
}

export function loadKeyForTest(): Buffer {
  return loadKey();
}

export function resetKeyCacheForTest(): void {
  cachedKey = null;
}
