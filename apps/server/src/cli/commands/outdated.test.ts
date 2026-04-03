import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../services/registry-service.js", () => ({
  registryService: {
    checkOutdated: vi.fn(),
  },
}));

import { outdatedCommand } from "./outdated.js";
import { registryService } from "../../services/registry-service.js";

describe("outdatedCommand", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  it("prints up-to-date message when no outdated packages", async () => {
    vi.mocked(registryService.checkOutdated).mockResolvedValue([]);

    await outdatedCommand();

    expect(logSpy).toHaveBeenCalledWith("All packages are up to date.");
    expect(logSpy).toHaveBeenCalledTimes(1);
  });

  it("prints table with outdated packages", async () => {
    vi.mocked(registryService.checkOutdated).mockResolvedValue([
      { name: "alpha", installed: "1.0.0", latest: "2.0.0", type: "pipeline" },
      { name: "beta-long-name", installed: "0.1.0", latest: "0.5.0", type: "skill" },
    ]);

    await outdatedCommand();

    // Header + separator + 2 data rows
    expect(logSpy).toHaveBeenCalledTimes(4);

    const header = logSpy.mock.calls[0][0] as string;
    expect(header).toContain("Name");
    expect(header).toContain("Installed");
    expect(header).toContain("Latest");
    expect(header).toContain("Type");

    const separator = logSpy.mock.calls[1][0] as string;
    expect(separator).toMatch(/^-+$/);
    expect(separator.length).toBe(header.length);

    const row1 = logSpy.mock.calls[2][0] as string;
    expect(row1).toContain("alpha");
    expect(row1).toContain("1.0.0");
    expect(row1).toContain("2.0.0");
    expect(row1).toContain("pipeline");

    const row2 = logSpy.mock.calls[3][0] as string;
    expect(row2).toContain("beta-long-name");
    expect(row2).toContain("0.1.0");
    expect(row2).toContain("0.5.0");
    expect(row2).toContain("skill");
  });

  it("uses minimum column widths from header labels", async () => {
    vi.mocked(registryService.checkOutdated).mockResolvedValue([
      { name: "x", installed: "1", latest: "2", type: "s" },
    ]);

    await outdatedCommand();

    const header = logSpy.mock.calls[0][0] as string;
    // "Name" = 4, "Installed" = 9, "Latest" = 6, "Type" = 4
    expect(header).toBe("Name  Installed  Latest  Type");
  });

  it("handles single outdated package", async () => {
    vi.mocked(registryService.checkOutdated).mockResolvedValue([
      { name: "solo", installed: "1.0.0", latest: "1.1.0", type: "hook" },
    ]);

    await outdatedCommand();

    expect(logSpy).toHaveBeenCalledTimes(3);
    const row = logSpy.mock.calls[2][0] as string;
    expect(row).toContain("solo");
    expect(row).toContain("1.0.0");
    expect(row).toContain("1.1.0");
    expect(row).toContain("hook");
  });
});
