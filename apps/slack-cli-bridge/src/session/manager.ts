import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import { logger } from '../logger.js';
import type { Session, SessionStore, Config } from '../types.js';

const SESSION_DIR = join(process.env.HOME ?? '/tmp', '.slack-cli-bridge');
const SESSION_FILE = join(SESSION_DIR, 'sessions.json');

let store: SessionStore = {};

export const loadSessions = (): void => {
  if (!existsSync(SESSION_DIR)) {
    mkdirSync(SESSION_DIR, { recursive: true });
  }
  if (existsSync(SESSION_FILE)) {
    try {
      store = JSON.parse(readFileSync(SESSION_FILE, 'utf-8'));
      logger.info({ count: Object.keys(store).length }, 'Sessions loaded');
    } catch {
      logger.warn('Failed to load sessions, starting fresh');
      store = {};
    }
  }
};

const saveSessions = (): void => {
  writeFileSync(SESSION_FILE, JSON.stringify(store, null, 2));
};

export const getSession = (threadTs: string): Session | undefined => {
  return store[threadTs];
};

export const createSession = (params: {
  threadTs: string;
  channel: string;
  cwd: string;
}): Session => {
  const session: Session = {
    ...params,
    createdAt: Date.now(),
  };
  store[params.threadTs] = session;
  saveSessions();
  return session;
};

export const updateSessionId = (threadTs: string, sessionId: string): void => {
  const session = store[threadTs];
  if (session) {
    session.sessionId = sessionId;
    saveSessions();
    logger.info({ threadTs, sessionId }, 'Session ID updated');
  }
};

export const cleanExpiredSessions = (config: Config): void => {
  const ttlMs = config.sessionTtlHours * 60 * 60 * 1000;
  const now = Date.now();
  let cleaned = 0;

  for (const [key, session] of Object.entries(store)) {
    if (now - session.createdAt > ttlMs) {
      delete store[key];
      cleaned++;
    }
  }

  if (cleaned > 0) {
    saveSessions();
    logger.info({ cleaned }, 'Expired sessions cleaned');
  }
};
