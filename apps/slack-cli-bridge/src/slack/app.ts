import { App } from '@slack/bolt';
import { logger } from '../logger.js';
import { handleMessage, setBotUserId } from './handlers.js';

export const createSlackApp = (): App => {
  const app = new App({
    token: process.env.SLACK_BOT_TOKEN,
    appToken: process.env.SLACK_APP_TOKEN,
    socketMode: true,
  });

  app.message(handleMessage as Parameters<typeof app.message>[0]);

  return app;
};

export const startApp = async (app: App): Promise<void> => {
  await app.start();

  // Get bot user ID for mention detection
  try {
    const result = await app.client.auth.test({ token: process.env.SLACK_BOT_TOKEN });
    if (result.user_id) {
      setBotUserId(result.user_id);
      logger.info({ botUserId: result.user_id }, 'Bot user ID resolved');
    }
  } catch (err) {
    logger.warn({ err }, 'Failed to resolve bot user ID');
  }

  logger.info('Slack CLI Bridge is running');
};
