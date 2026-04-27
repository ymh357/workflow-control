import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { randomBytes } from "node:crypto";
import {
  encryptValue,
  decryptValue,
  keyFileExists,
  loadKeyForTest,
  resetKeyCacheForTest,
} from "./crypto.js";

const FAKE_KEY = randomBytes(32).toString("base64");

describe("mcp-catalog/crypto", () => {
  let prevEnv: string | undefined;
  beforeEach(() => {
    prevEnv = process.env.WORKFLOW_CONTROL_SECRET_KEY;
    process.env.WORKFLOW_CONTROL_SECRET_KEY = FAKE_KEY;
    resetKeyCacheForTest();
  });
  afterEach(() => {
    if (prevEnv === undefined) delete process.env.WORKFLOW_CONTROL_SECRET_KEY;
    else process.env.WORKFLOW_CONTROL_SECRET_KEY = prevEnv;
    resetKeyCacheForTest();
  });

  it("round-trips a value", () => {
    const ct = encryptValue("hello-secret-123");
    expect(typeof ct).toBe("string");
    expect(ct).not.toContain("hello-secret-123");
    expect(decryptValue(ct)).toBe("hello-secret-123");
  });

  it("round-trips empty string", () => {
    const ct = encryptValue("");
    expect(decryptValue(ct)).toBe("");
  });

  it("round-trips unicode", () => {
    const ct = encryptValue("北京-密码-😀");
    expect(decryptValue(ct)).toBe("北京-密码-😀");
  });

  it("two encryptions of the same plaintext use different IVs", () => {
    const ct1 = encryptValue("same-input");
    const ct2 = encryptValue("same-input");
    expect(ct1).not.toBe(ct2);
    expect(decryptValue(ct1)).toBe("same-input");
    expect(decryptValue(ct2)).toBe("same-input");
  });

  it("decrypt rejects tampered ciphertext", () => {
    const ct = encryptValue("hello");
    const buf = Buffer.from(ct, "base64");
    buf[buf.length - 1] ^= 0x01;  // flip the last bit of the GCM tag
    const tampered = buf.toString("base64");
    expect(() => decryptValue(tampered)).toThrow();
  });

  it("decrypt with wrong key throws", () => {
    const ct = encryptValue("hello");
    process.env.WORKFLOW_CONTROL_SECRET_KEY = randomBytes(32).toString("base64");
    resetKeyCacheForTest();
    expect(() => decryptValue(ct)).toThrow();
  });

  it("loadKeyForTest returns 32-byte buffer", () => {
    const k = loadKeyForTest();
    expect(k.length).toBe(32);
  });

  it("decrypt rejects malformed base64", () => {
    expect(() => decryptValue("not-valid-base64!!!")).toThrow();
  });

  it("decrypt rejects too-short input", () => {
    expect(() => decryptValue("AAAA")).toThrow();
  });

  it("loadKey rejects env value that decodes to wrong length", () => {
    process.env.WORKFLOW_CONTROL_SECRET_KEY = randomBytes(16).toString("base64");
    resetKeyCacheForTest();
    expect(() => encryptValue("test")).toThrow(/32 bytes/);
  });

  it("keyFileExists returns a boolean for the default path", () => {
    // env override is set in beforeEach; the env path doesn't touch a file.
    // The helper checks the DEFAULT file path; with an env override the
    // file may or may not exist, but the helper's return value should be
    // independent of env (it inspects the disk, not env).
    // We can't make absolute assertions about a real ~/.workflow-control
    // path in CI, so we exercise the path argument form instead.
    expect(typeof keyFileExists()).toBe("boolean");
  });

  it("keyFileExists honors an explicit path argument", () => {
    const tmp = `${process.cwd()}/.test-nonexistent-${Date.now()}-${Math.random()}`;
    expect(keyFileExists(tmp)).toBe(false);
  });
});
