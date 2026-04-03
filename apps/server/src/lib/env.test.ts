import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// ---------- helpers ----------

let tmpDir: string;

function makeTmpDir(): string {
  const dir = join(tmpdir(), `env-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeEnv(dir: string, name: string, content: string): string {
  const p = join(dir, name);
  writeFileSync(p, content, "utf-8");
  return p;
}

// We import the unexported `parseEnvFile` by mocking the module internals.
// Since `parseEnvFile` is not exported, we extract it via a small wrapper:
// re-read the source at module level and eval in a controlled way? No --
// better to just use the same logic path through `loadEnv` and inspect `process.env`.
//
// However, `loadEnv` hardcodes paths relative to SERVER_ROOT. To test
// `parseEnvFile` directly we mock `readFileSync` for some tests, and for
// integration tests we mock the path resolution.

// Strategy: mock __dirname / SERVER_ROOT so loadEnv reads from our tmp dir.
// We achieve this by mocking the `node:fs` readFileSync via vi.mock and
// controlling what resolve returns.

// Actually, simplest: since parseEnvFile is a pure function of file content,
// let's extract it by dynamically importing the module source. But that's
// fragile. Instead, let's test through loadEnv by mocking `node:path`'s
// resolve to redirect to temp files.

// Cleanest approach: mock fs.readFileSync to intercept calls for .env.team / .env.local.

const realReadFileSync = (await import("node:fs")).readFileSync;

let fakeFiles: Record<string, string> = {};

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    readFileSync: vi.fn((...args: Parameters<typeof actual.readFileSync>) => {
      const filePath = String(args[0]);
      for (const [suffix, content] of Object.entries(fakeFiles)) {
        if (filePath.endsWith(suffix)) {
          return content;
        }
      }
      return actual.readFileSync(...args);
    }),
  };
});

// We need to re-import loadEnv AFTER the mock is set up
const { loadEnv } = await import("./env.js");

// ---------- setup / teardown ----------

const savedEnv: Record<string, string | undefined> = {};

function saveAndClear(...keys: string[]) {
  for (const k of keys) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
}

function restoreEnv() {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

beforeEach(() => {
  fakeFiles = {};
});

afterEach(() => {
  restoreEnv();
});

// ---------- parseEnvFile behaviour (tested via loadEnv) ----------

describe("parseEnvFile (via loadEnv)", () => {
  it("skips comment lines starting with #", () => {
    saveAndClear("FOO_COMMENT");
    fakeFiles = {
      ".env.team": "# this is a comment\nFOO_COMMENT=bar",
      ".env.local": "",
    };
    loadEnv();
    expect(process.env["FOO_COMMENT"]).toBe("bar");
  });

  it("skips empty lines and whitespace-only lines", () => {
    saveAndClear("EMPTY_TEST");
    fakeFiles = {
      ".env.team": "\n   \n\nEMPTY_TEST=ok\n\n",
      ".env.local": "",
    };
    loadEnv();
    expect(process.env["EMPTY_TEST"]).toBe("ok");
  });

  it("handles value containing = sign", () => {
    saveAndClear("EQ_VAL");
    fakeFiles = {
      ".env.team": "EQ_VAL=postgres://user:pass@host/db?opt=1",
      ".env.local": "",
    };
    loadEnv();
    expect(process.env["EQ_VAL"]).toBe("postgres://user:pass@host/db?opt=1");
  });

  it("removes matching double quotes from value", () => {
    saveAndClear("DQ_VAL");
    fakeFiles = {
      ".env.team": 'DQ_VAL="hello world"',
      ".env.local": "",
    };
    loadEnv();
    expect(process.env["DQ_VAL"]).toBe("hello world");
  });

  it("removes matching single quotes from value", () => {
    saveAndClear("SQ_VAL");
    fakeFiles = {
      ".env.team": "SQ_VAL='hello world'",
      ".env.local": "",
    };
    loadEnv();
    expect(process.env["SQ_VAL"]).toBe("hello world");
  });

  it("does NOT strip unmatched quotes (starts double, ends single)", () => {
    saveAndClear("MISMATCH_Q");
    fakeFiles = {
      ".env.team": `MISMATCH_Q="hello'`,
      ".env.local": "",
    };
    loadEnv();
    // Unmatched quotes are kept as-is
    expect(process.env["MISMATCH_Q"]).toBe(`"hello'`);
  });

  it("strips a single double-quote to empty string (startsWith+endsWith both match)", () => {
    saveAndClear("LONE_Q");
    fakeFiles = {
      ".env.team": `LONE_Q="`,
      ".env.local": "",
    };
    loadEnv();
    // BUG/edge-case: a single `"` satisfies both startsWith('"') and endsWith('"'),
    // so slice(1, -1) produces "". This is arguably incorrect but matches current impl.
    expect(process.env["LONE_Q"]).toBe("");
  });

  it("skips lines with no = sign", () => {
    saveAndClear("AFTER_BAD");
    fakeFiles = {
      ".env.team": "NO_EQUALS\nAFTER_BAD=yes",
      ".env.local": "",
    };
    loadEnv();
    expect(process.env["NO_EQUALS"]).toBeUndefined();
    expect(process.env["AFTER_BAD"]).toBe("yes");
  });

  it("handles key= with empty value", () => {
    saveAndClear("EMPTY_VAL");
    fakeFiles = {
      ".env.team": "EMPTY_VAL=",
      ".env.local": "",
    };
    loadEnv();
    expect(process.env["EMPTY_VAL"]).toBe("");
  });

  it("trims trailing whitespace from key and value", () => {
    saveAndClear("TRIM_KEY");
    fakeFiles = {
      ".env.team": "  TRIM_KEY  =  some_value  ",
      ".env.local": "",
    };
    loadEnv();
    expect(process.env["TRIM_KEY"]).toBe("some_value");
  });

  it("handles values with special characters (no quotes)", () => {
    saveAndClear("SPECIAL");
    fakeFiles = {
      ".env.team": "SPECIAL=p@ss!w0rd#123$%^&*()",
      ".env.local": "",
    };
    loadEnv();
    expect(process.env["SPECIAL"]).toBe("p@ss!w0rd#123$%^&*()");
  });
});

// ---------- file-not-found / empty ----------

describe("missing or empty env files", () => {
  it("returns empty when file does not exist (no crash)", () => {
    saveAndClear("GHOST_KEY");
    fakeFiles = {}; // no files match at all, readFileSync falls through to real fs which will throw for .env.team/.env.local
    // loadEnv should not throw
    expect(() => loadEnv()).not.toThrow();
    expect(process.env["GHOST_KEY"]).toBeUndefined();
  });

  it("handles empty file gracefully", () => {
    saveAndClear("EMPTY_FILE_KEY");
    fakeFiles = {
      ".env.team": "",
      ".env.local": "",
    };
    expect(() => loadEnv()).not.toThrow();
    expect(process.env["EMPTY_FILE_KEY"]).toBeUndefined();
  });
});

// ---------- priority ----------

describe("env loading priority", () => {
  it(".env.local overrides .env.team for the same key", () => {
    saveAndClear("PRIO_KEY");
    fakeFiles = {
      ".env.team": "PRIO_KEY=from_team",
      ".env.local": "PRIO_KEY=from_local",
    };
    loadEnv();
    expect(process.env["PRIO_KEY"]).toBe("from_local");
  });

  it("existing process.env is NOT overwritten by either file", () => {
    process.env["EXISTING_KEY"] = "original";
    savedEnv["EXISTING_KEY"] = undefined; // so afterEach cleans it up
    fakeFiles = {
      ".env.team": "EXISTING_KEY=team_val",
      ".env.local": "EXISTING_KEY=local_val",
    };
    loadEnv();
    expect(process.env["EXISTING_KEY"]).toBe("original");
  });
});
