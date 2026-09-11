import React, { createContext, useCallback, useContext, useState } from "react";

type ToastType = "success" | "error" | "info" | "warning";

interface ToastItem {
  id: number;
  message: string;
  type: ToastType;
}

interface ToastContextValue {
  showToast: (message: string, type?: ToastType) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

export const useToast = (): ToastContextValue => {
  const context = useContext(ToastContext);
  if (!context) {
    throw new Error("useToast phải được dùng bên trong ToastProvider");
  }
  return context;
};

export const ToastProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [toasts, setToasts] = useState<ToastItem[]>([]);

  const showToast = useCallback((message: string, type: ToastType = "info") => {
    const id = Date.now() + Math.random();
    setToasts((prev) => [...prev, { id, message, type }]);

    window.setTimeout(() => {
      setToasts((prev) => prev.filter((toast) => toast.id !== id));
    }, 4500);
  }, []);

  return (
    <ToastContext.Provider value={{ showToast }}>
      {children}
      <div
        aria-live="polite"
        aria-atomic="false"
        style={{
          position: "fixed",
          top: 16,
          right: 16,
          zIndex: 9999,
          display: "flex",
          flexDirection: "column",
          gap: 10,
          width: "min(380px, calc(100vw - 32px))",
          pointerEvents: "none",
        }}
      >
        {toasts.map((toast) => (
          <div
            key={toast.id}
            role={toast.type === "error" ? "alert" : "status"}
            style={{
              padding: "12px 14px",
              borderRadius: 8,
              background: "#fff",
              border: `1px solid ${
                toast.type === "success"
                  ? "#b7dfc5"
                  : toast.type === "error"
                    ? "#f1b0b7"
                    : toast.type === "warning"
                      ? "#ffe69c"
                      : "#b8daff"
              }`,
              boxShadow: "0 6px 20px rgba(0,0,0,.15)",
              color: "#212529",
              fontSize: 14,
              lineHeight: 1.45,
              pointerEvents: "auto",
            }}
          >
            {toast.type === "success" && "✅ "}
            {toast.type === "error" && "❌ "}
            {toast.type === "warning" && "⚠️ "}
            {toast.message}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
};
