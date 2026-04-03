import { describe, it, expect, vi, beforeEach } from "vitest";

class ExitCalled extends Error { code: number; constructor(c: number) { super(`exit(${c})`); this.code = c; } }
const mockExit = vi.fn<(code?: number) => never>().mockImplementation((c) => { throw new ExitCalled(c ?? 0); });

vi.mock("../../services/registry-service.js", () => ({
  registryService: {
    install: vi.fn(),
  },
}));

import { installCommand } from "./install.js";
import { registryService } from "../../services/registry-service.js";

describe("installCommand", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    process.exit = mockExit as unknown as typeof process.exit;
  });

  it("exits with code 1 when packages array is empty", async () => {
    await expect(installCommand([])).rejects.toThrow(ExitCalled);

    expect(logSpy).toHaveBeenCalledWith(
      "Usage: install <name[@version]> [name[@version]...]",
    );
    expect(mockExit).toHaveBeenCalledWith(1);
  });

  it("prints installed packages", async () => {
    vi.mocked(registryService.install).mockResolvedValue({
      installed: [
        { name: "foo", version: "1.0.0", type: "pipeline" },
        { name: "bar", version: "2.3.1", type: "skill" },
      ],
      skipped: [],
      mcpSetupNeeded: [],
    });

    await installCommand(["foo", "bar"]);

    expect(registryService.install).toHaveBeenCalledWith(["foo", "bar"]);
    expect(logSpy).toHaveBeenCalledWith("Installed foo@1.0.0 (pipeline)");
    expect(logSpy).toHaveBeenCalledWith("Installed bar@2.3.1 (skill)");
  });

  it("prints skipped packages with reason", async () => {
    vi.mocked(registryService.install).mockResolvedValue({
      installed: [],
      skipped: [{ name: "baz", reason: "already exists" }],
      mcpSetupNeeded: [],
    });

    await installCommand(["baz"]);

    expect(logSpy).toHaveBeenCalledWith("Skipped baz: already exists");
  });

  it("prints correct count summary", async () => {
    vi.mocked(registryService.install).mockResolvedValue({
      installed: [{ name: "a", version: "1.0.0", type: "hook" }],
      skipped: [{ name: "b", reason: "conflict" }],
      mcpSetupNeeded: [],
    });

    await installCommand(["a", "b"]);

    expect(logSpy).toHaveBeenCalledWith("\nInstalled 1 package(s).");
  });

  it("prints zero count when all skipped", async () => {
    vi.mocked(registryService.install).mockResolvedValue({
      installed: [],
      skipped: [{ name: "x", reason: "not found" }],
      mcpSetupNeeded: [],
    });

    await installCommand(["x"]);

    expect(logSpy).toHaveBeenCalledWith("\nInstalled 0 package(s).");
  });

  it("passes version-tagged package names through", async () => {
    vi.mocked(registryService.install).mockResolvedValue({
      installed: [{ name: "pkg", version: "3.0.0", type: "gate" }],
      skipped: [],
      mcpSetupNeeded: [],
    });

    await installCommand(["pkg@3.0.0"]);

    expect(registryService.install).toHaveBeenCalledWith(["pkg@3.0.0"]);
  });
});
