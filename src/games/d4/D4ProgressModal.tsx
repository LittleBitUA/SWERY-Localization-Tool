// D4-themed progress modal — червоний акцент, стилізована під атмосферу гри.
// Показує лог рядків + загальний прогрес-бар + статус по файлах.

import { useEffect, useRef } from "react";
import { useT } from "../../lib/i18n";

interface FileProgress {
  name: string;
  status: "pending" | "running" | "done" | "error";
  detail?: string;
}

interface Props {
  open: boolean;
  title: string;
  subtitle?: string;
  lines: string[];
  files?: FileProgress[];
  current?: number;     // 0..total
  total?: number;
  done?: boolean;
  error?: string | null;
  onClose: () => void;
}

export function D4ProgressModal({
  open, title, subtitle, lines, files, current, total, done, error, onClose,
}: Props) {
  const t = useT();
  const logRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [lines]);

  if (!open) return null;

  const pct = total && total > 0 ? Math.round(((current ?? 0) / total) * 100) : 0;
  const stateLabel = error ? t("d4.progress.state.error")
    : done ? t("d4.progress.state.done")
    : t("d4.progress.state.running");
  const stateColor = error ? "#ff4d4f"
    : done ? "#22c55e"
    : "#dc2626";

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-6"
      style={{
        background: "rgba(8, 0, 0, 0.85)",
        backdropFilter: "blur(6px)",
      }}
      onClick={done || error ? onClose : undefined}
    >
      <div
        className="w-full max-w-2xl"
        onClick={(e) => e.stopPropagation()}
        style={{
          background: "linear-gradient(180deg, #1a0508 0%, #0d0204 100%)",
          border: "1px solid rgba(220, 38, 38, 0.5)",
          borderRadius: 4,
          boxShadow: "0 0 40px rgba(220, 38, 38, 0.35), 0 0 80px rgba(0,0,0,0.6)",
          color: "#f5e6e6",
          fontFamily: "system-ui, sans-serif",
        }}
      >
        {/* Header — у стилі film noir / detective dossier */}
        <header
          className="px-5 py-3 flex items-center justify-between"
          style={{
            borderBottom: "1px solid rgba(220, 38, 38, 0.3)",
            background: "linear-gradient(90deg, rgba(220,38,38,0.15) 0%, rgba(220,38,38,0.05) 100%)",
          }}
        >
          <div>
            <div
              className="text-[10px] font-bold tracking-[0.3em] mb-0.5"
              style={{ color: stateColor }}
            >
              ◆ {stateLabel} ◆
            </div>
            <h2 className="text-[15px] font-semibold" style={{ color: "#fff", letterSpacing: "0.04em" }}>
              {title}
            </h2>
            {subtitle && (
              <p className="text-[11px] mt-0.5" style={{ color: "rgba(245, 230, 230, 0.6)" }}>
                {subtitle}
              </p>
            )}
          </div>
          {(done || error) && (
            <button
              onClick={onClose}
              className="!w-8 !h-8 flex items-center justify-center rounded-sm transition-colors"
              style={{
                background: "rgba(220, 38, 38, 0.1)",
                border: "1px solid rgba(220, 38, 38, 0.3)",
                color: "#f5e6e6",
              }}
              title={t("btn.close")}
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          )}
        </header>

        {/* Progress bar */}
        <div className="px-5 py-4">
          <div className="flex items-center justify-between mb-2">
            <span
              className="text-[10px] font-semibold tracking-[0.2em] uppercase"
              style={{ color: "rgba(245, 230, 230, 0.55)" }}
            >
              {t("d4.progress.section.progress")}
            </span>
            <span
              className="text-[12px] font-mono font-semibold tabular-nums"
              style={{ color: "#fff" }}
            >
              {current ?? 0} / {total ?? 0} · {pct}%
            </span>
          </div>
          <div
            className="relative h-2 rounded-sm overflow-hidden"
            style={{
              background: "rgba(245, 230, 230, 0.08)",
              border: "1px solid rgba(220, 38, 38, 0.2)",
            }}
          >
            <div
              className="h-full transition-all duration-300"
              style={{
                width: `${pct}%`,
                background: error
                  ? "linear-gradient(90deg, #7f1d1d 0%, #dc2626 100%)"
                  : done
                  ? "linear-gradient(90deg, #15803d 0%, #22c55e 100%)"
                  : "linear-gradient(90deg, #991b1b 0%, #dc2626 50%, #ef4444 100%)",
                boxShadow: "0 0 10px rgba(220, 38, 38, 0.6)",
              }}
            />
            {/* Animated stripe overlay during work */}
            {!done && !error && (
              <div
                className="absolute inset-0 opacity-30"
                style={{
                  background: "repeating-linear-gradient(45deg, transparent 0 8px, rgba(255,255,255,0.15) 8px 12px)",
                  animation: "d4-stripes 1s linear infinite",
                }}
              />
            )}
          </div>
        </div>

        {/* Files grid */}
        {files && files.length > 0 && (
          <div className="px-5 pb-3">
            <div
              className="grid grid-cols-2 gap-1.5 max-h-[180px] overflow-y-auto pr-1"
              style={{ scrollbarWidth: "thin" }}
            >
              {files.map((f) => {
                const color = f.status === "done" ? "#22c55e"
                  : f.status === "error" ? "#ef4444"
                  : f.status === "running" ? "#dc2626"
                  : "rgba(245, 230, 230, 0.3)";
                const bg = f.status === "running"
                  ? "rgba(220, 38, 38, 0.15)"
                  : f.status === "done"
                  ? "rgba(34, 197, 94, 0.08)"
                  : f.status === "error"
                  ? "rgba(239, 68, 68, 0.1)"
                  : "rgba(245, 230, 230, 0.03)";
                return (
                  <div
                    key={f.name}
                    className="flex items-center gap-2 px-2 py-1 rounded-sm font-mono text-[10.5px]"
                    style={{ background: bg, border: `1px solid ${color}33` }}
                    title={f.detail || f.name}
                  >
                    <span
                      className="inline-block w-1.5 h-1.5 rounded-full shrink-0"
                      style={{
                        background: color,
                        boxShadow: f.status === "running" ? `0 0 6px ${color}` : "none",
                      }}
                    />
                    <span className="truncate flex-1" style={{ color: f.status === "pending" ? "rgba(245, 230, 230, 0.4)" : "#f5e6e6" }}>
                      {f.name}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Log scroll */}
        <div className="px-5 pb-4">
          <div
            className="text-[10px] font-semibold tracking-[0.2em] uppercase mb-1.5"
            style={{ color: "rgba(245, 230, 230, 0.55)" }}
          >
            {t("d4.progress.section.log")}
          </div>
          <div
            ref={logRef}
            className="font-mono text-[10.5px] leading-relaxed overflow-y-auto p-3 rounded-sm"
            style={{
              background: "rgba(0, 0, 0, 0.4)",
              border: "1px solid rgba(220, 38, 38, 0.2)",
              color: "rgba(245, 230, 230, 0.75)",
              maxHeight: "180px",
              minHeight: "100px",
              scrollbarWidth: "thin",
            }}
          >
            {lines.length === 0 ? (
              <p style={{ color: "rgba(245, 230, 230, 0.3)" }}>—</p>
            ) : (
              lines.map((ln, i) => {
                const isStep = ln.includes("[STEP]");
                const isErr = ln.includes("[ERR]");
                const isWarn = ln.includes("[WARN]");
                const isResult = ln.includes("RESULT_JSON");
                return (
                  <div
                    key={i}
                    style={{
                      color: isErr ? "#ef4444"
                        : isWarn ? "#fbbf24"
                        : isResult ? "#22c55e"
                        : isStep ? "#fca5a5"
                        : "rgba(245, 230, 230, 0.75)",
                      opacity: isStep || isErr || isWarn || isResult ? 1 : 0.7,
                      whiteSpace: "pre-wrap",
                      wordBreak: "break-word",
                    }}
                  >
                    {ln}
                  </div>
                );
              })
            )}
          </div>
        </div>

        {/* Error footer */}
        {error && (
          <div
            className="px-5 py-3"
            style={{
              borderTop: "1px solid rgba(239, 68, 68, 0.4)",
              background: "rgba(127, 29, 29, 0.2)",
              color: "#fecaca",
            }}
          >
            <div className="text-[10px] font-bold tracking-[0.2em] uppercase mb-1">{t("d4.progress.section.error")}</div>
            <p className="text-[11.5px] font-mono whitespace-pre-wrap">{error}</p>
          </div>
        )}

        {/* Bottom actions */}
        <div
          className="px-5 py-3 flex items-center justify-between"
          style={{
            borderTop: "1px solid rgba(220, 38, 38, 0.25)",
            background: "rgba(0, 0, 0, 0.3)",
          }}
        >
          <span className="text-[10px] tracking-[0.2em] uppercase" style={{ color: "rgba(245, 230, 230, 0.4)" }}>
            D4: Dark Dreams Don't Die
          </span>
          {(done || error) && (
            <button
              onClick={onClose}
              className="px-5 py-1.5 text-[12px] font-semibold uppercase tracking-wider rounded-sm transition-colors"
              style={{
                background: error ? "#7f1d1d" : "#15803d",
                color: "#fff",
                border: `1px solid ${error ? "#dc2626" : "#22c55e"}`,
              }}
            >
              {error ? t("d4.progress.btn.close") : t("d4.progress.btn.done")}
            </button>
          )}
        </div>
      </div>

      <style>{`
        @keyframes d4-stripes {
          from { background-position: 0 0; }
          to   { background-position: 28px 0; }
        }
      `}</style>
    </div>
  );
}

export type { FileProgress as D4FileProgress };
