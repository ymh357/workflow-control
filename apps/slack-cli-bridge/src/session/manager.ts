import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { writeFile } from 'fs/promises';
import { join } from 'path';
import { logger } from '../logger.js';
import type { Session, SessionStore, Config } from '../types.js';

const SESSION_DIR = join(process.env.HOME ?? '/tmp', '.slack-cli-bridge');
const SESSION_FILE = join(SESSION_DIR, 'sessions.json');
const DEBOUNCE_MS = 1000;

let store: SessionStore = {};
let dirty = false;
let debounceTimer: ReturnType<typeof setTimeout> | null = null;
let writeInFlight: Promise<void> | null = null;

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

const scheduleSave = (): void => {
  dirty = true;
  if (debounceTimer) return;
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    if (!dirty) return;
    dirty = false;
    writeInFlight = writeFile(SESSION_FILE, JSON.stringify(store, null, 2))
      .then(() => {
        writeInFlight = null;
      })
      .catch((err) => {
        writeInFlight = null;
        logger.error({ err }, 'Failed to persist sessions');
      });
  }, DEBOUNCE_MS);
};

export const flushSessions = async (): Promise<void> => {
  if (debounceTimer) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
  if (writeInFlight) {
    await writeInFlight;
  }
  if (dirty) {
    dirty = false;
    // Sync write on shutdown to guarantee persistence
    writeFileSync(SESSION_FILE, JSON.stringify(store, null, 2));
    logger.info('Sessions flushed on shutdown');
  }
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
  scheduleSave();
  return session;
};

export const updateSessionId = (threadTs: string, sessionId: string): void => {
  const session = store[threadTs];
  if (session) {
    session.sessionId = sessionId;
    scheduleSave();
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
    scheduleSave();
    logger.info({ cleaned }, 'Expired sessions cleaned');
  }
};
