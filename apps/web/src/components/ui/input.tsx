import type {
  InputHTMLAttributes,
  SelectHTMLAttributes,
  TextareaHTMLAttributes,
  ReactNode,
} from "react";

const baseFieldClass =
  "rounded border border-default bg-surface px-2.5 py-1.5 text-sm text-primary " +
  "placeholder:text-muted focus:border-strong focus:outline-none " +
  "disabled:cursor-not-allowed disabled:opacity-50";

type InputProps = InputHTMLAttributes<HTMLInputElement>;

export const Input = ({ className = "", type = "text", ...rest }: InputProps) => {
  return (
    <input
      type={type}
      className={[baseFieldClass, className].filter(Boolean).join(" ")}
      {...rest}
    />
  );
};

type SelectProps = SelectHTMLAttributes<HTMLSelectElement> & {
  children: ReactNode;
};

export const Select = ({ className = "", children, ...rest }: SelectProps) => {
  return (
    <select
      className={[baseFieldClass, className].filter(Boolean).join(" ")}
      {...rest}
    >
      {children}
    </select>
  );
};

type TextareaProps = TextareaHTMLAttributes<HTMLTextAreaElement>;

export const Textarea = ({ className = "", ...rest }: TextareaProps) => {
  return (
    <textarea
      className={[baseFieldClass, "font-mono", className].filter(Boolean).join(" ")}
      {...rest}
    />
  );
};
