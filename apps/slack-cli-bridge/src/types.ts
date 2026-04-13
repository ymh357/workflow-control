export interface Config {
  defaultCwd: string;
  maxFileSize: number;
  sessionTtlHours: number;
  updateDebounceMs: number;
  maxMessageLength: number;
}

export interface Session {
  threadTs: string;
  channel: string;
  cwd: string;
  sessionId?: string;
  createdAt: number;
}

export interface SessionStore {
  [threadTs: string]: Session;
}

export interface ParsedMessage {
  cwd: string | null;
  prompt: string;
}
