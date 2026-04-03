import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mockSearchCommand = vi.fn();
const mockInstallCommand = vi.fn();
const mockUpdateCommand = vi.fn();
const mockListCommand = vi.fn();
const mockOutdatedCommand = vi.fn();
const mockUninstallCommand = vi.fn();
const mockPublishCommand = vi.fn();
const mockBootstrapCommand = vi.fn();

vi.mock("./commands/search.js", () => ({ searchCommand: (...a: any[]) => mockSearchCommand(...a) }));
vi.mock("./commands/install.js", () => ({ installCommand: (...a: any[]) => mockInstallCommand(...a) }));
vi.mock("./commands/update.js", () => ({ updateCommand: (...a: any[]) => mockUpdateCommand(...a) }));
vi.mock("./commands/list.js", () => ({ listCommand: (...a: any[]) => mockListCommand(...a) }));
vi.mock("./commands/outdated.js", () => ({ outdatedCommand: (...a: any[]) => mockOutdatedCommand(...a) }));
vi.mock("./commands/uninstall.js", () => ({ uninstallCommand: (...a: any[]) => mockUninstallCommand(...a) }));
vi.mock("./commands/publish.js", () => ({ publishCommand: (...a: any[]) => mockPublishCommand(...a) }));
vi.mock("./commands/bootstrap.js", () => ({ bootstrapCommand: (...a: any[]) => mockBootstrapCommand(...a) }));

import { main } from "./registry.js";

const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

const originalArgv = process.argv;

beforeEach(() => {
  vi.resetAllMocks();
  mockSearchCommand.mockResolvedValue(undefined);
  mockInstallCommand.mockResolvedValue(undefined);
  mockUpdateCommand.mockResolvedValue(undefined);
  mockListCommand.mockReturnValue(undefined);
  mockOutdatedCommand.mockResolvedValue(undefined);
  mockUninstallCommand.mockResolvedValue(undefined);
  mockPublishCommand.mockResolvedValue(undefined);
  mockBootstrapCommand.mockResolvedValue(undefined);
});

afterEach(() => {
  process.argv = originalArgv;
});

function setArgv(...args: string[]) {
  process.argv = ["node", "registry.ts", ...args];
}

async function runMain(...args: string[]): Promise<{ exited: boolean; exitCode?: number }> {
  setArgv(...args);
  let exitCode: number | undefined;
  let exited = false;
  const exitSpy = vi.spyOn(process, "exit").mockImplementation((code?: any) => {
    exitCode = code;
    exited = true;
    throw new Error(`__exit__${code}`);
  });
  try {
    await main();
    exitSpy.mockRestore();
    return { exited: false };
  } catch (err: any) {
    exitSpy.mockRestore();
    if (err?.message?.startsWith("__exit__")) return { exited: true, exitCode };
    throw err;
  }
}

// ── Help ──

describe("help flags", () => {
  it("no args — logs HELP and exits 0", async () => {
    const { exited, exitCode } = await runMain();
    expect(consoleSpy).toHaveBeenCalled();
    const output = consoleSpy.mock.calls.flat().join(" ");
    expect(output).toContain("registry");
    expect(exited).toBe(true);
    expect(exitCode).toBe(0);
  });

  it("--help — logs HELP and exits 0", async () => {
    const { exitCode } = await runMain("--help");
    expect(consoleSpy).toHaveBeenCalled();
    expect(exitCode).toBe(0);
  });

  it("-h — logs HELP and exits 0", async () => {
    const { exitCode } = await runMain("-h");
    expect(consoleSpy).toHaveBeenCalled();
    expect(exitCode).toBe(0);
  });

  it("HELP output contains all 8 commands", async () => {
    await runMain("--help");
    const output = consoleSpy.mock.calls.flat().join(" ");
    for (const cmd of ["search", "install", "update", "list", "outdated", "uninstall", "publish", "bootstrap"]) {
      expect(output).toContain(cmd);
    }
  });
});

// ── Command dispatch ──

describe("command dispatch", () => {
  it("'search my-query' calls searchCommand(positionals[0], undefined)", async () => {
    await runMain("search", "my-query");
    expect(mockSearchCommand).toHaveBeenCalledWith("my-query", undefined);
  });

  it("'search' without query calls searchCommand(undefined, undefined)", async () => {
    await runMain("search");
    expect(mockSearchCommand).toHaveBeenCalledWith(undefined, undefined);
  });

  it("'search --type=mcp' passes type option", async () => {
    await runMain("search", "--type=mcp");
    expect(mockSearchCommand).toHaveBeenCalledWith(undefined, "mcp");
  });

  it("'search query --type=skill' passes both", async () => {
    await runMain("search", "myquery", "--type=skill");
    expect(mockSearchCommand).toHaveBeenCalledWith("myquery", "skill");
  });

  it("'install pkg1 pkg2' calls installCommand(['pkg1','pkg2'])", async () => {
    await runMain("install", "pkg1", "pkg2");
    expect(mockInstallCommand).toHaveBeenCalledWith(["pkg1", "pkg2"]);
  });

  it("'install' with no packages calls installCommand([])", async () => {
    await runMain("install");
    expect(mockInstallCommand).toHaveBeenCalledWith([]);
  });

  it("'update my-pkg' calls updateCommand('my-pkg')", async () => {
    await runMain("update", "my-pkg");
    expect(mockUpdateCommand).toHaveBeenCalledWith("my-pkg");
  });

  it("'update' without name calls updateCommand(undefined)", async () => {
    await runMain("update");
    expect(mockUpdateCommand).toHaveBeenCalledWith(undefined);
  });

  it("'list' calls listCommand(undefined)", async () => {
    await runMain("list");
    expect(mockListCommand).toHaveBeenCalledWith(undefined);
  });

  it("'list --type=pipeline' calls listCommand('pipeline')", async () => {
    await runMain("list", "--type=pipeline");
    expect(mockListCommand).toHaveBeenCalledWith("pipeline");
  });

  it("'outdated' calls outdatedCommand()", async () => {
    await runMain("outdated");
    expect(mockOutdatedCommand).toHaveBeenCalled();
  });

  it("'uninstall pkg1 pkg2' calls uninstallCommand(['pkg1','pkg2'])", async () => {
    await runMain("uninstall", "pkg1", "pkg2");
    expect(mockUninstallCommand).toHaveBeenCalledWith(["pkg1", "pkg2"]);
  });

  it("'publish /some/dir' calls publishCommand('/some/dir')", async () => {
    await runMain("publish", "/some/dir");
    expect(mockPublishCommand).toHaveBeenCalledWith("/some/dir");
  });

  it("'bootstrap' calls bootstrapCommand()", async () => {
    await runMain("bootstrap");
    expect(mockBootstrapCommand).toHaveBeenCalled();
  });
});

// ── Unknown command ──

describe("unknown command", () => {
  it("prints error containing 'Unknown command' and exits 1", async () => {
    const { exitCode } = await runMain("unknown-cmd");
    const errOutput = consoleErrorSpy.mock.calls.flat().join(" ");
    expect(errOutput).toContain("Unknown command");
    expect(exitCode).toBe(1);
  });

  it("error message includes the unknown command name", async () => {
    await runMain("foobar");
    const errOutput = consoleErrorSpy.mock.calls.flat().join(" ");
    expect(errOutput).toContain("foobar");
  });

  it("also prints HELP after unknown command", async () => {
    await runMain("badcmd");
    expect(consoleSpy).toHaveBeenCalled();
  });
});

// ── Command failure handling ──

describe("command error handling", () => {
  it("install throws Error — logs error message and exits 1", async () => {
    mockInstallCommand.mockRejectedValue(new Error("Package not found"));
    const { exitCode } = await runMain("install", "nonexistent");
    const errOutput = consoleErrorSpy.mock.calls.flat().join(" ");
    expect(errOutput).toContain("Package not found");
    expect(exitCode).toBe(1);
  });

  it("search throws — exits 1", async () => {
    mockSearchCommand.mockRejectedValue(new Error("Network error"));
    const { exitCode } = await runMain("search", "test");
    expect(exitCode).toBe(1);
  });

  it("bootstrap throws — logs error and exits 1", async () => {
    mockBootstrapCommand.mockRejectedValue(new Error("Bootstrap failed"));
    const { exitCode } = await runMain("bootstrap");
    const errOutput = consoleErrorSpy.mock.calls.flat().join(" ");
    expect(errOutput).toContain("Bootstrap failed");
    expect(exitCode).toBe(1);
  });

  it("non-Error thrown (string) — still exits 1", async () => {
    mockOutdatedCommand.mockRejectedValue("string error");
    const { exitCode } = await runMain("outdated");
    expect(exitCode).toBe(1);
  });

  it("non-Error thrown — error value appears in console.error output", async () => {
    mockOutdatedCommand.mockRejectedValue("string rejection");
    await runMain("outdated");
    const errOutput = consoleErrorSpy.mock.calls.flat().join(" ");
    expect(errOutput).toContain("string rejection");
  });
});
