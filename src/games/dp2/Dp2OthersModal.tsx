// DP2 — «Переклад інших рядків».
// Модалка для фіксованого списку UILabel-компонентів зі sharedassets1.assets.
// Натискання «Витягти з гри» запускає PS-скрипт `dp2-others-extract.ps1`, що
// розпаковує JSON у Others/Original/, а потім головний процес копіює свіжі
// файли у Others/Done/ (якщо там ще нема — щоб не затирати уже зроблений
// переклад). Поле для редагування — `mText`. Пак-у-назад буде наступним
// кроком.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { DP2_OTHERS_PATH_IDS } from "./othersPathIds";
import { useStore } from "../../lib/store";

interface FileRow {
  pathId: number;
  name: string;
  originalSize: number | null;
  doneSize: number | null;
  doneMtime: number | null;
}

interface Props {
  open: boolean;
  onClose: () => void;
}

function fmtBytes(n: number | null): string {
  if (n == null) return "—";
  if (n <= 0) return "0";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function Dp2OthersModal({ open, onClose }: Props) {
  const [baseDir, setBaseDir] = useState<string | null>(null);
  const [sharedAssets1, setSharedAssets1] = useState<string | null>(null);
  const [sharedAssets1Exists, setSharedAssets1Exists] = useState(false);
  const [files, setFiles] = useState<FileRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [log, setLog] = useState<string[]>([]);
  const [lastResult, setLastResult] = useState<{ ok: boolean; staged?: number; failed?: number; copiedToDone?: number; message?: string } | null>(null);

  const pathIds = useMemo(() => Array.from(DP2_OTHERS_PATH_IDS), []);
  const logEndRef = useRef<HTMLDivElement | null>(null);
  const refreshOthers = useStore((s) => s.refreshOthers);

  const refresh = useCallback(async () => {
    try {
      const r = await window.dp2.dp2OthersStatus({ pathIds });
      if (r.ok) {
        setBaseDir(r.baseDir ?? null);
        setSharedAssets1(r.sharedAssets1 ?? null);
        setSharedAssets1Exists(!!r.sharedAssets1Exists);
        setFiles(r.files ?? []);
      }
    } catch { /* ignore */ }
  }, [pathIds]);

  useEffect(() => {
    if (!open) return;
    void refresh();
    setLog([]);
    setLastResult(null);
  }, [open, refresh]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape" && !busy) onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose, busy]);

  useEffect(() => {
    if (!open) return;
    const off = window.dp2.onDp2OthersProgress?.((line) => {
      setLog((prev) => {
        const next = prev.length > 400 ? prev.slice(prev.length - 400) : prev.slice();
        next.push(line);
        return next;
      });
    });
    return () => { off?.(); };
  }, [open]);

  useEffect(() => {
    if (logEndRef.current) logEndRef.current.scrollTop = logEndRef.current.scrollHeight;
  }, [log]);

  const originalCount = files.filter((f) => f.originalSize != null).length;
  const doneCount = files.filter((f) => f.doneSize != null).length;

  async function extract() {
    if (busy) return;
    setBusy(true);
    setLastResult(null);
    setLog([]);
    try {
      const r = await window.dp2.dp2OthersExtract({ pathIds });
      if (!r.ok) {
        setLastResult({ ok: false, message: r.error ?? "?" });
        return;
      }
      const exported = r.summary?.exported?.length ?? 0;
      const failed = r.summary?.failed?.length ?? 0;
      setLastResult({
        ok: true,
        staged: exported,
        failed,
        copiedToDone: r.copiedToDone ?? 0,
      });
      await refresh();
      await refreshOthers();
    } finally {
      setBusy(false);
    }
  }

  async function clearAll() {
    if (busy) return;
    if (!confirm("Видалити всі файли з Others/Original та Others/Done?")) return;
    setBusy(true);
    try {
      await window.dp2.dp2OthersClear();
      setLastResult({ ok: true, message: "Теку очищено" });
      await refresh();
      await refreshOthers();
    } finally {
      setBusy(false);
    }
  }

  function openInExplorer() {
    if (!baseDir) return;
    void window.dp2.openFolder(baseDir);
  }

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-6" onClick={busy ? undefined : onClose}>
      <div
        className="w-full max-w-[860px] max-h-[92vh] bg-[var(--bg-surface)] border border-[var(--border-soft)] rounded-lg shadow-2xl overflow-hidden flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-5 py-3 border-b border-[var(--border-soft)] flex items-start gap-3">
          <span className="text-[18px]" aria-hidden>📥</span>
          <div className="flex-1 min-w-0">
            <h2 className="text-[14px] font-semibold text-[var(--text-strong)]">Переклад інших рядків</h2>
            <p className="text-[11px] text-[var(--text-faint)] mt-0.5">
              {pathIds.length} UILabel-компонентів з{" "}
              <span className="font-mono">sharedassets1.assets</span>. Поле для перекладу — <span className="font-mono">mText</span>.
            </p>
            {baseDir && (
              <p className="text-[10.5px] text-[var(--text-faint)] mt-1 font-mono truncate" title={baseDir}>{baseDir}</p>
            )}
            {sharedAssets1 && (
              <p className="text-[10.5px] mt-0.5 font-mono truncate" title={sharedAssets1}>
                <span className={sharedAssets1Exists ? "text-[var(--success)]" : "text-[var(--danger)]"}>
                  {sharedAssets1Exists ? "✓" : "✗"}
                </span>{" "}
                <span className="text-[var(--text-faint)]">{sharedAssets1}</span>
              </p>
            )}
          </div>
          <button className="dp-btn dp-btn--ghost" onClick={onClose} disabled={busy}>✕</button>
        </div>

        <div className="px-5 py-3 border-b border-[var(--border-soft)] flex items-center gap-2 flex-wrap text-[11px]">
          <button
            className="dp-btn dp-btn--primary"
            disabled={busy || !sharedAssets1Exists}
            onClick={extract}
            title={!sharedAssets1Exists ? "Не знайдено sharedassets1.assets" : "Витягти UILabel-и зі sharedassets1.assets"}
          >
            {busy ? "Витягую…" : "🔽 Витягти з гри"}
          </button>
          <button className="dp-btn dp-btn--ghost" disabled={busy || (originalCount === 0 && doneCount === 0)} onClick={clearAll}>
            🗑 Очистити Others/
          </button>
          <button className="dp-btn dp-btn--ghost" disabled={!baseDir} onClick={openInExplorer}>
            📂 Відкрити у Провіднику
          </button>
          <button className="dp-btn dp-btn--ghost ml-auto" disabled={busy} onClick={() => void refresh()}>
            ⟳ Оновити
          </button>
        </div>

        <div className="px-5 py-2 border-b border-[var(--border-soft)] flex items-center gap-4 text-[11px]">
          <span>
            Original: <span className="font-semibold text-[var(--text)]">{originalCount}</span>/<span className="text-[var(--text-faint)]">{pathIds.length}</span>
          </span>
          <span>
            Done: <span className="font-semibold text-[var(--text)]">{doneCount}</span>/<span className="text-[var(--text-faint)]">{pathIds.length}</span>
          </span>
        </div>

        {lastResult && (
          <div className={`px-5 py-2 border-b border-[var(--border-soft)] text-[11.5px] ${lastResult.ok ? "bg-[var(--success)]/10 text-[var(--success)]" : "bg-[var(--danger)]/10 text-[var(--danger)]"}`}>
            {lastResult.ok
              ? lastResult.message
                ? lastResult.message
                : `Витягнуто +${lastResult.staged ?? 0} файлів${lastResult.failed ? `, помилок ${lastResult.failed}` : ""}${(lastResult.copiedToDone ?? 0) > 0 ? `, скопійовано у Done +${lastResult.copiedToDone}` : ""}.`
              : `Помилка: ${lastResult.message ?? "?"}`}
          </div>
        )}

        <div className="flex-1 overflow-y-auto">
          {files.length === 0 ? (
            <div className="px-5 py-10 text-center text-[12px] text-[var(--text-muted)]">
              <p className="mb-2">Список ще не побудовано.</p>
            </div>
          ) : (
            <table className="w-full text-[11.5px]">
              <thead className="sticky top-0 bg-[var(--bg-surface)] border-b border-[var(--border-soft)] text-[10px] uppercase tracking-wider text-[var(--text-faint)]">
                <tr>
                  <th className="text-left px-5 py-2 w-[80px]">PathID</th>
                  <th className="text-left px-5 py-2">Файл</th>
                  <th className="text-right px-5 py-2 w-[90px]">Original</th>
                  <th className="text-right px-5 py-2 w-[90px]">Done</th>
                </tr>
              </thead>
              <tbody>
                {files.map((f) => {
                  const hasOrig = f.originalSize != null;
                  const hasDone = f.doneSize != null;
                  return (
                    <tr key={f.pathId} className="border-b border-[var(--border-soft)] hover:bg-[var(--row-hover)]">
                      <td className="px-5 py-1.5 font-mono text-[var(--text-faint)] tabular-nums">{f.pathId}</td>
                      <td className="px-5 py-1.5 font-mono text-[var(--text)] truncate">{f.name}</td>
                      <td className={`px-5 py-1.5 text-right tabular-nums ${hasOrig ? "text-[var(--text-faint)]" : "text-[var(--danger)]"}`}>
                        {hasOrig ? fmtBytes(f.originalSize) : "—"}
                      </td>
                      <td className={`px-5 py-1.5 text-right tabular-nums ${hasDone ? "text-[var(--success)]" : "text-[var(--text-faint)]"}`}>
                        {hasDone ? fmtBytes(f.doneSize) : "—"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>

        {log.length > 0 && (
          <div
            ref={logEndRef}
            className="border-t border-[var(--border-soft)] bg-black/30 text-[10.5px] font-mono text-[var(--text-faint)] px-3 py-2 overflow-auto max-h-[140px]"
          >
            {log.map((ln, i) => (
              <div key={i} className={ln.startsWith("[FAIL") || ln.startsWith("[err]") ? "text-[var(--danger)]" : ln.startsWith("[EXPORTED]") ? "text-[var(--success)]" : ""}>{ln}</div>
            ))}
          </div>
        )}

        <div className="px-5 py-2.5 border-t border-[var(--border-soft)] flex items-center text-[10.5px] text-[var(--text-faint)]">
          <span>Очікується: <span className="text-[var(--text)] font-semibold">{pathIds.length}</span> UILabel</span>
          <span className="ml-auto"><button className="dp-btn" onClick={onClose} disabled={busy}>Закрити</button></span>
        </div>
      </div>
    </div>
  );
}
