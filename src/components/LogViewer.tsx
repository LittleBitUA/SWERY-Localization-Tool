import { useState } from "react";
import { useT } from "../lib/i18n";

interface Props {
  open: boolean;
  onClose: () => void;
  log: string;
  logPath?: string;
}

export function LogViewer({ open, onClose, log, logPath }: Props) {
  const t = useT();
  const [copied, setCopied] = useState(false);

  if (!open) return null;

  async function copyAll() {
    try {
      await navigator.clipboard.writeText(log);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {}
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-6 bg-black/70"
      onClick={onClose}
    >
      <div
        className="dp-card w-full max-w-4xl flex flex-col"
        style={{ maxHeight: "85vh" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-3 border-b border-[var(--border-soft)]">
          <div>
            <h2 className="text-[15px] font-semibold text-[var(--text-strong)]">
              {t("log.title")}
            </h2>
            {logPath && (
              <p className="text-[11px] font-mono text-[var(--text-faint)] mt-0.5 truncate max-w-[600px]">
                {logPath}
              </p>
            )}
          </div>
          <div className="flex items-center gap-2">
            <button onClick={copyAll} className="dp-btn">
              {copied ? t("log.copied") : t("log.copy")}
            </button>
            <button onClick={onClose} className="dp-btn dp-btn--ghost !w-7 !p-0">
              <svg
                className="w-4 h-4"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={2}
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M6 18L18 6M6 6l12 12"
                />
              </svg>
            </button>
          </div>
        </div>

        <pre
          className="flex-1 overflow-auto p-4 m-0 text-[12px] leading-[1.5] font-mono text-[var(--text)] bg-[var(--bg)] whitespace-pre-wrap break-words"
        >
          {log || t("log.empty")}
        </pre>
      </div>
    </div>
  );
}
