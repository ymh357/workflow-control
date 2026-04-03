import type { MessageGroup } from "@/lib/message-grouping";
import MarkdownBlock from "../markdown-block";

const AssistantTurnBlock = ({ group }: { group: MessageGroup }) => {
  const combined = group.messages.map((m) => m.content).join("");
  return (
    <div className="border-l-2 border-l-zinc-500 pl-3 py-1">
      <MarkdownBlock content={combined} />
    </div>
  );
};

export default AssistantTurnBlock;
