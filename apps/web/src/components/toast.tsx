"use client";

import { createContext, useContext, useState, useCallback, useEffect, useRef } from "react";

type ToastType = "success" | "error" | "info";

interface Toast {
  id: number;
  type: ToastType;
  message: string;
}

interface ToastContextValue {
  success: (message: string) => void;
  error: (message: string) => void;
  info: (message: string) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

let nextId = 0;

export const useToast = (): ToastContextValue => {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast must be used within ToastProvider");
  return ctx;
};

const ToastItem = ({ toast, onRemove }: { toast: Toast; onRemove: (id: number) => void }) => {
  const [exiting, setExiting] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => {
    timerRef.current = setTimeout(() => setExiting(true), 2700);
    return () => clearTimeout(timerRef.current);
  }, []);

  useEffect(() => {
    if (exiting) {
      const t = setTimeout(() => onRemove(toast.id), 300);
      return () => clearTimeout(t);
    }
  }, [exiting, toast.id, onRemove]);

  const colors = {
    success: "bg-emerald-900/90 border-emerald-700 text-emerald-200",
    error: "bg-red-900/90 border-red-700 text-red-200",
    info: "bg-blue-900/90 border-blue-700 text-blue-200",
  };

  return (
    <div
      className={`pointer-events-auto rounded-lg border px-4 py-3 text-sm shadow-lg backdrop-blur-sm transition-all duration-300 ${colors[toast.type]} ${exiting ? "opacity-0 translate-x-4" : "opacity-100 translate-x-0"}`}
    >
      {toast.message}
    </div>
  );
};

export const ToastProvider = ({ children }: { children: React.ReactNode }) => {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const remove = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const add = useCallback((type: ToastType, message: string) => {
    setToasts((prev) => [...prev, { id: ++nextId, type, message }]);
  }, []);

  const value: ToastContextValue = {
    success: useCallback((m: string) => add("success", m), [add]),
    error: useCallback((m: string) => add("error", m), [add]),
    info: useCallback((m: string) => add("info", m), [add]),
  };

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="fixed bottom-6 right-6 z-[9999] flex flex-col gap-2 max-w-sm">
        {toasts.map((t) => (
          <ToastItem key={t.id} toast={t} onRemove={remove} />
        ))}
      </div>
    </ToastContext.Provider>
  );
};
