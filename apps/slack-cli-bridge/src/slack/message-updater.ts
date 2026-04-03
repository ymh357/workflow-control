import type { WebClient } from '@slack/web-api';
import { logger } from '../logger.js';
import type { Config } from '../types.js';

export interface MessageUpdater {
  append(text: string): void;
  finish(): Promise<void>;
}

export const createMessageUpdater = (
  client: WebClient,
  channel: string,
  threadTs: string,
  config: Config
): MessageUpdater => {
  let currentTs: string | undefined;
  let accumulated = '';
  let pendingUpdate: ReturnType<typeof setTimeout> | null = null;
  let lastUpdateTime = 0;
  let messageIndex = 0;
  let finished = false;
  let flushChain: Promise<void> = Promise.resolve();

  const postNewMessage = async (text: string): Promise<string> => {
    const result = await client.chat.postMessage({
      channel,
      thread_ts: threadTs,
      text,
    });
    return result.ts as string;
  };

  const updateMessage = async (ts: string, text: string): Promise<void> => {
    try {
      await client.chat.update({ channel, ts, text });
      lastUpdateTime = Date.now();
    } catch (err) {
      logger.error({ err, ts }, 'Failed to update message');
    }
  };

  const flushUpdate = async (): Promise<void> => {
    if (finished || !accumulated) return;

    try {
      if (!currentTs) {
        currentTs = await postNewMessage(accumulated);
        lastUpdateTime = Date.now();
        messageIndex++;
      } else if (accumulated.length > config.maxMessageLength) {
        const splitPoint = accumulated.lastIndexOf('\n', config.maxMessageLength);
        const cutoff = splitPoint > 0 ? splitPoint : config.maxMessageLength;

        await updateMessage(currentTs, accumulated.slice(0, cutoff));
        accumulated = accumulated.slice(cutoff);
        currentTs = await postNewMessage(accumulated || '...');
        lastUpdateTime = Date.now();
        messageIndex++;
      } else {
        await updateMessage(currentTs, accumulated);
      }
    } catch (err) {
      logger.error({ err }, 'flushUpdate failed');
    }
  };

  const scheduleUpdate = (): void => {
    if (pendingUpdate) return;
    const elapsed = Date.now() - lastUpdateTime;
    const delay = Math.max(0, config.updateDebounceMs - elapsed);
    pendingUpdate = setTimeout(() => {
      pendingUpdate = null;
      flushChain = flushChain.then(() => flushUpdate()).catch((err) => {
        logger.error({ err }, 'Flush chain error');
      });
    }, delay);
  };

  return {
    append(text: string) {
      accumulated += text;
      scheduleUpdate();
    },

    async finish() {
      finished = true;
      if (pendingUpdate) {
        clearTimeout(pendingUpdate);
        pendingUpdate = null;
      }

      // Wait for any in-flight flush
      await flushChain;

      if (!accumulated && !currentTs) return;

      if (!currentTs) {
        await postNewMessage(accumulated || '(empty response)');
      } else {
        await updateMessage(currentTs, accumulated);
      }
    },
  };
};
