import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../services/registry-service.js", () => ({
  registryService: {
    search: vi.fn(),
  },
}));

import { searchCommand } from "./search.js";
import { registryService } from "../../services/registry-service.js";

describe("searchCommand", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  it("prints no-results message when search returns empty", async () => {
    vi.mocked(registryService.search).mockResolvedValue([]);

    await searchCommand("nonexistent", undefined);

    expect(logSpy).toHaveBeenCalledWith("No packages found.");
    expect(logSpy).toHaveBeenCalledTimes(1);
  });

  it("formats a table with search results", async () => {
    vi.mocked(registryService.search).mockResolvedValue([
      {
        name: "data-pipeline",
        version: "2.1.0",
        type: "pipeline",
        description: "Processes data in stages",
        author: "alice",
        tags: ["data"],
      },
      {
        name: "auth-skill",
        version: "1.0.0",
        type: "skill",
        description: "Auth helper",
        author: "bob",
        tags: ["auth"],
      },
    ]);

    await searchCommand("data", undefined);

    // Header + separator + 2 data rows
    expect(logSpy).toHaveBeenCalledTimes(4);

    const header = logSpy.mock.calls[0][0] as string;
    expect(header).toContain("Name");
    expect(header).toContain("Version");
    expect(header).toContain("Type");
    expect(header).toContain("Description");

    const separator = logSpy.mock.calls[1][0] as string;
    expect(separator).toMatch(/^-+$/);
    expect(separator.length).toBe(header.length);

    const row1 = logSpy.mock.calls[2][0] as string;
    expect(row1).toContain("data-pipeline");
    expect(row1).toContain("2.1.0");
    expect(row1).toContain("pipeline");
    expect(row1).toContain("Processes data in stages");

    const row2 = logSpy.mock.calls[3][0] as string;
    expect(row2).toContain("auth-skill");
    expect(row2).toContain("1.0.0");
    expect(row2).toContain("skill");
    expect(row2).toContain("Auth helper");
  });

  it("passes query and typeFilter to registryService.search", async () => {
    vi.mocked(registryService.search).mockResolvedValue([]);

    await searchCommand("my-query", "pipeline");

    expect(registryService.search).toHaveBeenCalledWith("my-query", "pipeline");
  });

  it("passes undefined for both query and typeFilter", async () => {
    vi.mocked(registryService.search).mockResolvedValue([]);

    await searchCommand(undefined, undefined);

    expect(registryService.search).toHaveBeenCalledWith(undefined, undefined);
  });

  it("uses minimum column widths from header labels", async () => {
    vi.mocked(registryService.search).mockResolvedValue([
      {
        name: "x",
        version: "1",
        type: "s",
        description: "d",
        author: "a",
        tags: [],
      },
    ]);

    await searchCommand(undefined, undefined);

    const header = logSpy.mock.calls[0][0] as string;
    // "Name" = 4, "Version" = 7, "Type" = 4, "Description" = 11
    expect(header).toBe("Name  Version  Type  Description");
  });
});
