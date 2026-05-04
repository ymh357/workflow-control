import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, appendFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tailFile } from "../ingestion/jsonl-tail.js";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "jt-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe("tailFile", () => {
  it("reads complete lines from offset 0", async () => {
    const p = join(dir, "f.jsonl");
    writeFileSync(p, '{"a":1}\n{"a":2}\n');
    const r = await tailFile(p, 0);
    expect(r.lines).toEqual(['{"a":1}', '{"a":2}']);
    expect(r.newOffset).toBe(16);
    expect(r.truncated).toBe(false);
  });

  it("stops at last complete \\n (partial line not consumed)", async () => {
    const p = join(dir, "f.jsonl");
    writeFileSync(p, '{"a":1}\n{"a":2');
    const r = await tailFile(p, 0);
    expect(r.lines).toEqual(['{"a":1}']);
    expect(r.newOffset).toBe(8);
  });

  it("resumes from given offset on append", async () => {
    const p = join(dir, "f.jsonl");
    writeFileSync(p, '{"a":1}\n');
    const r1 = await tailFile(p, 0);
    appendFileSync(p, '{"a":2}\n');
    const r2 = await tailFile(p, r1.newOffset);
    expect(r2.lines).toEqual(['{"a":2}']);
    expect(r2.newOffset).toBe(16);
  });

  it("returns empty when offset == file size", async () => {
    const p = join(dir, "f.jsonl");
    writeFileSync(p, '{"a":1}\n');
    const r = await tailFile(p, 8);
    expect(r.lines).toEqual([]);
    expect(r.newOffset).toBe(8);
    expect(r.truncated).toBe(false);
  });

  it("returns truncated indicator when offset > file size", async () => {
    const p = join(dir, "f.jsonl");
    writeFileSync(p, '{"a":1}\n');
    const r = await tailFile(p, 100);
    expect(r.truncated).toBe(true);
    expect(r.newOffset).toBe(0);
    expect(r.lines).toEqual([]);
  });

  it("returns no lines when file has no newline yet", async () => {
    const p = join(dir, "f.jsonl");
    writeFileSync(p, '{"partial"');
    const r = await tailFile(p, 0);
    expect(r.lines).toEqual([]);
    expect(r.newOffset).toBe(0);
  });

  it("handles UTF-8 multi-byte characters correctly", async () => {
    const p = join(dir, "f.jsonl");
    const line = '{"text":"hello 世界"}\n';
    writeFileSync(p, line, "utf8");
    const r = await tailFile(p, 0);
    expect(r.lines).toEqual([line.slice(0, -1)]);
    expect(r.newOffset).toBe(Buffer.byteLength(line, "utf8"));
  });
});
