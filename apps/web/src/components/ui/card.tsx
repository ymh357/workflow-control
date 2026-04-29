import type { HTMLAttributes, ReactNode } from "react";

type CardProps = HTMLAttributes<HTMLDivElement> & {
  as?: "div" | "article" | "section" | "aside";
  children: ReactNode;
};

export const Card = ({
  as: Tag = "div",
  className = "",
  children,
  ...rest
}: CardProps) => {
  const cls = [
    "surface-card rounded-lg border border-default bg-surface p-4",
    className,
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <Tag className={cls} {...rest}>
      {children}
    </Tag>
  );
};
