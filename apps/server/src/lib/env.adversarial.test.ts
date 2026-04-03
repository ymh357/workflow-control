import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

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

const { loadEnv } = await import("./env.js");

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

describe("env adversarial", () => {
  it("key with = sign in it uses only first = as separator", () => {
    saveAndClear("BASE64_DATA");
    fakeFiles = {
      ".env.team": "BASE64_DATA=abc=def=ghi",
      ".env.local": "",
    };
    loadEnv();
    expect(process.env["BASE64_DATA"]).toBe("abc=def=ghi");
  });

  it("value with spaces inside quotes is preserved", () => {
    saveAndClear("SPACED");
    fakeFiles = {
      ".env.team": 'SPACED="  leading and trailing  "',
      ".env.local": "",
    };
    loadEnv();
    expect(process.env["SPACED"]).toBe("  leading and trailing  ");
  });

  it("empty-string quoted value produces empty string", () => {
    saveAndClear("EMPTY_QUOTED");
    fakeFiles = {
      ".env.team": 'EMPTY_QUOTED=""',
      ".env.local": "",
    };
    loadEnv();
    expect(process.env["EMPTY_QUOTED"]).toBe("");
  });

  it("value with embedded newline-like content (\\n literal) is treated as literal", () => {
    saveAndClear("NEWLINE_LIT");
    fakeFiles = {
      ".env.team": "NEWLINE_LIT=hello\\nworld",
      ".env.local": "",
    };
    loadEnv();
    // The parser doesn't interpret escape sequences
    expect(process.env["NEWLINE_LIT"]).toBe("hello\\nworld");
  });

  it("calling loadEnv twice does not overwrite already-set values from first call", () => {
    saveAndClear("DOUBLE_LOAD");
    fakeFiles = {
      ".env.team": "DOUBLE_LOAD=first",
      ".env.local": "",
    };
    loadEnv();
    expect(process.env["DOUBLE_LOAD"]).toBe("first");

    fakeFiles = {
      ".env.team": "DOUBLE_LOAD=second",
      ".env.local": "",
    };
    loadEnv();
    // process.env already has the key, so it won't be overwritten
    expect(process.env["DOUBLE_LOAD"]).toBe("first");
  });

  it("line with only = (empty key) is set but process.env ignores empty keys", () => {
    fakeFiles = {
      ".env.team": "=",
      ".env.local": "",
    };
    loadEnv();
    // The parser extracts key="" and val="", but process.env[""] = "" is a no-op
    // on most Node.js runtimes - the key is silently ignored
    expect(process.env[""]).toBeUndefined();
  });

  it("Windows-style \\r\\n line endings are handled (\\r remains in value)", () => {
    saveAndClear("WIN_KEY");
    fakeFiles = {
      ".env.team": "WIN_KEY=value\r\nOTHER=ok\r\n",
      ".env.local": "",
    };
    loadEnv();
    // split("\n") leaves \r on the value for WIN_KEY
    // trim() removes it
    expect(process.env["WIN_KEY"]).toBe("value");
  });

  it("extremely long value is stored without truncation", () => {
    saveAndClear("LONG_VAL");
    const longVal = "x".repeat(100_000);
    fakeFiles = {
      ".env.team": `LONG_VAL=${longVal}`,
      ".env.local": "",
    };
    loadEnv();
    expect(process.env["LONG_VAL"]).toBe(longVal);
  });
});
