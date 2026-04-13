import { spawn, type ChildProcess } from 'child_process';
import { logger } from '../logger.js';
import type { Config } from '../types.js';
import { updateSessionId } from '../session/manager.js';

const IDLE_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes

interface MessageCallbacks {
  onText: (text: string) => void;
  onEnd: (sessionId?: string) => void | Promise<void>;
  onError: (error: string) => void | Promise<void>;
}

interface ManagedProcess {
  proc: ChildProcess;
  sessionId: string | undefined;
  threadTs: string;
  cwd: string;
  state: 'initializing' | 'idle' | 'busy';
  callbacks: MessageCallbacks | null;
  idleTimer: ReturnType<typeof setTimeout> | null;
  buffer: string;
}

const buildEnv = (): NodeJS.ProcessEnv => {
  const env = { ...process.env };
  delete env.CLAUDECODE;
  return env;
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
      await Promise.resolve(callbacks.onError('Previous request still processing'));
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
      buffer: '',
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
      this.cleanup(threadTs);
    });

    proc.on('error', (err) => {
      logger.error({ err, threadTs }, 'Persistent process error');
      if (managed.callbacks) {
        const cb = managed.callbacks;
        managed.callbacks = null;
        Promise.resolve(cb.onError(`Claude process error: ${err.message}`)).catch(() => {});
      }
      this.cleanup(threadTs);
    });

    return managed;
  }

  private handleStdout(managed: ManagedProcess, data: string): void {
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
          this.resetIdleTimer(managed);
          Promise.resolve(cb.onEnd(sid)).catch((err) => {
            logger.error({ err }, 'onEnd callback failed');
          });
        }
        continue;
      }

      // Other events (rate_limit_event etc.) — ignore
    }
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

  private cleanup(threadTs: string): void {
    const managed = this.processes.get(threadTs);
    if (!managed) return;
    if (managed.idleTimer) clearTimeout(managed.idleTimer);
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
