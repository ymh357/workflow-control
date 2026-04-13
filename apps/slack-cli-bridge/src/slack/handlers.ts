import type { AllMiddlewareArgs, SlackEventMiddlewareArgs } from '@slack/bolt';
import type { WebClient } from '@slack/web-api';
import { logger } from '../logger.js';
import { loadConfig } from '../config.js';
import type { ParsedMessage } from '../types.js';
import { ProcessManager } from '../cli/process-manager.js';
import { createMessageUpdater } from './message-updater.js';
import { downloadFiles, cleanupFiles } from './file-handler.js';
import {
  getSession,
  createSession,
  updateSessionId,
} from '../session/manager.js';

const config = loadConfig();
const allowedUsers = new Set(
  (process.env.SLACK_ALLOWED_USER_IDS ?? '').split(',').map((s) => s.trim()).filter(Boolean)
);

let botUserId: string | undefined;
let processManager: ProcessManager;

export const initProcessManager = (pm: ProcessManager): void => {
  processManager = pm;
};

export const setBotUserId = (id: string): void => {
  botUserId = id;
};

const isAllowed = (userId: string): boolean => {
  if (allowedUsers.size === 0) return true;
  return allowedUsers.has(userId);
};

const parseMessage = (text: string): ParsedMessage => {
  let cwd: ParsedMessage['cwd'] = null;
  let prompt = text;

  if (botUserId) {
    prompt = prompt.replace(new RegExp(`<@${botUserId}>`, 'g'), '').trim();
  }

  const cwdMatch = prompt.match(/--cwd\s+(\S+)\s*/);
  if (cwdMatch) {
    cwd = cwdMatch[1].replace(/^~/, process.env.HOME ?? '');
    prompt = prompt.replace(cwdMatch[0], '').trim();
  }

  return { cwd, prompt };
};

export const handleMessage = async (
  args: AllMiddlewareArgs & SlackEventMiddlewareArgs<'message'>
): Promise<void> => {
  const { event, client } = args;

  if (event.subtype) return;
  if ('bot_id' in event && event.bot_id) return;
  if (!('user' in event) || !('text' in event)) return;

  const userId = event.user as string;
  const text = (event.text as string) ?? '';
  const channel = event.channel;
  const threadTs = ('thread_ts' in event ? event.thread_ts : event.ts) as string;
  const messageTs = event.ts;

  if (!isAllowed(userId)) {
    logger.info({ userId }, 'Unauthorized user ignored');
    return;
  }

  if (event.channel_type !== 'im' && botUserId && !text.includes(`<@${botUserId}>`)) {
    return;
  }

  const parsed = parseMessage(text);
  if (!parsed.prompt.trim()) return;

  logger.info({ channel, threadTs, prompt: parsed.prompt.slice(0, 100) }, 'Processing message');

  const existingSession = getSession(threadTs);
  const cwd = parsed.cwd ?? existingSession?.cwd ?? config.defaultCwd;
  const sessionId = existingSession?.sessionId;

  if (!existingSession) {
    createSession({ threadTs, channel, cwd });
  }

  // Handle file attachments
  let filePaths: string[] = [];
  const eventAny = event as unknown as Record<string, unknown>;
  if (Array.isArray(eventAny.files) && eventAny.files.length > 0) {
    filePaths = await downloadFiles(
      eventAny.files as Array<{ id: string; name: string; url_private_download?: string; size: number; mimetype?: string }>,
      threadTs,
      process.env.SLACK_BOT_TOKEN!,
      config
    );
  }

  let fullPrompt = parsed.prompt;
  if (filePaths.length > 0) {
    fullPrompt += `\n\n[Attached files: ${filePaths.join(', ')}]`;
  }

  const webClient = client as unknown as WebClient;
  const updater = createMessageUpdater(webClient, channel, threadTs, config);

  try {
    await webClient.reactions.add({ channel, timestamp: messageTs, name: 'hourglass_flowing_sand' });
  } catch {
    // ignore
  }

  const setDoneReaction = async (name: string): Promise<void> => {
    try {
      await webClient.reactions.remove({ channel, timestamp: messageTs, name: 'hourglass_flowing_sand' });
    } catch { /* ignore */ }
    try {
      await webClient.reactions.add({ channel, timestamp: messageTs, name });
    } catch { /* ignore */ }
  };

  const callbacks = {
    onText(text: string) {
      updater.append(text);
    },
    async onEnd(newSessionId?: string) {
      await updater.finish();
      if (newSessionId) updateSessionId(threadTs, newSessionId);
      await setDoneReaction('white_check_mark');
      if (filePaths.length > 0) cleanupFiles(threadTs);
    },
    async onError(error: string) {
      await updater.finish();
      try {
        await webClient.chat.postMessage({ channel, thread_ts: threadTs, text: `Error: ${error}` });
      } catch { /* ignore */ }
      await setDoneReaction('x');
      if (filePaths.length > 0) cleanupFiles(threadTs);
    },
  };

  await processManager.sendMessage(threadTs, fullPrompt, sessionId, cwd, callbacks);
};
