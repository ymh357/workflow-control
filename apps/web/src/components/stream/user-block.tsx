import { useTranslations } from "next-intl";
import type { MessageGroup } from "@/lib/message-grouping";

const UserBlock = ({ group }: { group: MessageGroup }) => {
  const t = useTranslations("Stream");
  const msg = group.messages[0];
  return (
    <div className="border-l-2 border-l-emerald-500 pl-3 py-1">
      <div className="flex items-baseline gap-2">
        <span className="text-[10px] font-semibold text-emerald-400">{t("you")}</span>
        <span className="text-[10px] text-zinc-600" suppressHydrationWarning>
          {new Date(msg.timestamp).toLocaleTimeString()}
        </span>
      </div>
      <p className="text-sm text-zinc-300 whitespace-pre-wrap">{msg.content}</p>
    </div>
  );
};

export default UserBlock;
