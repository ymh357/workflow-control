import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("node:fs", () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  mkdirSync: vi.fn(),
  writeFileSync: vi.fn(),
}));

vi.mock("node:path", async () => {
  const actual = await vi.importActual<typeof import("node:path")>("node:path");
  return { ...actual, join: vi.fn((...args: string[]) => args.join("/")), dirname: actual.dirname };
});

vi.mock("./constants.js", () => ({
  REGISTRY_BASE_URL: "https://example.com/registry",
  REGISTRY_DIR: "/fake/registry",
}));

vi.mock("yaml", () => ({
  parse: vi.fn((text: string) => JSON.parse(text)),
}));

const globalFetch = vi.fn();
vi.stubGlobal("fetch", globalFetch);

import * as fs from "node:fs";
import { fetchIndex, fetchManifest, fetchPackageFile, downloadPackageFiles } from "./fetch.js";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("fetchIndex", () => {
  it("returns parsed local index.json when file exists", async () => {
    const index = { version: 1, updated_at: "2025-01-01", packages: [] };
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(index));

    const result = await fetchIndex();

    expect(result).toEqual(index);
    expect(fs.existsSync).toHaveBeenCalledWith("/fake/registry/index.json");
    expect(globalFetch).not.toHaveBeenCalled();
  });

  it("falls back to remote fetch when local index does not exist", async () => {
    const index = { version: 2, updated_at: "2025-06-01", packages: [{ name: "test" }] };
    vi.mocked(fs.existsSync).mockReturnValue(false);
    globalFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(index),
    });

    const result = await fetchIndex();

    expect(result).toEqual(index);
    expect(globalFetch).toHaveBeenCalledWith("https://example.com/registry/index.json");
  });

  it("throws on HTTP error from remote", async () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    globalFetch.mockResolvedValue({
      ok: false,
      status: 404,
      statusText: "Not Found",
    });

    await expect(fetchIndex()).rejects.toThrow("Failed to fetch registry index: 404 Not Found");
  });

  it("throws on network failure", async () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    globalFetch.mockRejectedValue(new TypeError("fetch failed"));

    await expect(fetchIndex()).rejects.toThrow("fetch failed");
  });

  it("throws when local index.json contains invalid JSON", async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue("not-json{{{");

    await expect(fetchIndex()).rejects.toThrow();
  });
});

describe("registryUrl (via fetchIndex)", () => {
  it("handles base URL without trailing slash", async () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    globalFetch.mockResolvedValue({ ok: true, json: () => Promise.resolve({}) });

    await fetchIndex();

    // REGISTRY_BASE_URL = "https://example.com/registry" (no trailing slash)
    expect(globalFetch).toHaveBeenCalledWith("https://example.com/registry/index.json");
  });
});

describe("fetchManifest", () => {
  it("reads local manifest when local packages directory exists", async () => {
    const manifest = { name: "my-pkg", version: "1.0.0", type: "pipeline", files: [] };
    vi.mocked(fs.existsSync).mockImplementation((p) => {
      if (String(p).includes("packages")) return true;
      return false;
    });
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(manifest));

    const result = await fetchManifest("my-pkg");

    expect(result).toEqual(manifest);
    expect(globalFetch).not.toHaveBeenCalled();
  });

  it("throws when local packages dir exists but manifest is missing", async () => {
    vi.mocked(fs.existsSync).mockImplementation((p) => {
      const s = String(p);
      if (s.endsWith("packages")) return true;
      if (s.includes("manifest.yaml")) return false;
      return false;
    });

    await expect(fetchManifest("missing-pkg")).rejects.toThrow(
      'Manifest not found for "missing-pkg" in local registry',
    );
  });

  it("falls back to remote when no local packages directory", async () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    const manifest = { name: "remote-pkg", version: "2.0.0" };
    globalFetch.mockResolvedValue({
      ok: true,
      text: () => Promise.resolve(JSON.stringify(manifest)),
    });

    const result = await fetchManifest("remote-pkg");

    expect(result).toEqual(manifest);
    expect(globalFetch).toHaveBeenCalledWith(
      "https://example.com/registry/packages/remote-pkg/manifest.yaml",
    );
  });

  it("throws on HTTP error for remote manifest", async () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    globalFetch.mockResolvedValue({ ok: false, status: 500, statusText: "Internal Server Error" });

    await expect(fetchManifest("broken")).rejects.toThrow(
      'Failed to fetch manifest for "broken": 500 Internal Server Error',
    );
  });

  it("handles package name with special characters in URL", async () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    globalFetch.mockResolvedValue({
      ok: true,
      text: () => Promise.resolve('{"name":"@scope/pkg"}'),
    });

    await fetchManifest("@scope/pkg");

    expect(globalFetch).toHaveBeenCalledWith(
      "https://example.com/registry/packages/@scope/pkg/manifest.yaml",
    );
  });
});

describe("fetchPackageFile", () => {
  it("reads local file when packages directory exists", async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue("file-content-here");

    const result = await fetchPackageFile("pkg", "src/main.yaml");

    expect(result).toBe("file-content-here");
    expect(globalFetch).not.toHaveBeenCalled();
  });

  it("throws when local file is missing", async () => {
    vi.mocked(fs.existsSync).mockImplementation((p) => {
      const s = String(p);
      if (s.endsWith("packages")) return true;
      return false;
    });

    await expect(fetchPackageFile("pkg", "missing.yaml")).rejects.toThrow(
      'File "missing.yaml" not found for "pkg"',
    );
  });

  it("falls back to remote when no local packages", async () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    globalFetch.mockResolvedValue({
      ok: true,
      text: () => Promise.resolve("remote-content"),
    });

    const result = await fetchPackageFile("pkg", "data.yaml");

    expect(result).toBe("remote-content");
    expect(globalFetch).toHaveBeenCalledWith(
      "https://example.com/registry/packages/pkg/data.yaml",
    );
  });

  it("throws on HTTP error for remote file", async () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    globalFetch.mockResolvedValue({ ok: false, status: 403, statusText: "Forbidden" });

    await expect(fetchPackageFile("pkg", "secret.yaml")).rejects.toThrow(
      'Failed to fetch file "secret.yaml" from "pkg": 403 Forbidden',
    );
  });

  it("returns empty string content when file is empty", async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue("");

    const result = await fetchPackageFile("pkg", "empty.yaml");
    expect(result).toBe("");
  });
});

describe("downloadPackageFiles", () => {
  it("creates directories, writes files, and returns destination paths", async () => {
    // Make fetchPackageFile use remote path
    vi.mocked(fs.existsSync).mockReturnValue(false);
    globalFetch.mockResolvedValue({
      ok: true,
      text: () => Promise.resolve("content"),
    });

    const files = ["pipelines/main.yaml", "skills/helper.yaml"];
    const result = await downloadPackageFiles("my-pkg", files, "/dest");

    expect(result).toEqual(["/dest/pipelines/main.yaml", "/dest/skills/helper.yaml"]);

    expect(fs.mkdirSync).toHaveBeenCalledTimes(2);
    expect(fs.mkdirSync).toHaveBeenCalledWith("/dest/pipelines", { recursive: true });
    expect(fs.mkdirSync).toHaveBeenCalledWith("/dest/skills", { recursive: true });

    expect(fs.writeFileSync).toHaveBeenCalledTimes(2);
    expect(fs.writeFileSync).toHaveBeenCalledWith("/dest/pipelines/main.yaml", "content", "utf-8");
    expect(fs.writeFileSync).toHaveBeenCalledWith("/dest/skills/helper.yaml", "content", "utf-8");
  });

  it("returns empty array when given no files", async () => {
    const result = await downloadPackageFiles("my-pkg", [], "/dest");

    expect(result).toEqual([]);
    expect(fs.mkdirSync).not.toHaveBeenCalled();
    expect(fs.writeFileSync).not.toHaveBeenCalled();
  });

  it("propagates fetch error and stops on first failure", async () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    globalFetch.mockResolvedValueOnce({ ok: false, status: 404, statusText: "Not Found" });

    await expect(
      downloadPackageFiles("pkg", ["a.yaml", "b.yaml"], "/dest"),
    ).rejects.toThrow('Failed to fetch file "a.yaml" from "pkg"');

    // Second file should not have been written
    expect(fs.writeFileSync).not.toHaveBeenCalled();
  });

  it("handles files in deeply nested directories", async () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    globalFetch.mockResolvedValue({ ok: true, text: () => Promise.resolve("deep") });

    const result = await downloadPackageFiles("pkg", ["a/b/c/d.yaml"], "/out");

    expect(result).toEqual(["/out/a/b/c/d.yaml"]);
    expect(fs.mkdirSync).toHaveBeenCalledWith("/out/a/b/c", { recursive: true });
  });
});
