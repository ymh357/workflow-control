// Bug 32 (c12+ review): the inline-script `require()` allowlist used
// to be hand-copied between runtime/inline-script-executor.ts and
// script-compile/contract-check.ts. Adding (or worse, dropping) an
// entry in one place but not the other lets a contract pass that the
// runtime then rejects, or vice versa. Single source of truth lives
// here.
//
// Scope of allowed modules: the conservative node-stdlib subset that
// lets pipeline scripts read/write project files, hash content, parse
// URLs, manipulate paths, and do trivial buffer/zlib work — without
// granting network, child-process, or worker capabilities.
//
// To add an entry: bump RUNTIME_REQUIRE_ALLOWLIST_VERSION below and
// document the new capability in docs/superpowers (or wherever the
// project tracks security-relevant policy changes). The version bump
// makes drift detectable in audit logs.
export const RUNTIME_REQUIRE_ALLOWLIST_VERSION = 1;

export const RUNTIME_REQUIRE_ALLOWLIST: ReadonlySet<string> = new Set([
  "node:fs/promises",
  "node:path",
  "node:crypto",
  "node:url",
  "node:buffer",
  "node:os",
  "node:util",
  "node:stream/promises",
  "node:zlib",
]);
