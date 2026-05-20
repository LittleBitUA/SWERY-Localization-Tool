// Toast — спливаюче повідомлення у правому нижньому куті у стилі програми.
// Замінює inline-статус у Header (типу "Готово → шлях"), щоб довгі шляхи
// не ламали layout верхньої панелі. Само-закривається, можна закрити вручну.

import { useEffect } from "react";
import { t } from "../lib/i18n";

export type ToastTone = "info" | "success" | "error" | "warning";

export interface ToastAction {
  label: string;
  /** Click handler. Toast закривається автоматично після виклику. */
  onClick: () => void;
}

export interface ToastData {
  id: number;
  tone: ToastTone;
  title?: string;
  body: string;
  /** ms до автозакриття. 0 = не закривати автоматично. */
  durationMs?: number;
  /** Опціональна action-кнопка (наприклад: "Перейти до запису"). */
  action?: ToastAction;
}

interface Props {
  toasts: ToastData[];
  onDismiss: (id: number) => void;
}

export function ToastHost({ toasts, onDismiss }: Props) {
  return (
    <div
      className="fixed bottom-3 right-3 z-[100] flex flex-col gap-2 pointer-events-none"
      style={{ maxWidth: 460 }}
    >
      {toasts.map((t) => (
        <ToastItem key={t.id} toast={t} onDismiss={onDismiss} />
      ))}
    </div>
  );
}

function ToastItem({ toast, onDismiss }: { toast: ToastData; onDismiss: (id: number) => void }) {
  useEffect(() => {
    if (!toast.durationMs) return;
    const id = setTimeout(() => onDismiss(toast.id), toast.durationMs);
    return () => clearTimeout(id);
  }, [toast.id, toast.durationMs, onDismiss]);

  const borderColor =
    toast.tone === "success" ? "var(--success)"
    : toast.tone === "error" ? "var(--danger)"
    : toast.tone === "warning" ? "var(--warning)"
    : "var(--accent)";

  return (
    <div
      className="pointer-events-auto dp-card flex items-start gap-3 px-4 py-3 shadow-lg animate-toast-in"
      style={{
        borderLeft: `3px solid ${borderColor}`,
        background: "var(--bg-elevated)",
      }}
    >
      <div className="flex-1 min-w-0">
        {toast.title && (
          <p className="text-[11px] font-semibold uppercase tracking-wider mb-0.5"
             style={{ color: borderColor }}>
            {toast.title}
          </p>
        )}
        <p className="text-[12.5px] text-[var(--text)] leading-snug break-all whitespace-pre-wrap">
          {toast.body}
        </p>
        {toast.action && (
          <button
            className="mt-1.5 text-[11px] font-semibold uppercase tracking-wider hover:underline"
            style={{ color: borderColor }}
            onClick={() => {
              try { toast.action!.onClick(); } finally { onDismiss(toast.id); }
            }}
          >
            {toast.action.label} →
          </button>
        )}
      </div>
      <button
        onClick={() => onDismiss(toast.id)}
        className="text-[var(--text-faint)] hover:text-[var(--text)] shrink-0"
        title={t("toast.close")}
      >
        <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
        </svg>
      </button>
    </div>
  );
}

// ── Глобальний bus ──────────────────────────────────────────────────────
// Простий event-bus, щоб будь-який компонент міг показати toast без
// прокидання callbacks через всі шари. ToastHost підписується сам.

let nextId = 1;
const showListeners = new Set<(t: ToastData) => void>();
const dismissListeners = new Set<(id: number) => void>();

export function showToast(
  body: string,
  opts: { title?: string; tone?: ToastTone; durationMs?: number; action?: ToastAction } = {}
) {
  const t: ToastData = {
    id: nextId++,
    tone: opts.tone ?? "info",
    title: opts.title,
    body,
    durationMs: opts.durationMs ?? 6000,
    action: opts.action,
  };
  for (const l of showListeners) l(t);
  return t.id;
}

/** Програмно закрити toast (за id, який повернув showToast). */
export function dismissToast(id: number) {
  for (const l of dismissListeners) l(id);
}

/** Помилка: червона рамка, 10с (довше за info — щоб встигли прочитати). */
export function showError(body: string | unknown, title?: string) {
  const msg = body instanceof Error ? body.message : typeof body === "string" ? body : String(body);
  return showToast(msg, { title: title ?? "Помилка", tone: "error", durationMs: 10000 });
}

/** Успіх: зелена рамка, 4с (короткий ack). */
export function showOk(body: string, title?: string) {
  return showToast(body, { title, tone: "success", durationMs: 4000 });
}

/** Попередження: оранжева рамка, 7с. */
export function showWarn(body: string, title?: string) {
  return showToast(body, { title, tone: "warning", durationMs: 7000 });
}

export function subscribeToasts(fn: (t: ToastData) => void): () => void {
  showListeners.add(fn);
  return () => showListeners.delete(fn);
}

export function subscribeDismiss(fn: (id: number) => void): () => void {
  dismissListeners.add(fn);
  return () => dismissListeners.delete(fn);
}
