import type { MessageGroup } from "@/lib/message-grouping";

const StageDivider = ({ group }: { group: MessageGroup }) => {
  const stage = group.messages[0]?.content ?? group.stage ?? "";
  return (
    <div
      className="flex items-center gap-3 py-2"
      data-stage={group.stage}
    >
      <div className="h-px flex-1 bg-purple-800/50" />
      <span className="text-[10px] font-semibold uppercase tracking-wider text-purple-400">
        {stage}
      </span>
      <div className="h-px flex-1 bg-purple-800/50" />
    </div>
  );
};

export default StageDivider;
