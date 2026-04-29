import type { ButtonHTMLAttributes, ReactNode } from "react";

type Variant = "primary" | "secondary" | "danger" | "ghost";
type Size = "sm" | "md";

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: Variant;
  size?: Size;
  children: ReactNode;
};

const variantClass: Record<Variant, string> = {
  primary:
    "bg-accent text-accent-fg border border-accent hover:bg-accent-hover focus-visible:ring-accent",
  secondary:
    "bg-surface text-primary border border-strong hover:bg-elevated focus-visible:ring-strong",
  danger:
    "bg-danger-bg text-danger-fg border border-danger-border hover:bg-elevated focus-visible:ring-danger-border",
  ghost:
    "bg-transparent text-secondary border border-transparent hover:bg-elevated hover:text-primary focus-visible:ring-strong",
};

const sizeClass: Record<Size, string> = {
  sm: "px-2 py-1 text-xs",
  md: "px-3 py-1.5 text-sm",
};

export const Button = ({
  variant = "secondary",
  size = "md",
  className = "",
  type = "button",
  children,
  ...rest
}: ButtonProps) => {
  const cls = [
    "inline-flex items-center justify-center gap-1.5 rounded font-medium transition-colors",
    "focus:outline-none focus-visible:ring-1 focus-visible:ring-offset-0",
    "disabled:cursor-not-allowed disabled:opacity-50",
    variantClass[variant],
    sizeClass[size],
    className,
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <button type={type} className={cls} {...rest}>
      {children}
    </button>
  );
};
