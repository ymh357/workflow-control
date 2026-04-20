// Module-level kernel-next broadcaster singleton.
//
// The HTTP SSE route (src/routes/kernel-next-stream.ts) and the
// default-broadcaster runner path (Slice 4) both resolve against
// this instance. Keeping it as a named export (not a lazy getter)
// means test imports can stub or replace it deterministically via
// vi.mock; production callers simply import and use.
//
// Single-user local engine: one global broadcaster is appropriate.
// Multi-tenant scenarios (not a goal per CLAUDE.md) would require
// per-tenant isolation — revisit then.

import { KernelNextBroadcaster } from "./broadcaster.js";

export const kernelNextBroadcaster = new KernelNextBroadcaster();
