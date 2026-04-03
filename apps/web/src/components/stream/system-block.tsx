import type { MessageGroup } from "@/lib/message-grouping";

const msgTypeColor: Record<string, string> = {
  status: "text-yellow-500",
  result: "text-green-500",
  error: "text-red-400",
  agent_progress: "text-yellow-400",
  question: "text-cyan-400",
  question_timeout_warning: "text-orange-400",
  cost_update: "text-zinc-500",
};

const borderColor: Record<string, string> = {
  error: "border-l-red-500",
  result: "border-l-green-500",
  status: "border-l-yellow-500",
};

const SystemBlock = ({ group }: { group: MessageGroup }) => {
  const msg = group.messages[0];
  const color = msgTypeColor[msg.type] ?? "text-zinc-500";
  const border = borderColor[msg.type];
  return (
    <div className={`flex items-baseline gap-2 py-0.5 ${border ? `border-l-2 ${border} pl-3` : ""}`}>
      <span className="text-[10px] text-zinc-600" suppressHydrationWarning>
        {new Date(msg.timestamp).toLocaleTimeString()}
      </span>
      <span className={`text-[10px] ${color}`}>
        {msg.content}
      </span>
    </div>
  );
};

export default SystemBlock;
