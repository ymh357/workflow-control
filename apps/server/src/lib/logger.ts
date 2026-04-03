import pino from "pino";

const isDev = process.env.NODE_ENV !== "production";

export const logger = pino({
  ...(isDev
    ? { transport: { target: "pino-pretty", options: { colorize: true, translateTime: "HH:mm:ss.l", ignore: "pid,hostname" } } }
    : {}),
  level: process.env.LOG_LEVEL ?? "info",
});

export const taskLogger = (taskId: string, stage?: string): pino.Logger =>
  logger.child({ taskId: taskId.slice(0, 8), ...(stage ? { stage } : {}) });
