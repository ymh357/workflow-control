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

  // Streaming-read regression: previous implementation did
  // Buffer.alloc(file_size - offset), which OOM'd on a 522MB session.
  // We don't reproduce 522MB here (slow CI) but we DO exceed the
  // CHUNK_SIZE boundary so the chunked read path is exercised end-to-end.

  it("reads correctly across CHUNK_SIZE (64KB) boundary", async () => {
    const p = join(dir, "big.jsonl");
    // 5000 lines of ~80 bytes each → ~400KB, easily 6 chunks.
    const lines: string[] = [];
    for (let i = 0; i < 5000; i++) {
      lines.push(`{"i":${i},"pad":"${"x".repeat(60)}"}`);
    }
    writeFileSync(p, lines.join("\n") + "\n");
    const r = await tailFile(p, 0);
    expect(r.lines).toHaveLength(5000);
    expect(r.lines[0]).toBe(lines[0]);
    expect(r.lines[4999]).toBe(lines[4999]);
    expect(r.newOffset).toBe(Buffer.byteLength(lines.join("\n") + "\n", "utf8"));
  });

  it("emits complete lines + holds partial across chunk boundary", async () => {
    const p = join(dir, "boundary.jsonl");
    // Construct so a line straddles the 64KB chunk boundary.
    const filler = "x".repeat(70 * 1024); // 70KB single line
    writeFileSync(p, `${filler}\n{"after":1}\n`);
    const r = await tailFile(p, 0);
    expect(r.lines).toHaveLength(2);
    expect(r.lines[0]).toBe(filler);
    expect(r.lines[1]).toBe('{"after":1}');
  });

  it("memory: 10MB file does not blow up (sanity for the streaming path)", async () => {
    const p = join(dir, "10m.jsonl");
    // 100k lines × ~100 bytes → ~10MB
    const buf: string[] = [];
    for (let i = 0; i < 100_000; i++) {
      buf.push(`{"i":${i},"pad":"${"y".repeat(80)}"}`);
    }
    writeFileSync(p, buf.join("\n") + "\n");
    const before = process.memoryUsage().heapUsed;
    const r = await tailFile(p, 0);
    const after = process.memoryUsage().heapUsed;
    expect(r.lines).toHaveLength(100_000);
    // A naïve Buffer.alloc(10MB) + the string array + GC churn means
    // the delta will exceed 10MB; we just assert it didn't allocate
    // anything pathologically larger than the input (e.g. 200MB).
    expect(after - before).toBeLessThan(200 * 1024 * 1024);
  });
});
