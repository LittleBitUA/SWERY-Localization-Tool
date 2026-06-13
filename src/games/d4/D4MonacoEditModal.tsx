// D4 — Monaco popup для редагування одного m_aString-рядка.
// Призначений для довгих рядків де HTML <textarea> незручна (потрібен
// вбудований Find/Replace, word wrap toggle, нумерація).

import { useEffect, useState } from "react";
import Editor from "@monaco-editor/react";
import { useT } from "../../lib/i18n";

interface Props {
  open: boolean;
  initial: string;
  original?: string;
  title?: string;
  onSave: (value: string) => void;
  onClose: () => void;
}

export function D4MonacoEditModal({ open, initial, original, title, onSave, onClose }: Props) {
  const t = useT();
  const [value, setValue] = useState(initial);

  useEffect(() => { setValue(initial); }, [initial, open]);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); onClose(); }
      if ((e.ctrlKey || e.metaKey) && e.key === "Enter") { e.preventDefault(); onSave(value); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose, onSave, value]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-6"
      style={{ background: "rgba(8,0,0,0.7)", backdropFilter: "blur(4px)" }}
      onClick={onClose}
    >
      <div
        className="w-full max-w-4xl rounded-sm flex flex-col"
        onClick={(e) => e.stopPropagation()}
        style={{
          background: "linear-gradient(180deg, #1a0508 0%, #0d0204 100%)",
          border: "1px solid rgba(220,38,38,0.5)",
          color: "#f5e6e6",
          height: "70vh",
        }}
      >
        <header
          className="px-4 py-2.5 flex items-center justify-between shrink-0"
          style={{ borderBottom: "1px solid rgba(220,38,38,0.3)" }}
        >
          <div>
            <div className="text-[10px] font-bold tracking-[0.3em]" style={{ color: "#dc2626" }}>◆ MONACO ◆</div>
            <h2 className="text-[13px] font-semibold" style={{ color: "#fff" }}>{title ?? t("d4.monaco.title")}</h2>
          </div>
          <div className="flex items-center gap-1.5">
            <button onClick={() => onSave(value)} className="px-3 py-1 text-[11px] font-semibold uppercase tracking-wider rounded-sm" style={{ background: "linear-gradient(135deg, #dc2626 0%, #991b1b 100%)", border: "1px solid #ef4444", color: "#fff" }}>
              {t("d4.monaco.applySave")}
            </button>
            <button onClick={onClose} className="w-6 h-6 flex items-center justify-center rounded-sm" style={{ background: "rgba(220,38,38,0.15)", border: "1px solid rgba(220,38,38,0.3)" }}>
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        </header>

        {original && original !== value && (
          <div className="px-4 py-2 text-[11px] font-mono whitespace-pre-wrap" style={{
            background: "rgba(0,0,0,0.4)",
            borderBottom: "1px solid rgba(220,38,38,0.15)",
            color: "rgba(245,230,230,0.55)",
            maxHeight: "100px",
            overflowY: "auto",
          }}>
            <span style={{ color: "rgba(245,230,230,0.4)" }} className="uppercase tracking-wider text-[9px]">{t("d4.diff.original")}: </span>
            {original}
          </div>
        )}

        <div className="flex-1 min-h-0">
          <Editor
            height="100%"
            defaultLanguage="plaintext"
            value={value}
            onChange={(v) => setValue(v ?? "")}
            theme="vs-dark"
            options={{
              minimap: { enabled: false },
              wordWrap: "on",
              fontSize: 13,
              fontFamily: "JetBrains Mono, Consolas, monospace",
              lineNumbers: "on",
              scrollBeyondLastLine: false,
              renderLineHighlight: "line",
              tabSize: 2,
            }}
          />
        </div>

        <footer className="px-4 py-2 text-[10px] font-mono shrink-0" style={{
          borderTop: "1px solid rgba(220,38,38,0.2)",
          color: "rgba(245,230,230,0.45)",
        }}>
          Ctrl+Enter — {t("d4.monaco.applySave")} · Esc — {t("btn.close")} · Ctrl+F — {t("d4.monaco.find")}
        </footer>
      </div>
    </div>
  );
}
