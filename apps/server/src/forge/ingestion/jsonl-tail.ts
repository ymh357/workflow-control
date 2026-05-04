// Resumable JSONL tail. Given a path + last byte offset, reads new
// complete lines (terminated by \n), returns parsed lines and the
// offset of the last byte consumed. Partial lines (no trailing \n)
// are NOT consumed — we wait for them to complete on a subsequent
// call. Truncated files (offset > size) report `truncated: true` so
// the caller can reset.

import { open, stat } from "node:fs/promises";

export interface TailResult {
  lines: string[];
  newOffset: number;
  truncated: boolean;
}

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
    const remaining = st.size - fromOffset;
    const buf = Buffer.alloc(remaining);
    await handle.read(buf, 0, remaining, fromOffset);
    let lastNewline = -1;
    for (let i = buf.length - 1; i >= 0; i--) {
      if (buf[i] === 0x0a) { lastNewline = i; break; }
    }
    if (lastNewline === -1) {
      return { lines: [], newOffset: fromOffset, truncated: false };
    }
    const consumed = buf.subarray(0, lastNewline + 1).toString("utf8");
    const lines = consumed.split("\n").slice(0, -1);
    return { lines, newOffset: fromOffset + lastNewline + 1, truncated: false };
  } finally {
    await handle.close();
  }
}
