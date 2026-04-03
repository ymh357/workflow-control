import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("node:fs", () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
}));

vi.mock("./constants.js", () => ({
  LOCK_FILE_NAME: ".wfctl-registry.lock",
  LOCK_VERSION: 1,
}));

import * as fs from "node:fs";
import { readLock, writeLock, addToLock, removeFromLock } from "./lock.js";
import type { LockFile, LockFileEntry } from "./types.js";

beforeEach(() => {
  vi.clearAllMocks();
});

const makeLockEntry = (overrides?: Partial<LockFileEntry>): LockFileEntry => ({
  version: "1.0.0",
  type: "pipeline",
  author: "test",
  installed_at: "2025-01-01T00:00:00Z",
  files: ["config/pipelines/main.yaml"],
  ...overrides,
});

describe("readLock", () => {
  it("returns default lock when file does not exist", () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);

    const result = readLock();

    expect(result).toEqual({ lockVersion: 1, packages: {} });
  });

  it("returns default lock on JSON parse error", () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue("this is not json!!!");

    const result = readLock();

    expect(result).toEqual({ lockVersion: 1, packages: {} });
  });

  it("returns parsed lock file content", () => {
    const lock: LockFile = {
      lockVersion: 1,
      packages: {
        "my-pkg": makeLockEntry(),
      },
    };
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(lock));

    const result = readLock();

    expect(result).toEqual(lock);
    expect(result.packages["my-pkg"].version).toBe("1.0.0");
  });

  it("returns default lock when file is empty string", () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue("");

    const result = readLock();

    expect(result).toEqual({ lockVersion: 1, packages: {} });
  });

  it("returns default lock when readFileSync throws", () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockImplementation(() => {
      throw new Error("EACCES: permission denied");
    });

    const result = readLock();

    expect(result).toEqual({ lockVersion: 1, packages: {} });
  });

  it("preserves extra fields from lock file", () => {
    const lock = {
      lockVersion: 1,
      packages: {},
      extra: "data",
    };
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(lock));

    const result = readLock();

    expect((result as unknown as Record<string, unknown>).extra).toBe("data");
  });
});

describe("writeLock", () => {
  it("writes JSON with 2-space indent and trailing newline", () => {
    const lock: LockFile = {
      lockVersion: 1,
      packages: { "pkg-a": makeLockEntry() },
    };

    writeLock(lock);

    expect(fs.writeFileSync).toHaveBeenCalledTimes(1);
    const [, content, encoding] = vi.mocked(fs.writeFileSync).mock.calls[0];
    expect(encoding).toBe("utf-8");

    const written = content as string;
    expect(written.endsWith("\n")).toBe(true);
    expect(written.trimEnd()).toBe(JSON.stringify(lock, null, 2));
  });

  it("writes empty packages object correctly", () => {
    const lock: LockFile = { lockVersion: 1, packages: {} };

    writeLock(lock);

    const written = vi.mocked(fs.writeFileSync).mock.calls[0][1] as string;
    const parsed = JSON.parse(written);
    expect(parsed).toEqual({ lockVersion: 1, packages: {} });
  });

  it("serializes multiple packages", () => {
    const lock: LockFile = {
      lockVersion: 1,
      packages: {
        a: makeLockEntry({ version: "1.0.0" }),
        b: makeLockEntry({ version: "2.0.0" }),
        c: makeLockEntry({ version: "3.0.0" }),
      },
    };

    writeLock(lock);

    const written = vi.mocked(fs.writeFileSync).mock.calls[0][1] as string;
    const parsed = JSON.parse(written);
    expect(Object.keys(parsed.packages)).toHaveLength(3);
    expect(parsed.packages.b.version).toBe("2.0.0");
  });
});

describe("addToLock", () => {
  it("returns a new object with the entry added", () => {
    const lock: LockFile = { lockVersion: 1, packages: {} };
    const entry = makeLockEntry();

    const result = addToLock(lock, "new-pkg", entry);

    expect(result.packages["new-pkg"]).toEqual(entry);
    expect(result.lockVersion).toBe(1);
  });

  it("does not mutate the input lock", () => {
    const lock: LockFile = {
      lockVersion: 1,
      packages: { existing: makeLockEntry() },
    };
    const originalPackages = { ...lock.packages };

    addToLock(lock, "added", makeLockEntry({ version: "9.9.9" }));

    expect(lock.packages).toEqual(originalPackages);
    expect(lock.packages["added"]).toBeUndefined();
  });

  it("preserves existing entries when adding new one", () => {
    const lock: LockFile = {
      lockVersion: 1,
      packages: {
        a: makeLockEntry({ version: "1.0.0" }),
        b: makeLockEntry({ version: "2.0.0" }),
      },
    };

    const result = addToLock(lock, "c", makeLockEntry({ version: "3.0.0" }));

    expect(Object.keys(result.packages)).toHaveLength(3);
    expect(result.packages.a.version).toBe("1.0.0");
    expect(result.packages.b.version).toBe("2.0.0");
    expect(result.packages.c.version).toBe("3.0.0");
  });

  it("overwrites entry when name already exists", () => {
    const lock: LockFile = {
      lockVersion: 1,
      packages: { pkg: makeLockEntry({ version: "1.0.0" }) },
    };

    const result = addToLock(lock, "pkg", makeLockEntry({ version: "2.0.0" }));

    expect(result.packages.pkg.version).toBe("2.0.0");
    expect(Object.keys(result.packages)).toHaveLength(1);
  });

  it("handles adding to lock with many existing packages", () => {
    const packages: Record<string, LockFileEntry> = {};
    for (let i = 0; i < 100; i++) {
      packages[`pkg-${i}`] = makeLockEntry({ version: `${i}.0.0` });
    }
    const lock: LockFile = { lockVersion: 1, packages };

    const result = addToLock(lock, "pkg-new", makeLockEntry({ version: "999.0.0" }));

    expect(Object.keys(result.packages)).toHaveLength(101);
    expect(result.packages["pkg-new"].version).toBe("999.0.0");
    expect(result.packages["pkg-50"].version).toBe("50.0.0");
  });
});

describe("removeFromLock", () => {
  it("returns a new object with the entry removed", () => {
    const lock: LockFile = {
      lockVersion: 1,
      packages: {
        a: makeLockEntry(),
        b: makeLockEntry({ version: "2.0.0" }),
      },
    };

    const result = removeFromLock(lock, "a");

    expect(result.packages.a).toBeUndefined();
    expect(result.packages.b).toBeDefined();
    expect(Object.keys(result.packages)).toHaveLength(1);
  });

  it("does not mutate the input lock", () => {
    const lock: LockFile = {
      lockVersion: 1,
      packages: { target: makeLockEntry() },
    };

    removeFromLock(lock, "target");

    expect(lock.packages.target).toBeDefined();
  });

  it("handles removing non-existent key gracefully", () => {
    const lock: LockFile = {
      lockVersion: 1,
      packages: { existing: makeLockEntry() },
    };

    const result = removeFromLock(lock, "ghost");

    expect(result.packages.existing).toBeDefined();
    expect(Object.keys(result.packages)).toHaveLength(1);
  });

  it("returns empty packages when removing the only entry", () => {
    const lock: LockFile = {
      lockVersion: 1,
      packages: { solo: makeLockEntry() },
    };

    const result = removeFromLock(lock, "solo");

    expect(result.packages).toEqual({});
    expect(result.lockVersion).toBe(1);
  });

  it("handles removing from empty packages", () => {
    const lock: LockFile = { lockVersion: 1, packages: {} };

    const result = removeFromLock(lock, "anything");

    expect(result.packages).toEqual({});
  });

  it("preserves lockVersion and other top-level fields", () => {
    const lock = {
      lockVersion: 1,
      packages: { a: makeLockEntry() },
    } as LockFile;

    const result = removeFromLock(lock, "a");

    expect(result.lockVersion).toBe(1);
  });
});
