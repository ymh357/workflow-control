// Resumable JSONL tail. Given a path + last byte offset, reads new
// complete lines (terminated by \n), returns parsed lines and the
// offset of the last byte consumed. Partial lines (no trailing \n)
// are NOT consumed — we wait for them to complete on a subsequent
// call. Truncated files (offset > size) report `truncated: true` so
// the caller can reset.
//
// Memory safety: reads in fixed-size chunks rather than allocating
// `Buffer.alloc(file_size - offset)` up-front. The naïve approach
// crashed the server on a 522MB session JSONL (live regression
// 2026-05-05). This implementation uses a CHUNK_SIZE-sized buffer,
// scans each chunk for newlines, and only carries forward the bytes
// after the last \n into the next chunk — bounded memory regardless
// of file size.

import { open, stat } from "node:fs/promises";

export interface TailResult {
  lines: string[];
  newOffset: number;
  truncated: boolean;
}

const CHUNK_SIZE = 64 * 1024;

export async function tailFile(path: string, fromOffset: number): Promise<TailResult> {
  const st = await stat(path);
  if (fromOffset > st.size) {
    return { lines: [], newOffset: 0, truncated: true };
  }
  if (fromOffset === st.size) {
    return { lines: [], newOffset: fromOffset, truncated: false };
  }
  const handle = await open(path, "r");
  try {
    const buf = Buffer.alloc(CHUNK_SIZE);
    const lines: string[] = [];
    // Carry-over for the trailing partial line of each chunk: the bytes
    // after the last \n in the prior chunk get prepended to the next
    // chunk's data when we look for newlines.
    let carry: Buffer = Buffer.alloc(0);
    let cursor = fromOffset;
    let lastConsumedOffset = fromOffset;

    while (cursor < st.size) {
      const want = Math.min(CHUNK_SIZE, st.size - cursor);
      const { bytesRead } = await handle.read(buf, 0, want, cursor);
      if (bytesRead === 0) break;
      cursor += bytesRead;

      const combined = carry.length === 0
        ? buf.subarray(0, bytesRead)
        : Buffer.concat([carry, buf.subarray(0, bytesRead)]);

      // Find the last \n in `combined` to determine how much we can
      // emit as complete lines this round.
      let lastNewline = -1;
      for (let i = combined.length - 1; i >= 0; i--) {
        if (combined[i] === 0x0a) { lastNewline = i; break; }
      }
      if (lastNewline === -1) {
        // No newline yet — keep entire combined as carry. (Pathological
        // case: a single line longer than CHUNK_SIZE will grow `carry`
        // unboundedly. Real Claude Code lines are <1MB; we don't
        // optimise that further.)
        carry = Buffer.from(combined);
        continue;
      }

      const consumed = combined.subarray(0, lastNewline + 1).toString("utf8");
      // .split("\n") produces N+1 elements where the last is "" (after
      // the trailing \n). Drop it.
      const chunkLines = consumed.split("\n");
      chunkLines.pop();
      for (const line of chunkLines) lines.push(line);

      // The bytes after the last \n become carry for the next chunk —
      // and contribute to the consumed offset only when their line
      // eventually completes with a \n.
      carry = Buffer.from(combined.subarray(lastNewline + 1));
      // Newly-consumed offset: every byte at and below the last \n is
      // committed.
      lastConsumedOffset = cursor - carry.length;
    }

    return { lines, newOffset: lastConsumedOffset, truncated: false };
  } finally {
    await handle.close();
  }
}
