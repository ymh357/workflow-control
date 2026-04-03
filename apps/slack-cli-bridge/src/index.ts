import 'dotenv/config';
import { logger } from './logger.js';
import { loadSessions, cleanExpiredSessions } from './session/manager.js';
import { loadConfig } from './config.js';
import { ProcessManager } from './cli/process-manager.js';
import { createSlackApp, startApp } from './slack/app.js';
import { initProcessManager } from './slack/handlers.js';

const main = async (): Promise<void> => {
  const config = loadConfig();

  const required = ['SLACK_APP_TOKEN', 'SLACK_BOT_TOKEN'];
  for (const key of required) {
    if (!process.env[key]) {
      logger.error(`Missing required env var: ${key}`);
      process.exit(1);
    }
  }

  loadSessions();
  cleanExpiredSessions(config);
  setInterval(() => cleanExpiredSessions(config), 60 * 60 * 1000);

  // Initialize process manager for persistent Claude processes
  const pm = new ProcessManager(config);
  initProcessManager(pm);

  // Graceful shutdown
  const shutdown = () => {
    logger.info('Shutting down...');
    pm.shutdown();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  const app = createSlackApp();
  await startApp(app);
};

main().catch((err) => {
  logger.error({ err }, 'Fatal error');
  process.exit(1);
});
