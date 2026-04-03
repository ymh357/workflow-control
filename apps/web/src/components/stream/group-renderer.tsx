import type { MessageGroup } from "@/lib/message-grouping";
import AssistantTurnBlock from "./assistant-turn-block";
import ToolCallBlock from "./tool-call-block";
import ThinkingBlock from "./thinking-block";
import StageDivider from "./stage-divider";
import SystemBlock from "./system-block";
import UserBlock from "./user-block";

const GroupRenderer = ({ group }: { group: MessageGroup }) => {
  switch (group.type) {
    case "assistant_turn":
      return <AssistantTurnBlock group={group} />;
    case "tool_call":
      return <ToolCallBlock group={group} />;
    case "thinking":
      return <ThinkingBlock group={group} />;
    case "stage_divider":
      return <StageDivider group={group} />;
    case "user":
      return <UserBlock group={group} />;
    case "system":
      return <SystemBlock group={group} />;
    default:
      return null;
  }
};

export default GroupRenderer;
