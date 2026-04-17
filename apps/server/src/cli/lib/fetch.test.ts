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
  it("returns local index when remote is unavailable", async () => {
    // fetchIndex now always attempts to merge remote into local (local wins);
    // when the remote call fails (mocked here by throwing), it falls back to
    // local-only. Previous behaviour returned local without ever contacting
    // the remote at all, but merging gives CI builds a way to pick up new
    // remote packages even when a stale local index is checked in.
    const index = { version: 1, updated_at: "2025-01-01", packages: [] };
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(index));
    globalFetch.mockRejectedValue(new TypeError("fetch failed"));

    const result = await fetchIndex();

    expect(result).toEqual(index);
    expect(fs.existsSync).toHaveBeenCalledWith("/fake/registry/index.json");
  });

  it("merges remote packages into local (local wins on name collision)", async () => {
    const local = {
      version: 1,
      updated_at: "local",
      packages: [{ name: "shared", version: "local-v" }, { name: "local-only", version: "1.0.0" }],
    };
    const remote = {
      version: 1,
      updated_at: "remote",
      packages: [{ name: "shared", version: "remote-v" }, { name: "remote-only", version: "2.0.0" }],
    };
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(local));
    globalFetch.mockResolvedValue({ ok: true, json: () => Promise.resolve(remote) });

    const result = await fetchIndex();

    // Local wins on shared; remote fills in remote-only; local-only preserved.
    expect(result.packages).toEqual(expect.arrayContaining([
      { name: "shared", version: "local-v" },
      { name: "local-only", version: "1.0.0" },
      { name: "remote-only", version: "2.0.0" },
    ]));
    expect(result.packages).toHaveLength(3);
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

  it("throws a unified error when remote HTTP fails and no local index exists", async () => {
    // Remote errors (non-OK status OR thrown network error) are swallowed
    // and converted to the unified "No registry index available" error if
    // there's also no local copy. Tests that used to assert specific HTTP /
    // network error messages were written for an earlier, strict-remote
    // implementation.
    vi.mocked(fs.existsSync).mockReturnValue(false);
    globalFetch.mockResolvedValue({ ok: false, status: 404, statusText: "Not Found" });

    await expect(fetchIndex()).rejects.toThrow("No registry index available");
  });

  it("throws the unified error on network failure with no local index", async () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    globalFetch.mockRejectedValue(new TypeError("fetch failed"));

    await expect(fetchIndex()).rejects.toThrow("No registry index available");
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

  it("falls through to remote when local packages dir exists but manifest is missing", async () => {
    // Previous behaviour was strict-local: missing manifest in local dir threw
    // "Manifest not found in local registry". The implementation switched to
    // fall-through: local-miss tries remote, so a half-built local index (e.g.
    // dev environment with some packages cached, others not) still works. The
    // test now verifies the remote fetch is attempted; an HTTP error surfaces
    // the network-layer message.
    vi.mocked(fs.existsSync).mockImplementation((p) => {
      const s = String(p);
      if (s.endsWith("packages")) return true;
      if (s.includes("manifest.yaml")) return false;
      return false;
    });
    globalFetch.mockResolvedValue({ ok: false, status: 404, statusText: "Not Found" });

    await expect(fetchManifest("missing-pkg")).rejects.toThrow(
      'Failed to fetch manifest for "missing-pkg": 404 Not Found',
    );
    expect(globalFetch).toHaveBeenCalledWith(
      "https://example.com/registry/packages/missing-pkg/manifest.yaml",
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

  it("rejects package name with special characters (path traversal guard)", async () => {
    // Security hardening: package names containing "/" or ".." are rejected
    await expect(fetchManifest("@scope/pkg")).rejects.toThrow("Invalid package name");
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

  it("falls through to remote when local file is missing", async () => {
    // Same strict-local → fall-through change as fetchManifest above.
    vi.mocked(fs.existsSync).mockImplementation((p) => {
      const s = String(p);
      if (s.endsWith("packages")) return true;
      return false;
    });
    globalFetch.mockResolvedValue({ ok: false, status: 500, statusText: "Internal Server Error" });

    await expect(fetchPackageFile("pkg", "missing.yaml")).rejects.toThrow(
      'Failed to fetch file "missing.yaml" from "pkg": 500 Internal Server Error',
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
