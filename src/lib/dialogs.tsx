// Стилізовані alert / confirm модалки. Замість window.alert/confirm.
//
// Використання:
//   import { alert, confirm } from "../lib/dialogs";
//   await alert("Експортовано", "C:\\file.txt");
//   const ok = await confirm("Відновити файл?", "Зміни буде втрачено.");
//
// У root React-дереві треба один раз змонтувати <DialogHost />.

import { useEffect, useState } from "react";
import { useT } from "./i18n";

export type DialogKind = "alert" | "confirm" | "choose";
export type DialogTone = "default" | "danger" | "success" | "warning";

export interface DialogChoice {
  key: string;
  label: string;
  tone?: DialogTone;
}

interface DialogRequest {
  kind: DialogKind;
  title?: string;
  message: string;
  tone?: DialogTone;
  okLabel?: string;
  cancelLabel?: string;
  choices?: DialogChoice[];
  // confirm → boolean; choose → string|null (null = dismiss).
  resolve: (val: boolean | string | null) => void;
}

const listeners = new Set<(d: DialogRequest | null) => void>();
let pending: DialogRequest[] = [];
let current: DialogRequest | null = null;

function notify() {
  for (const l of listeners) l(current);
}

function next() {
  current = pending.shift() ?? null;
  notify();
}

function enqueue<T extends boolean | string | null>(
  req: Omit<DialogRequest, "resolve">
): Promise<T> {
  return new Promise((resolve) => {
    const full: DialogRequest = { ...req, resolve: resolve as (v: boolean | string | null) => void };
    if (current) pending.push(full);
    else {
      current = full;
      notify();
    }
  });
}

export function alert(title: string, message?: string, opts?: { tone?: DialogTone }): Promise<void> {
  return enqueue<boolean>({
    kind: "alert",
    title,
    message: message ?? "",
    tone: opts?.tone,
  }).then(() => undefined);
}

/**
 * Модалка з кількома кнопками. Користувач обирає одну зі списку choices,
 * або dismiss-ає (клік-поза / Esc). Повертає key обраної опції або null
 * якщо користувач відмовився від вибору.
 */
export function choose(
  title: string,
  message: string,
  choices: DialogChoice[]
): Promise<string | null> {
  return enqueue<string | null>({
    kind: "choose",
    title,
    message,
    choices,
  });
}

export function confirm(
  title: string,
  message?: string,
  opts?: { okLabel?: string; cancelLabel?: string; tone?: DialogTone }
): Promise<boolean> {
  return enqueue<boolean>({
    kind: "confirm",
    title,
    message: message ?? "",
    tone: opts?.tone,
    okLabel: opts?.okLabel,
    cancelLabel: opts?.cancelLabel,
  });
}

function useCurrentDialog(): DialogRequest | null {
  const [val, setVal] = useState<DialogRequest | null>(current);
  useEffect(() => {
    const cb = (d: DialogRequest | null) => setVal(d);
    listeners.add(cb);
    return () => { listeners.delete(cb); };
  }, []);
  return val;
}

export function DialogHost() {
  const t = useT();
  const dlg = useCurrentDialog();

  // Хоткеї: Enter — підтвердити, Esc — закрити/відмова.
  useEffect(() => {
    if (!dlg) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Enter") {
        e.preventDefault();
        if (dlg.kind === "choose") finish(null);  // Enter не вибирає — нема дефолту
        else finish(true);
      } else if (e.key === "Escape") {
        e.preventDefault();
        if (dlg.kind === "alert") finish(true);   // alert Esc = "OK"
        else if (dlg.kind === "choose") finish(null);
        else finish(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dlg]);

  if (!dlg) return null;

  function finish(value: boolean | string | null) {
    if (!current) return;
    current.resolve(value);
    next();
  }

  const isConfirm = dlg.kind === "confirm";
  const isChoose  = dlg.kind === "choose";
  const okClass =
    dlg.tone === "danger" ? "dp-btn dp-btn--primary !bg-[var(--danger)]"
    : dlg.tone === "success" ? "dp-btn dp-btn--success"
    : dlg.tone === "warning" ? "dp-btn dp-btn--primary !bg-[var(--warning,#d97706)]"
    : "dp-btn dp-btn--primary";

  const okLabel = dlg.okLabel ?? (isConfirm ? t("dialog.yes") : t("dialog.ok"));
  const cancelLabel = dlg.cancelLabel ?? t("dialog.no");

  // Клік-поза: alert → "OK" (true), confirm → cancel (false), choose → null.
  const dismissValue: boolean | string | null = isChoose ? null : (!isConfirm);

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50"
      onClick={() => finish(dismissValue)}
    >
      <div
        className="dp-card w-[460px] max-w-[92vw] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {dlg.title && (
          <header className="px-5 py-3 border-b border-[var(--border-soft)]">
            <h2 className="text-[14px] font-semibold text-[var(--text-strong)]">{dlg.title}</h2>
          </header>
        )}
        {dlg.message && (
          <div className="px-5 py-4 text-[13px] text-[var(--text-muted)] whitespace-pre-wrap break-words leading-relaxed">
            {dlg.message}
          </div>
        )}
        <footer className="px-5 py-3 border-t border-[var(--border-soft)] flex items-center justify-end gap-2 flex-wrap">
          {isChoose ? (
            <>
              <button className="dp-btn" onClick={() => finish(null)}>
                {t("dialog.cancel") ?? "Скасувати"}
              </button>
              {dlg.choices?.map((c, i) => {
                const cls =
                  c.tone === "danger" ? "dp-btn dp-btn--primary !bg-[var(--danger)]"
                  : c.tone === "success" ? "dp-btn dp-btn--success"
                  : c.tone === "warning" ? "dp-btn dp-btn--primary !bg-[var(--warning,#d97706)]"
                  : "dp-btn dp-btn--primary";
                return (
                  <button
                    key={c.key}
                    className={cls}
                    onClick={() => finish(c.key)}
                    autoFocus={i === (dlg.choices?.length ?? 1) - 1}
                  >
                    {c.label}
                  </button>
                );
              })}
            </>
          ) : (
            <>
              {isConfirm && (
                <button className="dp-btn" onClick={() => finish(false)}>
                  {cancelLabel}
                </button>
              )}
              <button className={okClass} onClick={() => finish(true)} autoFocus>
                {okLabel}
              </button>
            </>
          )}
        </footer>
      </div>
    </div>
  );
}
