import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../services/registry-service.js", () => ({
  registryService: {
    listInstalled: vi.fn(),
  },
}));

import { listCommand } from "./list.js";
import { registryService } from "../../services/registry-service.js";

describe("listCommand", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  it("prints message when no packages installed", () => {
    vi.mocked(registryService.listInstalled).mockReturnValue({});

    listCommand(undefined);

    expect(logSpy).toHaveBeenCalledWith("No packages installed.");
    expect(logSpy).toHaveBeenCalledTimes(1);
  });

  it("formats a table with correct column padding", () => {
    vi.mocked(registryService.listInstalled).mockReturnValue({
      "my-pipeline": {
        version: "1.0.0",
        type: "pipeline",
        author: "alice",
        installed_at: "2025-01-01",
        files: [],
      },
      "short": {
        version: "0.1.0",
        type: "skill",
        author: "bob",
        installed_at: "2025-01-02",
        files: [],
      },
    });

    listCommand(undefined);

    // Header + separator + 2 data rows
    expect(logSpy).toHaveBeenCalledTimes(4);

    const header = logSpy.mock.calls[0][0] as string;
    expect(header).toContain("Name");
    expect(header).toContain("Version");
    expect(header).toContain("Type");
    expect(header).toContain("Author");

    const separator = logSpy.mock.calls[1][0] as string;
    expect(separator).toMatch(/^-+$/);
    expect(separator.length).toBe(header.length);

    const row1 = logSpy.mock.calls[2][0] as string;
    expect(row1).toContain("my-pipeline");
    expect(row1).toContain("1.0.0");
    expect(row1).toContain("pipeline");
    expect(row1).toContain("alice");

    const row2 = logSpy.mock.calls[3][0] as string;
    expect(row2).toContain("short");
    expect(row2).toContain("0.1.0");
    expect(row2).toContain("skill");
    expect(row2).toContain("bob");
  });

  it("passes typeFilter to registryService.listInstalled", () => {
    vi.mocked(registryService.listInstalled).mockReturnValue({});

    listCommand("pipeline");

    expect(registryService.listInstalled).toHaveBeenCalledWith("pipeline");
  });

  it("passes undefined typeFilter when none provided", () => {
    vi.mocked(registryService.listInstalled).mockReturnValue({});

    listCommand(undefined);

    expect(registryService.listInstalled).toHaveBeenCalledWith(undefined);
  });

  it("handles single package correctly", () => {
    vi.mocked(registryService.listInstalled).mockReturnValue({
      "x": {
        version: "9.9.9",
        type: "gate",
        author: "z",
        installed_at: "2025-06-01",
        files: [],
      },
    });

    listCommand(undefined);

    // Header + separator + 1 data row
    expect(logSpy).toHaveBeenCalledTimes(3);
    const row = logSpy.mock.calls[2][0] as string;
    expect(row).toContain("x");
    expect(row).toContain("9.9.9");
    expect(row).toContain("gate");
  });

  it("uses minimum column widths from header labels", () => {
    vi.mocked(registryService.listInstalled).mockReturnValue({
      "a": {
        version: "1",
        type: "s",
        author: "b",
        installed_at: "2025-01-01",
        files: [],
      },
    });

    listCommand(undefined);

    const header = logSpy.mock.calls[0][0] as string;
    // "Name" = 4, "Version" = 7, "Type" = 4, "Author" = 6
    // Columns separated by "  " (2 spaces)
    expect(header).toBe("Name  Version  Type  Author");
  });
});
