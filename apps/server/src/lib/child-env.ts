// Allowlist of environment variable prefixes/names safe to pass to agent child processes.
// Everything else (API keys, DB URLs, secrets) is excluded.

const ALLOWED_EXACT = new Set([
  "HOME", "USER", "LOGNAME", "SHELL", "LANG", "LC_ALL", "LC_CTYPE",
  "TERM", "TERM_PROGRAM", "COLORTERM",
  "PATH", "TMPDIR", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME",
  "NODE_ENV", "CI", "EDITOR", "VISUAL",
  // Git
  "GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL",
  "GIT_SSH_COMMAND", "GIT_TERMINAL_PROMPT",
  // Node
  "NODE_PATH", "NODE_EXTRA_CA_CERTS",
  // Platform
  "DISPLAY", "WAYLAND_DISPLAY",
  // Workflow-control specific
  "OG_TASK_ID", "OG_SERVER_URL", "OG_STAGE_NAME",
]);

const ALLOWED_PREFIXES = [
  "LC_",
  "SSH_",
  "GPG_",
  "HOMEBREW_",
  "NVM_",
  "FNM_",
  "VOLTA_",
  "MISE_",
  "ASDF_",
  "PYENV_",
  "GOPATH", "GOROOT", "GOBIN",
  "CARGO_", "RUSTUP_",
  "JAVA_HOME",
  "ANDROID_",
];

const cleanupFns = new Set<() => void>();
let signalHandlersRegistered = false;

export function registerChildCleanup(fn: () => void): void {
  cleanupFns.add(fn);
  if (!signalHandlersRegistered) {
    signalHandlersRegistered = true;
    const runCleanup = () => {
      for (const f of cleanupFns) {
        try { f(); } catch { /* best-effort */ }
      }
    };
    process.on("exit", runCleanup);
    // NOTE: SIGTERM/SIGINT handled by index.ts gracefulShutdown.
    // "exit" event fires after process.exit() is called there.
  }
}

/**
 * Build a filtered environment for child processes.
 * @param extra - Additional env vars to include. MUST only contain server-controlled values, never user input.
 *                These bypass the allowlist entirely.
 */
export function buildChildEnv(extra?: Record<string, string | undefined>): Record<string, string | undefined> {
  const filtered: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (ALLOWED_EXACT.has(key)) {
      filtered[key] = value;
      continue;
    }
    if (ALLOWED_PREFIXES.some((prefix) => key.startsWith(prefix))) {
      filtered[key] = value;
    }
  }
  if (extra) {
    Object.assign(filtered, extra);
  }
  return filtered;
}
