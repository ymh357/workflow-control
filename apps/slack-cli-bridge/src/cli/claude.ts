import type { CliAdapter } from '../types.js';

export const createClaudeAdapter = (): CliAdapter => ({
  name: 'claude',
  command: 'claude',

  buildArgs({ prompt, sessionId }) {
    const args = ['-p', prompt, '--output-format', 'stream-json', '--verbose', '--dangerously-skip-permissions'];
    if (sessionId) {
      args.push('-r', sessionId);
    }
    return args;
  },

  extractSessionId(output: string): string | undefined {
    const lines = output.split('\n');
    for (const line of lines) {
      try {
        const event = JSON.parse(line);
        if (event.type === 'result' && event.session_id) {
          return event.session_id;
        }
      } catch {
        // skip non-JSON lines
      }
    }
    return undefined;
  },
});
