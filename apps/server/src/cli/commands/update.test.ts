import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../services/registry-service.js", () => ({
  registryService: {
    update: vi.fn(),
  },
}));

import { updateCommand } from "./update.js";
import { registryService } from "../../services/registry-service.js";

describe("updateCommand", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  it("prints updated packages with version change", async () => {
    vi.mocked(registryService.update).mockResolvedValue({
      updated: [
        { name: "pkg-a", from: "1.0.0", to: "2.0.0" },
        { name: "pkg-b", from: "0.1.0", to: "0.2.0" },
      ],
      upToDate: [],
    });

    await updateCommand(undefined);

    expect(logSpy).toHaveBeenCalledWith("Updated pkg-a: 1.0.0 -> 2.0.0");
    expect(logSpy).toHaveBeenCalledWith("Updated pkg-b: 0.1.0 -> 0.2.0");
  });

  it("prints up-to-date packages", async () => {
    vi.mocked(registryService.update).mockResolvedValue({
      updated: [],
      upToDate: ["stable-pkg", "another-pkg"],
    });

    await updateCommand(undefined);

    expect(logSpy).toHaveBeenCalledWith("stable-pkg is already up to date.");
    expect(logSpy).toHaveBeenCalledWith("another-pkg is already up to date.");
  });

  it("prints correct count summary", async () => {
    vi.mocked(registryService.update).mockResolvedValue({
      updated: [{ name: "x", from: "1.0.0", to: "1.1.0" }],
      upToDate: ["y"],
    });

    await updateCommand(undefined);

    expect(logSpy).toHaveBeenCalledWith("\nUpdated 1 package(s).");
  });

  it("prints zero count when all up to date", async () => {
    vi.mocked(registryService.update).mockResolvedValue({
      updated: [],
      upToDate: ["a", "b"],
    });

    await updateCommand(undefined);

    expect(logSpy).toHaveBeenCalledWith("\nUpdated 0 package(s).");
  });

  it("passes optional name to registryService.update", async () => {
    vi.mocked(registryService.update).mockResolvedValue({
      updated: [{ name: "target-pkg", from: "1.0.0", to: "2.0.0" }],
      upToDate: [],
    });

    await updateCommand("target-pkg");

    expect(registryService.update).toHaveBeenCalledWith("target-pkg");
  });

  it("passes undefined when no name provided", async () => {
    vi.mocked(registryService.update).mockResolvedValue({
      updated: [],
      upToDate: [],
    });

    await updateCommand(undefined);

    expect(registryService.update).toHaveBeenCalledWith(undefined);
  });

  it("handles empty results (no updated, no upToDate)", async () => {
    vi.mocked(registryService.update).mockResolvedValue({
      updated: [],
      upToDate: [],
    });

    await updateCommand(undefined);

    expect(logSpy).toHaveBeenCalledWith("\nUpdated 0 package(s).");
    expect(logSpy).toHaveBeenCalledTimes(1);
  });
});
