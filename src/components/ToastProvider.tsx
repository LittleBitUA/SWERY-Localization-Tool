import { useEffect, useState } from "react";
import { ToastHost, subscribeToasts, subscribeDismiss, type ToastData } from "./Toast";

/** Один глобальний host для toast-ів. Монтується раз на app-level. */
export function ToastProvider() {
  const [toasts, setToasts] = useState<ToastData[]>([]);

  useEffect(() => {
    const u1 = subscribeToasts((t) => setToasts((prev) => [...prev, t]));
    const u2 = subscribeDismiss((id) => setToasts((prev) => prev.filter((t) => t.id !== id)));
    return () => { u1(); u2(); };
  }, []);

  function dismiss(id: number) {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }

  return <ToastHost toasts={toasts} onDismiss={dismiss} />;
}
