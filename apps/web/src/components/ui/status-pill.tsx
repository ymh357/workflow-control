import { Badge } from "./badge";

type Status =
  | "running"
  | "gated"
  | "secret_pending"
  | "completed"
  | "failed"
  | "cancelled"
  | "orphaned"
  | "pending"
  | "skipped";

type StatusPillProps = {
  status: Status | string;
  className?: string;
};

const statusVariant = (
  status: string,
): "neutral" | "success" | "warning" | "danger" | "info" => {
  switch (status) {
    case "running":
      return "info";
    case "gated":
    case "pending":
    case "secret_pending":
      return "warning";
    case "completed":
      return "success";
    case "failed":
      return "danger";
    case "cancelled":
    case "skipped":
      return "neutral";
    case "orphaned":
      return "info";
    default:
      return "neutral";
  }
};

export const StatusPill = ({ status, className = "" }: StatusPillProps) => {
  const cls = ["uppercase tracking-wide", className].filter(Boolean).join(" ");
  return (
    <Badge variant={statusVariant(status)} className={cls}>
      {status}
    </Badge>
  );
};
