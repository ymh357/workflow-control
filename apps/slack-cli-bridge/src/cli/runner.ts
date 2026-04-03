import { spawn } from 'child_process';
import { logger } from '../logger.js';
import type { CliAdapter } from '../types.js';

export interface RunCliParams {
  adapter: CliAdapter;
  prompt: string;
  sessionId?: string;
  cwd: string;
  onText: (text: string) => void;
  onEnd: (sessionId?: string) => void | Promise<void>;
  onError: (error: string) => void | Promise<void>;
}

const buildEnv = (): NodeJS.ProcessEnv => {
  const env = { ...process.env };
  delete env.CLAUDECODE;
  return env;
};

export const runCli = ({
  adapter,
  prompt,
  sessionId,
  cwd,
  onText,
  onEnd,
  onError,
}: RunCliParams): { kill: () => void } => {
  const args = adapter.buildArgs({ prompt, sessionId });
  const log = logger.child({ cli: adapter.name });
  log.info({ args, cwd }, 'Spawning CLI');

  const proc = spawn(adapter.command, args, {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: buildEnv(),
  });

  let fullOutput = '';
  let buffer = '';
  let hasError = false;

  proc.stdout.on('data', (chunk: Buffer) => {
    buffer += chunk.toString();
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';

    for (const line of lines) {
      if (!line.trim()) continue;
      fullOutput += line + '\n';

      try {
        const event = JSON.parse(line) as Record<string, unknown>;
        handleStreamEvent(event, adapter.name, onText);
      } catch {
        log.debug({ line }, 'Non-JSON line from CLI');
      }
    }
  });

  proc.stderr.on('data', (chunk: Buffer) => {
    log.debug({ stderr: chunk.toString() }, 'CLI stderr');
  });

  proc.on('close', (code) => {
    if (hasError) return;

    // Process remaining buffer
    if (buffer.trim()) {
      fullOutput += buffer;
      try {
        const event = JSON.parse(buffer) as Record<string, unknown>;
        handleStreamEvent(event, adapter.name, onText);
      } catch {
        // ignore
      }
    }

    if (code !== 0 && code !== null) {
      log.error({ code }, 'CLI exited with non-zero code');
      Promise.resolve(onError(`CLI exited with code ${code}`)).catch((err) => {
        log.error({ err }, 'onError callback failed');
      });
      return;
    }

    const extractedSessionId = adapter.extractSessionId(fullOutput);
    log.info({ code, sessionId: extractedSessionId }, 'CLI process ended');
    Promise.resolve(onEnd(extractedSessionId)).catch((err) => {
      log.error({ err }, 'onEnd callback failed');
    });
  });

  proc.on('error', (err) => {
    log.error({ err }, 'Failed to spawn CLI');
    hasError = true;
    Promise.resolve(onError(`Failed to spawn ${adapter.name}: ${err.message}`)).catch((e) => {
      log.error({ e }, 'onError callback failed');
    });
  });

  return {
    kill: () => proc.kill('SIGTERM'),
  };
};

const handleStreamEvent = (
  event: Record<string, unknown>,
  cliName: string,
  onText: (text: string) => void
): void => {
  if (cliName === 'claude') {
    handleClaudeEvent(event, onText);
  } else {
    handleGeminiEvent(event, onText);
  }
};

const handleClaudeEvent = (
  event: Record<string, unknown>,
  onText: (text: string) => void
): void => {
  // { type: "assistant", message: { content: [{ type: "text", text: "..." }] } }
  if (event.type === 'assistant') {
    const message = event.message as { content?: Array<{ type: string; text?: string }> } | undefined;
    if (message?.content && Array.isArray(message.content)) {
      for (const block of message.content) {
        if (block.type === 'text' && block.text) {
          onText(block.text);
        }
      }
    }
  }
};

const handleGeminiEvent = (
  event: Record<string, unknown>,
  onText: (text: string) => void
): void => {
  // { type: "message", role: "assistant", content: "Hi", delta: true }
  if (event.type === 'message' && event.role === 'assistant' && typeof event.content === 'string') {
    onText(event.content);
  }
};
