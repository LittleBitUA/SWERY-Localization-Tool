// Модалка прогресу для операцій з DP2-текстурами (export single / export all /
// replace). Замінює стару inline-плашку "Busy…" над картою.
//
// Дає чотири речі, які раніше були сховані:
//  1. Який крок зараз іде (Loading, Scanning, Encoding, Writing, …) — береться
//     з потокових рядків PowerShell (`[STEP]` / `[DIAG]`).
//  2. Детермінований прогрес для exportAll (n/total відомі заздалегідь).
//  3. Цільовий .resS-файл і offset/size для replace — щоб користувач бачив, що
//     гра справді патчиться.
//  4. Згортуваний лог із усіма рядками PowerShell — для діагностики.

import { useEffect, useRef, useState } from "react";
import { useT } from "../../lib/i18n";

export type BusyKind = "exportOne" | "exportAll" | "replace";

export interface BusyTarget {
  // Для exportOne / replace — назва текстури + PathID.
  // Для exportAll — кількість текстур.
  // pathId може бути int64-як-string (HBR), або number (DP2).
  name?: string;
  pathId?: number | string;
  total?: number;
}

interface Props {
  open: boolean;
  kind: BusyKind | null;
  target: BusyTarget;
  // current/total відомі лише для exportAll (та якщо ми парсимо "Exported N" з
  // лог-рядків). Для replace тримаємо indeterminate.
  current?: number;
  total?: number;
  statusLine: string;
  lines: string[];
  done: boolean;
  error?: string | null;
  // Дані результату — для replace показуємо resS path + offset+size, для
  // export — outDir + кількість файлів.
  result?: {
    mode?: string;
    resS?: string;
    offset?: number;
    size?: number;
    output?: string;
    outDir?: string;
    exportedCount?: number;
  };
  onClose: () => void;
}

export function Dp2TextureBusyModal({
  open,
  kind,
  target,
  current,
  total,
  statusLine,
  lines,
  done,
  error,
  result,
  onClose,
}: Props) {
  const t = useT();
  const [showLog, setShowLog] = useState(false);
  const logRef = useRef<HTMLDivElement | null>(null);

  // Автоскрол хвоста логу — користувач очікує бачити останній рядок.
  useEffect(() => {
    if (!showLog || !logRef.current) return;
    logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [lines, showLog]);

  // Esc закриває лише коли done/error — інакше операція ще йде.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && (done || error)) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, done, error, onClose]);

  if (!open || !kind) return null;

  const title = (
    kind === "exportOne" ? t("textures.modal.exportOne.title")
    : kind === "exportAll" ? t("textures.modal.exportAll.title")
    : t("textures.modal.replace.title")
  );

  const subtitle = (
    kind === "exportAll"
      ? t("textures.modal.subtitle.all", { n: target.total ?? 0 })
      : t("textures.modal.subtitle.tex", { name: target.name ?? "?", pathId: target.pathId ?? 0 })
  );

  const determinate = typeof current === "number" && typeof total === "number" && total > 0;
  const percent = determinate ? Math.min(100, Math.round((current! / total!) * 100)) : null;

  const canClose = done || !!error;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onClick={(e) => { if (e.target === e.currentTarget && canClose) onClose(); }}
      role="dialog"
      aria-modal="true"
      aria-labelledby="dp2-textures-busy-title"
    >
      <div className="w-[min(640px,92vw)] rounded-xl border border-[var(--border-soft)] bg-[var(--bg-surface)] shadow-2xl flex flex-col overflow-hidden">
        <header className="px-5 py-4 border-b border-[var(--border-soft)] flex items-start gap-3">
          <div className="mt-0.5">
            {error ? (
              <svg className="w-5 h-5 text-[var(--danger,#dc2626)]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01M10.29 3.86l-8.18 14.18A2 2 0 003.84 21h16.32a2 2 0 001.73-2.96L13.71 3.86a2 2 0 00-3.42 0z" />
              </svg>
            ) : done ? (
              <svg className="w-5 h-5 text-[var(--success,#16a34a)]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
              </svg>
            ) : (
              <span className="inline-block w-5 h-5 rounded-full border-2 border-[var(--text-faint)] border-t-[var(--accent,#3b82f6)] animate-spin" aria-hidden />
            )}
          </div>
          <div className="flex-1 min-w-0">
            <h2 id="dp2-textures-busy-title" className="text-[15px] font-semibold text-[var(--text-strong)] leading-tight">
              {title}
            </h2>
            <p className="text-[12px] text-[var(--text-muted)] mt-0.5 truncate" title={subtitle}>
              {subtitle}
            </p>
          </div>
        </header>

        <div className="px-5 py-4 flex flex-col gap-3">
          <div>
            <div className="h-2 w-full rounded-full bg-[var(--bg-elevated)] overflow-hidden relative">
              {determinate ? (
                <div
                  className="h-full bg-[var(--accent,#3b82f6)] transition-[width] duration-300 ease-out"
                  style={{ width: `${percent}%` }}
                />
              ) : (
                <div
                  className={`h-full ${error ? "bg-[var(--danger,#dc2626)]" : done ? "bg-[var(--success,#16a34a)]" : "bg-[var(--accent,#3b82f6)]"}`}
                  style={{
                    width: done || error ? "100%" : "40%",
                    animation: done || error ? undefined : "dp2-busy-slide 1.2s ease-in-out infinite",
                  }}
                />
              )}
            </div>
            <div className="flex items-center justify-between mt-1.5">
              <span className="text-[11px] font-mono text-[var(--text-faint)] truncate flex-1" title={statusLine}>
                {error ? t("textures.modal.status.error") : done ? t("textures.modal.status.done") : (statusLine || t("textures.modal.status.starting"))}
              </span>
              {determinate && (
                <span className="text-[11px] font-mono text-[var(--text-muted)] tabular-nums shrink-0 ml-2">
                  {current}/{total} · {percent}%
                </span>
              )}
            </div>
          </div>

          {/* Підсумкова інформація: де саме змінено гру. Це ключове для replace —
             користувач має побачити .resS файл, offset, size. */}
          {done && !error && result && (
            <div className="rounded-lg border border-[var(--border-soft)] bg-[var(--bg-elevated)] p-3 text-[12px] flex flex-col gap-1">
              {kind === "replace" && result.mode === "resS-inplace" && (
                <>
                  <Row label={t("textures.modal.row.target")} value={result.resS ?? "—"} mono />
                  <Row label={t("textures.modal.row.bytes")} value={`${(result.size ?? 0).toLocaleString()} B`} mono />
                  <Row label={t("textures.modal.row.offset")} value={String(result.offset ?? 0)} mono />
                </>
              )}
              {kind === "replace" && result.mode !== "resS-inplace" && (
                <Row label={t("textures.modal.row.written")} value={result.output ?? "—"} mono />
              )}
              {(kind === "exportOne" || kind === "exportAll") && (
                <>
                  <Row
                    label={t("textures.modal.row.exported")}
                    value={String(result.exportedCount ?? 0)}
                  />
                  <Row label={t("textures.modal.row.outDir")} value={result.outDir ?? "—"} mono />
                </>
              )}
            </div>
          )}

          {error && (
            <div className="rounded-lg border border-[var(--danger,#dc2626)]/40 bg-[var(--danger,#dc2626)]/10 p-3 text-[12px] font-mono whitespace-pre-wrap break-words max-h-32 overflow-auto">
              {error}
            </div>
          )}

          <div>
            <button
              type="button"
              className="text-[11px] text-[var(--text-muted)] hover:text-[var(--text)] underline underline-offset-2"
              onClick={() => setShowLog((s) => !s)}
            >
              {showLog ? t("textures.modal.detail.hide") : t("textures.modal.detail.show")} ({lines.length})
            </button>
            {showLog && (
              <div
                ref={logRef}
                className="mt-2 max-h-48 overflow-auto rounded border border-[var(--border-soft)] bg-[var(--bg)] px-2 py-1.5 text-[11px] font-mono leading-relaxed text-[var(--text-muted)] whitespace-pre"
              >
                {lines.length === 0 ? (
                  <span className="text-[var(--text-faint)]">{t("textures.modal.detail.empty")}</span>
                ) : (
                  lines.map((ln, i) => <div key={i}>{ln}</div>)
                )}
              </div>
            )}
          </div>
        </div>

        <footer className="px-5 py-3 border-t border-[var(--border-soft)] bg-[var(--bg)] flex justify-end gap-2">
          <button
            type="button"
            className="dp-btn"
            onClick={onClose}
            disabled={!canClose}
          >
            {t("textures.modal.close")}
          </button>
        </footer>
      </div>

      <style>{`
        @keyframes dp2-busy-slide {
          0%   { transform: translateX(-100%); }
          50%  { transform: translateX(50%); }
          100% { transform: translateX(250%); }
        }
      `}</style>
    </div>
  );
}

function Row({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-baseline gap-2 min-w-0">
      <span className="text-[var(--text-faint)] shrink-0">{label}</span>
      <span className={`flex-1 min-w-0 truncate ${mono ? "font-mono" : ""} text-[var(--text-strong)]`} title={value}>
        {value}
      </span>
    </div>
  );
}
