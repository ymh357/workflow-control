import type { CliAdapter } from '../types.js';

export const createGeminiAdapter = (): CliAdapter => ({
  name: 'gemini',
  command: 'gemini',

  buildArgs({ prompt, sessionId }) {
    const args = ['-p', prompt, '-o', 'stream-json', '-y'];
    if (sessionId) {
      args.push('--resume', sessionId);
    }
    return args;
  },

  extractSessionId(output: string): string | undefined {
    const lines = output.split('\n');
    for (const line of lines) {
      try {
        const event = JSON.parse(line);
        if (event.type === 'init' && event.session_id) {
          return event.session_id;
        }
      } catch {
        // skip
      }
    }
    return undefined;
  },
});
