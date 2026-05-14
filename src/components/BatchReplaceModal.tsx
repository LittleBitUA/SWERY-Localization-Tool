// BatchReplaceModal — пошук і заміна по всіх файлах DP2-теки.
// Спершу dry-run (preview), потім користувач підтверджує застосування.
// Worker сам пише файли і створює .bak.json.

import { useEffect, useState } from "react";
import { useStore } from "../lib/store";
import { useT } from "../lib/i18n";
import { confirm as showConfirm, alert as showAlert } from "../lib/dialogs";
import { invalidateTm } from "../lib/tm";
import type { BatchReplaceOptions, BatchReplaceResult } from "../lib/ipc";

interface Props {
  open: boolean;
  onClose: () => void;
}

type Field = "en" | "charaName";

export function BatchReplaceModal({ open, onClose }: Props) {
  const t = useT();
  const folder = useStore((s) => s.folder);
  const selectedFilePath = useStore((s) => s.selectedFilePath);
  const loadFile = useStore((s) => s.loadFile);

  const [find, setFind] = useState("");
  const [replace, setReplace] = useState("");
  const [field, setField] = useState<Field>("en");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [wholeWord, setWholeWord] = useState(false);
  const [regex, setRegex] = useState(false);
  const [regexError, setRegexError] = useState<string | null>(null);

  const [loading, setLoading] = useState(false);
  const [preview, setPreview] = useState<BatchReplaceResult | null>(null);
  const [applying, setApplying] = useState(false);
  const [expandedFiles, setExpandedFiles] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (!open) {
      setPreview(null);
      setExpandedFiles(new Set());
      setRegexError(null);
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  async function runPreview() {
    if (!folder || !find) return;
    if (regex) {
      try { new RegExp(find); setRegexError(null); }
      catch (e: any) { setRegexError(String(e.message ?? e)); return; }
    }
    setLoading(true);
    setPreview(null);
    try {
      const opts: BatchReplaceOptions = {
        find, replace, field, caseSensitive, wholeWord, regex, dryRun: true,
      };
      const res = await window.dp2.batchReplaceWorker({ folder, opts });
      setPreview(res);
    } catch (e: any) {
      await showAlert(t("dialog.error"), String(e?.message ?? e));
    } finally {
      setLoading(false);
    }
  }

  async function applyReplace() {
    if (!folder || !preview) return;
    const total = preview.totalReplacements;
    const filesN = preview.files.length;
    const ok = await showConfirm(
      t("br.confirmTitle"),
      t("br.confirmBody", { total, files: filesN }),
      { tone: "danger", okLabel: t("br.applyBtn") }
    );
    if (!ok) return;
    setApplying(true);
    try {
      const opts: BatchReplaceOptions = {
        find, replace, field, caseSensitive, wholeWord, regex, dryRun: false,
      };
      const res = await window.dp2.batchReplaceWorker({ folder, opts });
      invalidateTm();
      // Якщо поточний файл був серед змінених — перезавантажити, щоб
      // UI побачив свіжий вміст.
      if (selectedFilePath && res.files.some((f) => f.path === selectedFilePath)) {
        await loadFile(selectedFilePath);
      }
      await showAlert(
        t("br.doneTitle"),
        t("br.doneBody", {
          total: res.totalReplacements,
          entries: res.totalEntries,
          files: res.files.length,
        }),
        { tone: "success" }
      );
      onClose();
    } catch (e: any) {
      await showAlert(t("dialog.error"), String(e?.message ?? e));
    } finally {
      setApplying(false);
    }
  }

  function toggleFile(p: string) {
    setExpandedFiles((prev) => {
      const next = new Set(prev);
      if (next.has(p)) next.delete(p); else next.add(p);
      return next;
    });
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/60 pt-[5vh]"
      onClick={onClose}
    >
      <div
        className="dp-card w-[920px] max-w-[96vw] max-h-[88vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-3 px-5 py-3 border-b border-[var(--border-soft)]">
          <div className="min-w-0 flex-1">
            <h2 className="text-[15px] font-semibold text-[var(--text-strong)]">{t("br.title")}</h2>
            <p className="text-[12px] text-[var(--text-muted)] mt-0.5 truncate">{t("br.subtitle")}</p>
          </div>
          <button onClick={onClose} className="dp-btn dp-btn--ghost !w-7 !p-0 shrink-0">
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Inputs */}
        <div className="px-5 py-3 border-b border-[var(--border-soft)] grid grid-cols-2 gap-3">
          <div>
            <label className="text-[10px] font-semibold uppercase tracking-wider text-[var(--text-muted)] block mb-1">
              {t("br.findLabel")}
            </label>
            <input
              className={`dp-input w-full ${regexError ? "border-[var(--danger)]" : ""}`}
              value={find}
              onChange={(e) => setFind(e.target.value)}
              placeholder={regex ? t("br.findPlaceholderRegex") : t("br.findPlaceholder")}
              autoFocus
            />
            {regexError && (
              <p className="text-[11px] text-[var(--danger)] mt-1">{regexError}</p>
            )}
          </div>
          <div>
            <label className="text-[10px] font-semibold uppercase tracking-wider text-[var(--text-muted)] block mb-1">
              {t("br.replaceLabel")}
            </label>
            <input
              className="dp-input w-full"
              value={replace}
              onChange={(e) => setReplace(e.target.value)}
              placeholder={t("br.replacePlaceholder")}
            />
          </div>
        </div>

        {/* Options */}
        <div className="px-5 py-2.5 border-b border-[var(--border-soft)] flex flex-wrap items-center gap-2">
          <span className="text-[10px] font-semibold uppercase tracking-wider text-[var(--text-muted)] mr-1">
            {t("br.fieldLabel")}:
          </span>
          {(["en", "charaName"] as Field[]).map((f) => (
            <button
              key={f}
              className={`dp-btn ${field === f ? "dp-btn--primary" : ""}`}
              onClick={() => setField(f)}
            >
              {t(`br.field.${f}`)}
            </button>
          ))}
          <span className="mx-2 text-[var(--text-faint)]">|</span>
          <button
            className={`dp-btn ${caseSensitive ? "dp-btn--primary" : ""}`}
            onClick={() => setCaseSensitive((v) => !v)}
            title={t("br.toggle.case")}
          >
            Aa
          </button>
          <button
            className={`dp-btn ${wholeWord ? "dp-btn--primary" : ""}`}
            onClick={() => setWholeWord((v) => !v)}
            title={t("br.toggle.wholeWord")}
            disabled={regex}
          >
            \b
          </button>
          <button
            className={`dp-btn ${regex ? "dp-btn--primary" : ""}`}
            onClick={() => setRegex((v) => !v)}
            title={t("br.toggle.regex")}
          >
            .*
          </button>
          <span className="flex-1" />
          <button
            className="dp-btn dp-btn--primary"
            onClick={runPreview}
            disabled={!folder || !find || loading || applying}
          >
            {loading ? t("br.scanning") : t("br.previewBtn")}
          </button>
        </div>

        {/* Preview list */}
        <div className="flex-1 overflow-y-auto">
          {!preview && !loading && (
            <div className="py-12 text-center text-[12px] text-[var(--text-muted)]">
              {t("br.preview.hint")}
            </div>
          )}

          {loading && (
            <div className="py-12 text-center text-[12px] text-[var(--text-muted)]">
              {t("br.scanning")}
            </div>
          )}

          {preview && preview.files.length === 0 && (
            <div className="py-12 text-center text-[12px] text-[var(--text-muted)]">
              {t("br.preview.none")}
            </div>
          )}

          {preview && preview.files.length > 0 && (
            <div className="py-1">
              {preview.files.map((f) => {
                const exp = expandedFiles.has(f.path);
                return (
                  <div key={f.path} className="border-b border-[var(--border-soft)]">
                    <button
                      onClick={() => toggleFile(f.path)}
                      className="w-full px-5 py-2 flex items-center gap-2 text-left hover:bg-[var(--row-hover)]"
                    >
                      <svg
                        className={`w-3 h-3 shrink-0 text-[var(--text-faint)] transition-transform ${exp ? "rotate-90" : ""}`}
                        fill="currentColor" viewBox="0 0 16 16"
                      >
                        <path d="M5 4l5 4-5 4V4z" />
                      </svg>
                      <span className="font-mono text-[12px] text-[var(--text)] truncate">{f.fileName}</span>
                      <span className="ml-auto text-[11px] tabular-nums text-[var(--text-faint)] shrink-0">
                        {t("br.fileSummary", { entries: f.entriesChanged, reps: f.replacements })}
                      </span>
                    </button>
                    {exp && (
                      <ul className="bg-[var(--bg)] border-t border-[var(--border-soft)]">
                        {f.hits.map((h, i) => (
                          <li
                            key={i}
                            className="px-5 py-2 pl-10 border-t border-[var(--border-soft)] text-[12px]"
                          >
                            <div className="flex items-center gap-2 text-[11px] mb-1">
                              <span className="dp-pill">{h.field}</span>
                              <span className="font-mono text-[var(--text-muted)] truncate" title={h.entryId}>
                                {h.entryId || `#${h.entryIndex + 1}`}
                              </span>
                            </div>
                            <p className="text-[var(--text-muted)] leading-snug whitespace-pre-wrap break-words line-clamp-2 mb-0.5">
                              <span className="text-[10px] uppercase mr-2 text-[var(--text-faint)]">−</span>
                              {h.before}
                            </p>
                            <p className="text-[var(--success)] leading-snug whitespace-pre-wrap break-words line-clamp-2">
                              <span className="text-[10px] uppercase mr-2 text-[var(--text-faint)]">+</span>
                              {h.after}
                            </p>
                          </li>
                        ))}
                        {f.hits.length < f.entriesChanged && (
                          <li className="px-5 py-2 pl-10 text-[11px] italic text-[var(--text-faint)]">
                            {t("br.more", { n: f.entriesChanged - f.hits.length })}
                          </li>
                        )}
                      </ul>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Footer */}
        {preview && preview.files.length > 0 && (
          <div className="px-5 py-3 border-t border-[var(--border-soft)] flex items-center gap-3">
            <span className="text-[12px] text-[var(--text-muted)]">
              {t("br.previewSummary", {
                total: preview.totalReplacements,
                entries: preview.totalEntries,
                files: preview.files.length,
              })}
            </span>
            <span className="flex-1" />
            <button
              className="dp-btn dp-btn--danger"
              onClick={applyReplace}
              disabled={applying}
            >
              {applying ? t("br.applying") : t("br.applyBtn")}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
