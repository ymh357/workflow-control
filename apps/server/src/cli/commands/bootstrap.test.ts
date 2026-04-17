import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../services/registry-service.js", () => ({
  registryService: {
    bootstrap: vi.fn(),
  },
}));

// Mock fetchIndex so tests don't hit the real local/remote registry.
// The previous implementation hard-coded a default package list in
// bootstrapCommand; the current one reads the index and bootstraps every
// package found. We provide a small fake index here.
vi.mock("../lib/fetch.js", () => ({
  fetchIndex: vi.fn(async () => ({
    version: 1,
    updated_at: "2025-01-01",
    packages: [{ name: "test-mixed", version: "1.0.0", type: "pipeline" }],
  })),
}));

import { bootstrapCommand } from "./bootstrap.js";
import { registryService } from "../../services/registry-service.js";

describe("bootstrapCommand", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  it("prints installed packages when bootstrap installs packages", async () => {
    vi.mocked(registryService.bootstrap).mockResolvedValue({
      installed: [
        { name: "pkg-a", version: "1.0.0", type: "pipeline" },
        { name: "pkg-b", version: "2.0.0", type: "skill" },
      ],
      skipped: [],
      mcpSetupNeeded: [],
    });

    await bootstrapCommand();

    expect(registryService.bootstrap).toHaveBeenCalledWith(["test-mixed"]);
    expect(logSpy).toHaveBeenCalledWith("Installed 2 package(s):");
    expect(logSpy).toHaveBeenCalledWith("  + pkg-a@1.0.0 (pipeline)");
    expect(logSpy).toHaveBeenCalledWith("  + pkg-b@2.0.0 (skill)");
    expect(logSpy).toHaveBeenCalledWith("\nBootstrap complete.");
  });

  it("prints skipped packages with reasons", async () => {
    vi.mocked(registryService.bootstrap).mockResolvedValue({
      installed: [],
      skipped: [
        { name: "old-pkg", reason: "already installed" },
        { name: "broken-pkg", reason: "version conflict" },
      ],
      mcpSetupNeeded: [],
    });

    await bootstrapCommand();

    expect(logSpy).toHaveBeenCalledWith("\nSkipped 2 package(s):");
    expect(logSpy).toHaveBeenCalledWith("  - old-pkg: already installed");
    expect(logSpy).toHaveBeenCalledWith("  - broken-pkg: version conflict");
    expect(logSpy).toHaveBeenCalledWith("\nBootstrap complete.");
  });

  it("handles empty results gracefully", async () => {
    vi.mocked(registryService.bootstrap).mockResolvedValue({
      installed: [],
      skipped: [],
      mcpSetupNeeded: [],
    });

    await bootstrapCommand();

    const allArgs = logSpy.mock.calls.flat();
    expect(allArgs).not.toContain(expect.stringContaining("Installed"));
    expect(allArgs).not.toContain(expect.stringContaining("Skipped"));
    expect(logSpy).toHaveBeenCalledWith("\nBootstrap complete.");
  });

  it("prints both installed and skipped when both exist", async () => {
    vi.mocked(registryService.bootstrap).mockResolvedValue({
      installed: [{ name: "new-pkg", version: "0.1.0", type: "fragment" }],
      skipped: [{ name: "dup-pkg", reason: "duplicate" }],
      mcpSetupNeeded: [],
    });

    await bootstrapCommand();

    expect(logSpy).toHaveBeenCalledWith("Installed 1 package(s):");
    expect(logSpy).toHaveBeenCalledWith("  + new-pkg@0.1.0 (fragment)");
    expect(logSpy).toHaveBeenCalledWith("\nSkipped 1 package(s):");
    expect(logSpy).toHaveBeenCalledWith("  - dup-pkg: duplicate");
  });

  it("always prints the bootstrapping banner first", async () => {
    // bootstrapCommand was changed from "install a hard-coded default set +
    // all fragments" to "install everything in the registry index". The
    // banner message tracks that — kept in sync here.
    vi.mocked(registryService.bootstrap).mockResolvedValue({
      installed: [],
      skipped: [],
      mcpSetupNeeded: [],
    });

    await bootstrapCommand();

    expect(logSpy.mock.calls[0][0]).toBe(
      "Bootstrapping: installing all registry packages...\n",
    );
  });
});
