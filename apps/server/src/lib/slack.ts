import { logger } from "./logger.js";
import { loadSystemSettings } from "./config-loader.js";

function escapeSlackMrkdwn(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export async function withRetry<T>(fn: () => Promise<T>, maxRetries = 2, backoffMs = [1000, 2000]): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt < maxRetries) {
        await new Promise(r => setTimeout(r, backoffMs[attempt] ?? backoffMs[backoffMs.length - 1]));
      }
    }
  }
  throw lastErr;
}

function getWebBaseUrl(): string {
  return process.env.WEB_BASE_URL ?? "http://localhost:3000";
}

function taskLink(taskId: string): string {
  return `${getWebBaseUrl()}/task/${taskId}`;
}

function hasSocketMode(): boolean {
  const settings = loadSystemSettings();
  return !!settings.slack?.app_token;
}

async function sendSlackMessage(opts: { text: string; blocks?: unknown[] }): Promise<string | undefined> {
  const settings = loadSystemSettings();
  const botToken = settings.slack?.bot_token;
  const channelId = settings.slack?.notify_channel_id;

  if (!botToken || !channelId) {
    logger.info({ text: opts.text }, "slack: no token/channel configured, logging instead");
    return undefined;
  }

  try {
    return await withRetry(async () => {
      const body: Record<string, unknown> = { channel: channelId, text: opts.text };
      if (opts.blocks) body.blocks = opts.blocks;

      const res = await fetch("https://slack.com/api/chat.postMessage", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${botToken}`,
        },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        logger.error({ status: res.status }, "slack: HTTP error");
        return undefined;
      }
      const data = await res.json() as { ok: boolean; ts?: string; error?: string };
      if (!data.ok) {
        logger.error({ error: data.error, channel: channelId }, "slack: API error");
        return undefined;
      }
      return data.ts;
    });
  } catch (err) {
    logger.error({ err }, "slack: failed to send after retries");
    return undefined;
  }
}

export async function notifyStageComplete(taskId: string, title: string, templateName: string): Promise<void> {
  const text = `[${escapeSlackMrkdwn(templateName)}] *${escapeSlackMrkdwn(title)}*\nTask: \`${taskId.slice(0, 8)}\`\nPlease review.\n${taskLink(taskId)}`;
  await sendSlackMessage({ text });
}

export async function notifyBlocked(taskId: string, stage: string, error: string): Promise<void> {
  const safeStage = escapeSlackMrkdwn(stage);
  const safeError = escapeSlackMrkdwn(error);
  const text = `[Blocked] Task \`${taskId.slice(0, 8)}\` stuck at *${safeStage}*\nError: ${safeError}\nUse Web UI to retry or CLI to debug.\n${taskLink(taskId)}`;
  const interactive = hasSocketMode();
  const blocks: unknown[] = [
    { type: "section", text: { type: "mrkdwn", text } },
  ];
  if (interactive) {
    blocks.push({
      type: "actions",
      elements: [
        { type: "button", text: { type: "plain_text", text: "Send Message" }, action_id: "send_message", value: taskId, style: "primary" },
      ],
    });
  }
  await sendSlackMessage({ text, blocks: interactive ? blocks : undefined });
}

export async function notifyCompleted(taskId: string, deliverable: string): Promise<void> {
  const text = `[Completed] Task \`${taskId.slice(0, 8)}\`\nDeliverable: ${escapeSlackMrkdwn(deliverable)}\nPlease review.\n${taskLink(taskId)}`;
  await sendSlackMessage({ text });
}

export async function notifyQuestionAsked(taskId: string, questionId: string, question: string, options?: string[]): Promise<void> {
  const safeQuestion = escapeSlackMrkdwn(question.slice(0, 200));
  const text = `[Question] Task \`${taskId.slice(0, 8)}\` needs your input\n> ${safeQuestion}\nAnswer in Web UI.\n${taskLink(taskId)}`;
  const interactive = hasSocketMode();
  const blocks: unknown[] = [
    { type: "section", text: { type: "mrkdwn", text: `[Question] Task \`${taskId.slice(0, 8)}\` needs your input\n> ${safeQuestion}` } },
    { type: "section", text: { type: "mrkdwn", text: `<${taskLink(taskId)}|Open in Web UI>` } },
  ];

  if (interactive) {
    if (options && options.length > 0) {
      blocks.push({
        type: "actions",
        elements: options.map((opt, i) => ({
          type: "button",
          text: { type: "plain_text", text: opt.slice(0, 75) },
          action_id: `answer_option_${i}`,
          value: JSON.stringify({ questionId, taskId, option: opt }),
        })),
      });
    } else {
      blocks.push({
        type: "actions",
        elements: [
          { type: "button", text: { type: "plain_text", text: "Answer" }, action_id: "answer_question", value: JSON.stringify({ questionId, taskId, question }), style: "primary" },
        ],
      });
    }
  }

  await sendSlackMessage({ text, blocks: interactive ? blocks : undefined });
}

export async function notifyCancelled(taskId: string): Promise<void> {
  const text = `[Cancelled] Task \`${taskId.slice(0, 8)}\` was cancelled by user.\n${taskLink(taskId)}`;
  await sendSlackMessage({ text });
}

export async function notifyGenericGate(taskId: string, stageName: string, template: string): Promise<void> {
  const safeStageName = escapeSlackMrkdwn(stageName);
  const safeTemplate = escapeSlackMrkdwn(template);
  const text = `[Gate: ${safeStageName}] Task \`${taskId.slice(0, 8)}\` needs your approval.\nTemplate: ${safeTemplate}\n${taskLink(taskId)}`;
  const interactive = hasSocketMode();
  const blocks: unknown[] = [
    { type: "section", text: { type: "mrkdwn", text: `[Gate: ${safeStageName}] Task \`${taskId.slice(0, 8)}\` needs your approval.\nTemplate: ${safeTemplate}\n<${taskLink(taskId)}|Open in Web UI>` } },
  ];

  if (interactive) {
    blocks.push({
      type: "actions",
      elements: [
        { type: "button", text: { type: "plain_text", text: "Approve" }, action_id: "gate_approve", value: taskId, style: "primary" },
        { type: "button", text: { type: "plain_text", text: "Reject" }, action_id: "gate_reject", value: taskId, style: "danger" },
        { type: "button", text: { type: "plain_text", text: "Reject with Feedback" }, action_id: "gate_feedback", value: taskId },
      ],
    });
  }

  await sendSlackMessage({ text, blocks: interactive ? blocks : undefined });
}
