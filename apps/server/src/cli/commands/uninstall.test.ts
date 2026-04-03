import { describe, it, expect, vi, beforeEach } from "vitest";

class ExitCalled extends Error { code: number; constructor(c: number) { super(`exit(${c})`); this.code = c; } }
const mockExit = vi.fn<(code?: number) => never>().mockImplementation((c) => { throw new ExitCalled(c ?? 0); });

vi.mock("../../services/registry-service.js", () => ({
  registryService: {
    uninstall: vi.fn(),
  },
}));

import { uninstallCommand } from "./uninstall.js";
import { registryService } from "../../services/registry-service.js";

describe("uninstallCommand", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    process.exit = mockExit as unknown as typeof process.exit;
  });

  it("exits with code 1 when packages array is empty", async () => {
    await expect(uninstallCommand([])).rejects.toThrow(ExitCalled);

    expect(logSpy).toHaveBeenCalledWith("Usage: uninstall <name> [name...]");
    expect(mockExit).toHaveBeenCalledWith(1);
  });

  it("prints removed packages", async () => {
    vi.mocked(registryService.uninstall).mockResolvedValue({
      removed: ["pkg-a", "pkg-b"],
      notFound: [],
    });

    await uninstallCommand(["pkg-a", "pkg-b"]);

    expect(registryService.uninstall).toHaveBeenCalledWith(["pkg-a", "pkg-b"]);
    expect(logSpy).toHaveBeenCalledWith("Uninstalled pkg-a");
    expect(logSpy).toHaveBeenCalledWith("Uninstalled pkg-b");
  });

  it("prints not-found packages via console.error", async () => {
    vi.mocked(registryService.uninstall).mockResolvedValue({
      removed: [],
      notFound: ["ghost"],
    });

    await uninstallCommand(["ghost"]);

    expect(errorSpy).toHaveBeenCalledWith(
      'Package "ghost" is not installed.',
    );
  });

  it("prints correct count summary", async () => {
    vi.mocked(registryService.uninstall).mockResolvedValue({
      removed: ["a"],
      notFound: ["b"],
    });

    await uninstallCommand(["a", "b"]);

    expect(logSpy).toHaveBeenCalledWith("\nUninstalled 1 package(s).");
  });

  it("prints zero count when none removed", async () => {
    vi.mocked(registryService.uninstall).mockResolvedValue({
      removed: [],
      notFound: ["x", "y"],
    });

    await uninstallCommand(["x", "y"]);

    expect(logSpy).toHaveBeenCalledWith("\nUninstalled 0 package(s).");
  });

  it("handles mix of removed and notFound", async () => {
    vi.mocked(registryService.uninstall).mockResolvedValue({
      removed: ["real-pkg"],
      notFound: ["fake-pkg"],
    });

    await uninstallCommand(["real-pkg", "fake-pkg"]);

    expect(logSpy).toHaveBeenCalledWith("Uninstalled real-pkg");
    expect(errorSpy).toHaveBeenCalledWith(
      'Package "fake-pkg" is not installed.',
    );
    expect(logSpy).toHaveBeenCalledWith("\nUninstalled 1 package(s).");
  });
});
