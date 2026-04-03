export interface Config {
  defaultCli: 'claude' | 'gemini';
  defaultCwd: string;
  maxFileSize: number;
  sessionTtlHours: number;
  updateDebounceMs: number;
  maxMessageLength: number;
}

export interface Session {
  threadTs: string;
  channel: string;
  cli: 'claude' | 'gemini';
  cwd: string;
  sessionId?: string;
  createdAt: number;
}

export interface SessionStore {
  [threadTs: string]: Session;
}

export interface ParsedMessage {
  cli: 'claude' | 'gemini' | null;
  cwd: string | null;
  prompt: string;
}

export interface CliAdapter {
  name: string;
  command: string;
  buildArgs(params: { prompt: string; sessionId?: string }): string[];
  extractSessionId(output: string): string | undefined;
}
