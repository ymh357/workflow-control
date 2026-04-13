import { spawn, type ChildProcess } from 'child_process';
import { logger } from '../logger.js';
import type { Config } from '../types.js';
import { updateSessionId } from '../session/manager.js';

const IDLE_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes
const BUSY_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

interface MessageCallbacks {
  onText: (text: string) => void;
  onEnd: (sessionId?: string) => void | Promise<void>;
  onError: (error: string) => void | Promise<void>;
}

interface QueuedMessage {
  prompt: string;
  sessionId: string | undefined;
  cwd: string;
  callbacks: MessageCallbacks;
}

interface ManagedProcess {
  proc: ChildProcess;
  sessionId: string | undefined;
  threadTs: string;
  cwd: string;
  state: 'initializing' | 'idle' | 'busy';
  callbacks: MessageCallbacks | null;
  idleTimer: ReturnType<typeof setTimeout> | null;
  busyTimer: ReturnType<typeof setTimeout> | null;
  buffer: string;
  queue: QueuedMessage[];
}

const buildEnv = (): NodeJS.ProcessEnv => {
  const env = { ...process.env };
  delete env.CLAUDECODE;
  return env;
};

const summarizeToolInput = (name: string, input: Record<string, unknown>): string => {
  switch (name) {
    case 'Read':
    case 'Write':
      return String(input.file_path ?? '');
    case 'Edit':
      return String(input.file_path ?? '');
    case 'Bash':
      return truncate(String(input.command ?? ''), 200);
    case 'Grep':
      return `${input.pattern ?? ''} ${input.path ?? ''}`.trim();
    case 'Glob':
      return `${input.pattern ?? ''} ${input.path ?? ''}`.trim();
    default: {
      const s = JSON.stringify(input);
      return truncate(s, 200);
    }
  }
};

const truncate = (s: string, max: number): string => {
  if (s.length <= max) return s;
  return s.slice(0, max) + '... (truncated)';
};

const summarizeToolResult = (content: unknown): string => {
  if (typeof content === 'string') return truncate(content, 500);
  if (Array.isArray(content)) {
    const textParts = content
      .filter((b: Record<string, unknown>) => b.type === 'text' && typeof b.text === 'string')
      .map((b: Record<string, unknown>) => b.text as string);
    return truncate(textParts.join('\n'), 500);
  }
  return truncate(JSON.stringify(content), 500);
};

export class ProcessManager {
  private processes = new Map<string, ManagedProcess>();
  private config: Config;

  constructor(config: Config) {
    this.config = config;
  }

  async sendMessage(
    threadTs: string,
    prompt: string,
    sessionId: string | undefined,
    cwd: string,
    callbacks: MessageCallbacks
  ): Promise<void> {
    let managed = this.processes.get(threadTs);

    if (managed && managed.state === 'busy') {
      const MAX_QUEUE = 5;
      if (managed.queue.length >= MAX_QUEUE) {
        await Promise.resolve(callbacks.onError('Queue full, please wait for current requests to complete'));
        return;
      }
      managed.queue.push({ prompt, sessionId, cwd, callbacks });
      logger.info({ threadTs, queueSize: managed.queue.length }, 'Message queued');
      return;
    }

    // If process exists but is dead, clean it up
    if (managed && managed.proc.exitCode !== null) {
      this.cleanup(threadTs);
      managed = undefined;
    }

    if (!managed) {
      managed = this.spawnProcess(threadTs, sessionId, cwd);
      this.processes.set(threadTs, managed);
    }

    managed.state = 'busy';
    managed.callbacks = callbacks;
    this.resetBusyTimer(managed);
    this.resetIdleTimer(managed);

    const stdinMsg = JSON.stringify({
      type: 'user',
      message: { role: 'user', content: prompt },
    }) + '\n';

    try {
      const ok = managed.proc.stdin!.write(stdinMsg);
      if (!ok) {
        // Wait for drain
        await new Promise<void>((resolve) => managed!.proc.stdin!.once('drain', resolve));
      }
    } catch (err) {
      logger.error({ err, threadTs }, 'Failed to write to stdin, respawning');
      this.cleanup(threadTs);
      // Fallback: spawn fresh process
      managed = this.spawnProcess(threadTs, sessionId, cwd);
      this.processes.set(threadTs, managed);
      managed.state = 'busy';
      managed.callbacks = callbacks;
      this.resetBusyTimer(managed);

      try {
        managed.proc.stdin!.write(stdinMsg);
      } catch (retryErr) {
        this.cleanup(threadTs);
        await Promise.resolve(callbacks.onError(`Failed to communicate with CLI: ${retryErr}`));
      }
    }
  }

  private spawnProcess(threadTs: string, sessionId: string | undefined, cwd: string): ManagedProcess {
    const args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--dangerously-skip-permissions'];
    if (sessionId) {
      args.push('-r', sessionId);
    }

    logger.info({ threadTs, args, cwd }, 'Spawning persistent Claude process');

    const proc = spawn('claude', args, {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: buildEnv(),
    });

    const managed: ManagedProcess = {
      proc,
      sessionId,
      threadTs,
      cwd,
      state: 'initializing',
      callbacks: null,
      idleTimer: null,
      busyTimer: null,
      buffer: '',
      queue: [],
    };

    proc.stdout!.on('data', (chunk: Buffer) => {
      this.handleStdout(managed, chunk.toString());
    });

    proc.stderr!.on('data', (chunk: Buffer) => {
      logger.debug({ stderr: chunk.toString(), threadTs }, 'Claude persistent stderr');
    });

    proc.on('close', (code) => {
      logger.info({ threadTs, code }, 'Persistent process closed');
      if (managed.callbacks && managed.state === 'busy') {
        const cb = managed.callbacks;
        managed.callbacks = null;
        if (code !== 0 && code !== null) {
          Promise.resolve(cb.onError(`Claude process exited with code ${code}`)).catch(() => {});
        } else {
          Promise.resolve(cb.onEnd(managed.sessionId)).catch(() => {});
        }
      }
      // Fail all queued messages
      for (const queued of managed.queue) {
        Promise.resolve(queued.callbacks.onError(`Claude process closed unexpectedly (code ${code})`)).catch(() => {});
      }
      managed.queue = [];
      this.cleanup(threadTs);
    });

    proc.on('error', (err) => {
      logger.error({ err, threadTs }, 'Persistent process error');
      if (managed.callbacks) {
        const cb = managed.callbacks;
        managed.callbacks = null;
        Promise.resolve(cb.onError(`Claude process error: ${err.message}`)).catch(() => {});
      }
      // Fail all queued messages
      for (const queued of managed.queue) {
        Promise.resolve(queued.callbacks.onError(`Claude process error: ${err.message}`)).catch(() => {});
      }
      managed.queue = [];
      this.cleanup(threadTs);
    });

    return managed;
  }

  private handleStdout(managed: ManagedProcess, data: string): void {
    if (managed.state === 'busy') {
      this.resetBusyTimer(managed);
    }
    managed.buffer += data;
    const lines = managed.buffer.split('\n');
    managed.buffer = lines.pop() ?? '';

    for (const line of lines) {
      if (!line.trim()) continue;

      let event: Record<string, unknown>;
      try {
        event = JSON.parse(line);
      } catch {
        logger.debug({ line }, 'Non-JSON line from persistent process');
        continue;
      }

      // Init event — extract session ID
      if (event.type === 'system' && event.subtype === 'init') {
        const sid = event.session_id as string | undefined;
        if (sid) {
          managed.sessionId = sid;
          updateSessionId(managed.threadTs, sid);
          logger.info({ threadTs: managed.threadTs, sessionId: sid }, 'Session ID from init');
        }
        if (managed.state === 'initializing') {
          managed.state = 'idle';
        }
        continue;
      }

      // Assistant message — stream text
      if (event.type === 'assistant' && managed.callbacks) {
        const message = event.message as
          | { content?: Array<{ type: string; text?: string }> }
          | undefined;
        if (message?.content && Array.isArray(message.content)) {
          for (const block of message.content) {
            if (block.type === 'text' && block.text) {
              managed.callbacks.onText(block.text);
            }
          }
        }
        continue;
      }

      // Result event — turn complete
      if (event.type === 'result') {
        const sid = event.session_id as string | undefined;
        if (sid) {
          managed.sessionId = sid;
          updateSessionId(managed.threadTs, sid);
        }

        if (managed.callbacks) {
          const cb = managed.callbacks;
          managed.callbacks = null;
          managed.state = 'idle';
          this.clearBusyTimer(managed);
          this.resetIdleTimer(managed);
          Promise.resolve(cb.onEnd(sid)).then(() => {
            this.drainQueue(managed.threadTs);
          }).catch((err) => {
            logger.error({ err }, 'onEnd callback failed');
            this.drainQueue(managed.threadTs);
          });
        } else {
          this.drainQueue(managed.threadTs);
        }
        continue;
      }

      // Tool use event — show what tool is being called
      if (event.type === 'tool_use' && managed.callbacks) {
        const toolName = event.name as string ?? 'unknown';
        const toolInput = (event.input as Record<string, unknown>) ?? {};
        const summary = summarizeToolInput(toolName, toolInput);
        managed.callbacks.onText(`\n> Tool: ${toolName} ${summary}\n`);
        continue;
      }

      // Tool result event — show tool output summary
      if (event.type === 'tool_result' && managed.callbacks) {
        const content = event.content ?? event.output ?? '';
        const summary = summarizeToolResult(content);
        managed.callbacks.onText(`> Result: ${summary}\n\n`);
        continue;
      }

      // Other events (rate_limit_event etc.) — ignore
    }
  }

  private drainQueue(threadTs: string): void {
    const managed = this.processes.get(threadTs);
    if (!managed || managed.queue.length === 0) return;

    const next = managed.queue.shift()!;
    logger.info({ threadTs, remaining: managed.queue.length }, 'Dequeuing next message');
    this.sendMessage(threadTs, next.prompt, next.sessionId, next.cwd, next.callbacks).catch((err) => {
      logger.error({ err, threadTs }, 'Failed to process queued message');
    });
  }

  private resetIdleTimer(managed: ManagedProcess): void {
    if (managed.idleTimer) {
      clearTimeout(managed.idleTimer);
    }
    managed.idleTimer = setTimeout(() => {
      logger.info({ threadTs: managed.threadTs }, 'Killing idle persistent process');
      this.killProcess(managed.threadTs);
    }, IDLE_TIMEOUT_MS);
  }

  private resetBusyTimer(managed: ManagedProcess): void {
    if (managed.busyTimer) {
      clearTimeout(managed.busyTimer);
    }
    if (managed.state !== 'busy') {
      managed.busyTimer = null;
      return;
    }
    managed.busyTimer = setTimeout(() => {
      logger.error({ threadTs: managed.threadTs }, 'Busy timeout — killing unresponsive process');
      if (managed.callbacks) {
        const cb = managed.callbacks;
        managed.callbacks = null;
        Promise.resolve(cb.onError('Request timed out (no output for 5 minutes)')).catch(() => {});
      }
      // Fail all queued messages
      for (const queued of managed.queue) {
        Promise.resolve(queued.callbacks.onError('Request timed out — process killed')).catch(() => {});
      }
      managed.queue = [];
      this.killProcess(managed.threadTs);
    }, BUSY_TIMEOUT_MS);
  }

  private clearBusyTimer(managed: ManagedProcess): void {
    if (managed.busyTimer) {
      clearTimeout(managed.busyTimer);
      managed.busyTimer = null;
    }
  }

  private cleanup(threadTs: string): void {
    const managed = this.processes.get(threadTs);
    if (!managed) return;
    if (managed.idleTimer) clearTimeout(managed.idleTimer);
    if (managed.busyTimer) clearTimeout(managed.busyTimer);
    this.processes.delete(threadTs);
  }

  killProcess(threadTs: string): void {
    const managed = this.processes.get(threadTs);
    if (!managed) return;
    try {
      managed.proc.kill('SIGTERM');
    } catch {
      // ignore
    }
    this.cleanup(threadTs);
  }

  shutdown(): void {
    logger.info({ count: this.processes.size }, 'Shutting down all persistent processes');
    for (const threadTs of this.processes.keys()) {
      this.killProcess(threadTs);
    }
  }

  getActiveCount(): number {
    return this.processes.size;
  }
}
