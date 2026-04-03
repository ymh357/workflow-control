import type { DisplayMessage } from "@/lib/types";

export type GroupType = "assistant_turn" | "tool_call" | "thinking" | "system" | "user" | "stage_divider";

export interface MessageGroup {
  id: string;
  type: GroupType;
  stage?: string;
  timestamp: string;
  messages: DisplayMessage[];
  toolName?: string;
  toolSummary?: string;
  thinkingText?: string;
}

const MSG_TYPE_TO_GROUP: Record<string, GroupType> = {
  agent_text: "assistant_turn",
  agent_tool_use: "tool_call",
  agent_tool_result: "tool_call",
  agent_thinking: "thinking",
  stage_change: "stage_divider",
  user_message: "user",
};

function getGroupType(msgType: string): GroupType {
  return MSG_TYPE_TO_GROUP[msgType] ?? "system";
}

export function groupMessages(messages: DisplayMessage[]): MessageGroup[] {
  const groups: MessageGroup[] = [];
  let current: MessageGroup | null = null;

  const flush = () => {
    if (current) groups.push(current);
    current = null;
  };

  for (const msg of messages) {
    const gType = getGroupType(msg.type);

    if (gType === "assistant_turn") {
      if (current?.type === "assistant_turn") {
        current.messages.push(msg);
        continue;
      }
      flush();
      current = {
        id: msg.id,
        type: "assistant_turn",
        stage: msg.stage,
        timestamp: msg.timestamp,
        messages: [msg],
      };
      continue;
    }

    if (gType === "tool_call") {
      // Merge tool_result into preceding tool_call group
      if (msg.type === "agent_tool_result" && current?.type === "tool_call") {
        current.messages.push(msg);
        continue;
      }
      flush();
      const toolName = msg.type === "agent_tool_use"
        ? String(msg.detail?.toolName ?? "")
        : undefined;
      current = {
        id: msg.id,
        type: "tool_call",
        stage: msg.stage,
        timestamp: msg.timestamp,
        messages: [msg],
        toolName,
      };
      continue;
    }

    if (gType === "thinking") {
      flush();
      groups.push({
        id: msg.id,
        type: "thinking",
        stage: msg.stage,
        timestamp: msg.timestamp,
        messages: [msg],
        thinkingText: msg.content,
      });
      continue;
    }

    // stage_divider: deduplicate consecutive dividers for the same stage
    if (gType === "stage_divider") {
      const lastGroup = current ?? groups[groups.length - 1];
      if (lastGroup?.type === "stage_divider" && lastGroup.stage === msg.stage) {
        continue;
      }
    }

    // stage_divider, user, system — each gets its own group
    flush();
    groups.push({
      id: msg.id,
      type: gType,
      stage: msg.stage,
      timestamp: msg.timestamp,
      messages: [msg],
    });
  }

  flush();
  return groups;
}
