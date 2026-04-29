import type { HTMLAttributes, ReactNode } from "react";

type Variant = "neutral" | "success" | "warning" | "danger" | "info";

type BadgeProps = HTMLAttributes<HTMLSpanElement> & {
  variant?: Variant;
  children: ReactNode;
};

const variantClass: Record<Variant, string> = {
  neutral: "border-default bg-elevated text-secondary",
  success: "border-success-border bg-success-bg text-success-fg",
  warning: "border-warning-border bg-warning-bg text-warning-fg",
  danger: "border-danger-border bg-danger-bg text-danger-fg",
  info: "border-info-border bg-info-bg text-info-fg",
};

export const Badge = ({
  variant = "neutral",
  className = "",
  children,
  ...rest
}: BadgeProps) => {
  const cls = [
    "inline-flex items-center rounded border px-1.5 py-0.5 text-xs font-medium",
    variantClass[variant],
    className,
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <span className={cls} {...rest}>
      {children}
    </span>
  );
};
