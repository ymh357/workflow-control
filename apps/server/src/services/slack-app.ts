import { App } from "@slack/bolt";
import { loadSystemSettings } from "../lib/config-loader.js";
import { confirmGate, rejectGate, sendMessage } from "../actions/task-actions.js";
import { questionManager } from "../lib/question-manager.js";
import { logger } from "../lib/logger.js";

let app: App | null = null;

export async function initSlackApp(): Promise<void> {
  const settings = loadSystemSettings();
  const botToken = settings.slack?.bot_token;
  const appToken = settings.slack?.app_token;

  if (!appToken || !botToken) {
    logger.info("slack: no app_token configured, Socket Mode disabled");
    return;
  }

  app = new App({
    token: botToken,
    appToken,
    socketMode: true,
  });

  // --- Gate actions ---
  app.action("gate_approve", async (args: any) => {
    await args.ack();
    const taskId = args.action.value ?? "";
    const result = confirmGate(taskId);
    const text = result.ok ? "Approved by user" : `Approve failed: ${result.message}`;
    await updateMessage(args.client, args.body, text);
  });

  app.action("gate_reject", async (args: any) => {
    await args.ack();
    const taskId = args.action.value ?? "";
    const result = rejectGate(taskId, {});
    const text = result.ok ? "Rejected by user" : `Reject failed: ${result.message}`;
    await updateMessage(args.client, args.body, text);
  });

  app.action("gate_feedback", async (args: any) => {
    await args.ack();
    const taskId = args.action.value ?? "";
    await args.client.views.open({
      trigger_id: args.body.trigger_id,
      view: {
        type: "modal",
        callback_id: "gate_feedback_modal",
        private_metadata: JSON.stringify({ taskId, channel: args.body.channel?.id, messageTs: args.body.message?.ts }),
        title: { type: "plain_text", text: "Reject with Feedback" },
        submit: { type: "plain_text", text: "Submit" },
        blocks: [
          {
            type: "input",
            block_id: "feedback_block",
            element: { type: "plain_text_input", action_id: "feedback_input", multiline: true, placeholder: { type: "plain_text", text: "Enter feedback for the agent..." } },
            label: { type: "plain_text", text: "Feedback" },
          },
        ],
      },
    });
  });

  app.view("gate_feedback_modal", async (args: any) => {
    await args.ack();
    let meta;
    try {
      meta = JSON.parse(args.view.private_metadata);
    } catch {
      return; // malformed payload, ignore
    }
    const feedback = args.view.state.values.feedback_block.feedback_input.value ?? "";
    const result = rejectGate(meta.taskId, { feedback });
    const text = result.ok ? `Rejected with feedback: "${feedback.slice(0, 100)}"` : `Reject failed: ${result.message}`;
    if (meta.channel && meta.messageTs) {
      await removeButtonsAndAppend(args.client, meta.channel, meta.messageTs, text);
    }
  });

  // --- Question actions ---
  app.action("answer_question", async (args: any) => {
    await args.ack();
    let parsed;
    try {
      parsed = JSON.parse(args.action.value ?? "{}");
    } catch {
      return; // malformed payload, ignore
    }
    await args.client.views.open({
      trigger_id: args.body.trigger_id,
      view: {
        type: "modal",
        callback_id: "answer_question_modal",
        private_metadata: JSON.stringify({ ...parsed, channel: args.body.channel?.id, messageTs: args.body.message?.ts }),
        title: { type: "plain_text", text: "Answer Question" },
        submit: { type: "plain_text", text: "Submit" },
        blocks: [
          {
            type: "section",
            text: { type: "mrkdwn", text: `*Question:* ${parsed.question?.slice(0, 200) ?? ""}` },
          },
          {
            type: "input",
            block_id: "answer_block",
            element: { type: "plain_text_input", action_id: "answer_input", multiline: true, placeholder: { type: "plain_text", text: "Type your answer..." } },
            label: { type: "plain_text", text: "Answer" },
          },
        ],
      },
    });
  });

  app.view("answer_question_modal", async (args: any) => {
    await args.ack();
    let meta;
    try {
      meta = JSON.parse(args.view.private_metadata);
    } catch {
      return; // malformed payload, ignore
    }
    const answer = args.view.state.values.answer_block.answer_input.value ?? "";
    questionManager.answer(meta.questionId, answer, meta.taskId);
    if (meta.channel && meta.messageTs) {
      await removeButtonsAndAppend(args.client, meta.channel, meta.messageTs, `Answered: "${answer.slice(0, 100)}"`);
    }
  });

  // answer_option_* — option button clicks
  app.action(/^answer_option_/, async (args: any) => {
    await args.ack();
    let parsed;
    try {
      parsed = JSON.parse(args.action.value ?? "{}");
    } catch {
      return; // malformed payload, ignore
    }
    const option = parsed.option ?? "";
    questionManager.answer(parsed.questionId, option, parsed.taskId);
    await updateMessage(args.client, args.body, `Selected option: "${option}"`);
  });

  // --- Send message action ---
  app.action("send_message", async (args: any) => {
    await args.ack();
    const taskId = args.action.value ?? "";
    await args.client.views.open({
      trigger_id: args.body.trigger_id,
      view: {
        type: "modal",
        callback_id: "send_message_modal",
        private_metadata: JSON.stringify({ taskId, channel: args.body.channel?.id, messageTs: args.body.message?.ts }),
        title: { type: "plain_text", text: "Send Message to Agent" },
        submit: { type: "plain_text", text: "Send" },
        blocks: [
          {
            type: "input",
            block_id: "message_block",
            element: { type: "plain_text_input", action_id: "message_input", multiline: true, placeholder: { type: "plain_text", text: "Type a message for the agent..." } },
            label: { type: "plain_text", text: "Message" },
          },
        ],
      },
    });
  });

  app.view("send_message_modal", async (args: any) => {
    await args.ack();
    let meta;
    try {
      meta = JSON.parse(args.view.private_metadata);
    } catch {
      return; // malformed payload, ignore
    }
    const message = args.view.state.values.message_block.message_input.value ?? "";
    const result = await sendMessage(meta.taskId, message);
    const text = result.ok ? `Message sent: "${message.slice(0, 100)}"` : `Send failed: ${result.message}`;
    if (meta.channel && meta.messageTs) {
      await removeButtonsAndAppend(args.client, meta.channel, meta.messageTs, text);
    }
  });

  await app.start();
  logger.info("slack: Socket Mode connected");
}

export async function stopSlackApp(): Promise<void> {
  if (app) {
    await app.stop();
    app = null;
    logger.info("slack: Socket Mode disconnected");
  }
}

async function updateMessage(client: any, body: any, resultText: string): Promise<void> {
  const channel = body.channel?.id;
  const ts = body.message?.ts;
  if (!channel || !ts) return;
  await removeButtonsAndAppend(client, channel, ts, resultText);
}

async function removeButtonsAndAppend(client: any, channel: string, ts: string, resultText: string): Promise<void> {
  try {
    const result = await client.conversations.history({ channel, latest: ts, inclusive: true, limit: 1 });
    const msg = result.messages?.[0];
    if (!msg) return;

    const blocks = (msg.blocks || []).filter((b: any) => b.type !== "actions");
    blocks.push({ type: "section", text: { type: "mrkdwn", text: `_${resultText}_` } });

    await client.chat.update({ channel, ts, text: msg.text || resultText, blocks });
  } catch (err) {
    logger.warn({ err }, "slack: failed to update message");
  }
}
