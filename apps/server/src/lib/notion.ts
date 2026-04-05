import { taskLogger } from "./logger.js";
import { withRetry } from "./slack.js";

const NOTION_API_BASE_URL = "https://api.notion.com/v1";
const NOTION_API_VERSION = "2022-06-28"; // Use a specific Notion API version

export async function updateNotionPageStatus(taskId: string, notionPageId: string, status: string): Promise<void> {
  const notionToken = process.env.NOTION_TOKEN;
  if (!notionToken) {
    taskLogger(taskId).warn("NOTION_TOKEN is not set. Skipping Notion status update.");
    return;
  }
  if (!notionPageId) {
    taskLogger(taskId).warn("notionPageId is not available. Skipping Notion status update.");
    return;
  }

  const url = `${NOTION_API_BASE_URL}/pages/${notionPageId}`;
  const headers = {
    "Authorization": `Bearer ${notionToken}`,
    "Content-Type": "application/json",
    "Notion-Version": NOTION_API_VERSION,
  };
  const body = JSON.stringify({
    properties: {
      Status: {
        select: {
          name: status,
        },
      },
    },
  });

  try {
    await withRetry(async () => {
      const response = await fetch(url, { method: "PATCH", headers, body });
      if (!response.ok) {
        const text = await response.text().catch(() => "");
        throw new Error(`Notion API ${response.status}: ${text.slice(0, 200)}`);
      }
      taskLogger(taskId).info({ notionPageId, newStatus: status }, "Notion page status updated successfully.");
    });
  } catch (error) {
    taskLogger(taskId).error({ error }, `Error updating Notion page status for ${notionPageId} after retries`);
  }
}
