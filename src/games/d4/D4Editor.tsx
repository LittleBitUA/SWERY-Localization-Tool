// D4 (Dark Dreams Don't Die) — текстовий редактор.
// Flow:
//   1. Empty state: вибрати теку гри (d4Root) у Settings.
//   2. Не витягнуто → кнопка «Витягти тексти» → IPC d4-text-extract.
//   3. Витягнуто → список файлів з прогресом + кнопка редагування + Pack.
//   4. Edit one file → inline-редактор m_aString/m_aWord/m_aVoiceIdStr.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useT, localizeBackendError } from "../../lib/i18n";
import { alert as dpAlert } from "../../lib/dialogs";
import { D4CorpusStatsModal, D4GlobalSearchModal, D4BatchReplaceModal, D4GlossaryModal } from "./D4Modals";
import { D4Hero } from "./D4Hero";
import { D4ProgressModal, type D4FileProgress } from "./D4ProgressModal";
import { D4TextItemEditor } from "./D4TextItemEditor";

interface Props { onHome: () => void; }

interface StatusInfo {
  ok: boolean;
  d4Root: string | null;
  cooked: string | null;
  cookedError: string | null;
  sourceFiles: Array<{ name: string; fullPath: string; isUtility: boolean }>;
  originalDir: string;
  doneDir: string;
  toolsDir: string;
  originalCount: number;
  doneCount: number;
  tools: { decompressExe: string | null; uelibDll: string | null; ready: boolean };
}

interface FileItem {
  name: string;
  origPath: string;
  donePath: string;
  origSize: number;
  doneSize: number;
  doneMtime: number;
  entries: number;
  strings: number;
  translated: number;
}

function shortPath(p: string | null | undefined, segments = 3): string {
  if (!p) return "—";
  return p.split(/[\\/]/).slice(-segments).join("/");
}

function fmtBytes(n: number): string {
  if (!n) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function D4Editor({ onHome }: Props) {
  const t = useT();
  const [status, setStatus] = useState<StatusInfo | null>(null);
  const [files, setFiles] = useState<FileItem[]>([]);
  const [activeFile, setActiveFile] = useState<FileItem | null>(null);
  // Окремі модалки (Stats / Global Search / Batch / Glossary).
  const [statsOpen, setStatsOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [batchOpen, setBatchOpen] = useState(false);
  const [glossaryOpen, setGlossaryOpen] = useState(false);
  // Progress modal state.
  const [busy, setBusy] = useState<"idle" | "extracting" | "packing">("idle");
  const [logLines, setLogLines] = useState<string[]>([]);
  const [fileProgress, setFileProgress] = useState<D4FileProgress[]>([]);
  const [opCurrent, setOpCurrent] = useState(0);
  const [opTotal, setOpTotal] = useState(0);
  const [opDone, setOpDone] = useState(false);
  const [opError, setOpError] = useState<string | null>(null);
  const progressRef = useRef<{ unsubExtract?: () => void; unsubPack?: () => void }>({});

  const reloadStatus = useCallback(async () => {
    const s = await window.dp2.d4TextStatus();
    setStatus(s as StatusInfo);
    const l = await window.dp2.d4TextList();
    if (l.ok) setFiles(l.items);
  }, []);

  useEffect(() => { reloadStatus(); }, [reloadStatus]);

  // Глобальні шорткати у D4Editor (поверх головного списку). Capture-фаза +
  // e.code (KeyF/KeyH/KeyI/KeyG) — стабільно на укр/рос розкладках.
  //   Ctrl+F, Ctrl+Shift+F — Global Search
  //   Ctrl+H, Ctrl+Shift+H — Batch Replace
  //   Ctrl+I — Stats
  //   Ctrl+G — Glossary
  useEffect(() => {
    if (activeFile) return;
    const onKey = (e: KeyboardEvent) => {
      const ctrl = e.ctrlKey || e.metaKey;
      if (!ctrl) return;
      if (e.code === "KeyF") { e.preventDefault(); e.stopPropagation(); setSearchOpen(true); }
      else if (e.code === "KeyH") { e.preventDefault(); e.stopPropagation(); setBatchOpen(true); }
      else if (e.code === "KeyI" && !e.shiftKey) { e.preventDefault(); e.stopPropagation(); setStatsOpen(true); }
      else if (e.code === "KeyG" && !e.shiftKey) { e.preventDefault(); e.stopPropagation(); setGlossaryOpen(true); }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [activeFile]);

  // Сумарна статистика по всіх файлах (для top-метрик).
  const aggregate = useMemo(() => {
    const totalFiles = files.length;
    const totalEntries = files.reduce((a, f) => a + f.entries, 0);
    const totalStrings = files.reduce((a, f) => a + f.strings, 0);
    const totalTranslated = files.reduce((a, f) => a + f.translated, 0);
    const pct = totalStrings > 0 ? Math.round((totalTranslated / totalStrings) * 100) : 0;
    return { totalFiles, totalEntries, totalStrings, totalTranslated, pct };
  }, [files]);

  // ── Extract flow ──────────────────────────────────────────────
  const runExtract = useCallback(async () => {
    if (!status) return;
    const all = status.sourceFiles.map((f) => ({ name: f.name, status: "pending" as const }));
    setBusy("extracting");
    setLogLines([]);
    setFileProgress(all);
    setOpCurrent(0);
    setOpTotal(all.length);
    setOpDone(false);
    setOpError(null);
    // Підпис на progress: парсимо [STEP] лінії, оновлюємо файлову плитку.
    const unsub = window.dp2.onD4TextProgress((line: string) => {
      setLogLines((prev) => [...prev, line]);
      // Маркуємо current файл.
      const stepMatch = line.match(/^\[STEP\]\s+(\S+\.upk)/);
      if (stepMatch) {
        const name = stepMatch[1];
        setFileProgress((prev) => {
          const idx = prev.findIndex((p) => p.name === name);
          if (idx < 0) return prev;
          const next = [...prev];
          // Помічаємо попередні як done (якщо ще не error).
          for (let i = 0; i < idx; i++) {
            if (next[i].status === "running" || next[i].status === "pending") {
              next[i] = { ...next[i], status: "done" };
            }
          }
          next[idx] = { ...next[idx], status: "running" };
          return next;
        });
        setOpCurrent((c) => Math.max(c, all.findIndex((f) => f.name === name)));
      }
      const errMatch = line.match(/^\[ERR\]\s+\S+\s+(\S+\.upk):/);
      if (errMatch) {
        const name = errMatch[1];
        setFileProgress((prev) => prev.map((p) => p.name === name ? { ...p, status: "error" } : p));
      }
    });
    progressRef.current.unsubExtract = unsub;
    try {
      const r = await window.dp2.d4TextExtract();
      // Final state: позначаємо успішні done, провалені error.
      setFileProgress((prev) => prev.map((p) => {
        const res = r.results?.find((x) => x.name === p.name);
        if (!res) return p;
        return { ...p, status: res.ok ? "done" : "error" };
      }));
      setOpCurrent(all.length);
      setOpDone(true);
      if (!r.ok) {
        const failed = r.results?.filter((x) => !x.ok).map((x) => `${x.name}: ${localizeBackendError(x.error)}`).join("\n") ?? t("d4.unknownError");
        setOpError(failed);
      }
      await reloadStatus();
    } catch (e) {
      setOpError(String(e instanceof Error ? e.message : e));
      setOpDone(true);
    } finally {
      unsub();
      progressRef.current.unsubExtract = undefined;
    }
  }, [status, reloadStatus]);

  // ── Pack flow ─────────────────────────────────────────────────
  const runPack = useCallback(async () => {
    if (!status) return;
    const all = files.map((f) => ({
      name: f.name.replace(/\.json$/i, ".upk"),
      status: "pending" as const,
    }));
    setBusy("packing");
    setLogLines([]);
    setFileProgress(all);
    setOpCurrent(0);
    setOpTotal(all.length);
    setOpDone(false);
    setOpError(null);
    const unsub = window.dp2.onD4TextPackProgress((line: string) => {
      setLogLines((prev) => [...prev, line]);
      const stepMatch = line.match(/^\[STEP\]\s+pack\s+(\S+\.upk)/);
      if (stepMatch) {
        const name = stepMatch[1];
        setFileProgress((prev) => {
          const idx = prev.findIndex((p) => p.name === name);
          if (idx < 0) return prev;
          const next = [...prev];
          for (let i = 0; i < idx; i++) {
            if (next[i].status === "running" || next[i].status === "pending") {
              next[i] = { ...next[i], status: "done" };
            }
          }
          next[idx] = { ...next[idx], status: "running" };
          return next;
        });
        setOpCurrent((c) => Math.max(c, all.findIndex((f) => f.name === name)));
      }
    });
    progressRef.current.unsubPack = unsub;
    try {
      const r = await window.dp2.d4TextPack();
      setFileProgress((prev) => prev.map((p) => {
        const res = r.results?.find((x) => x.name === p.name);
        if (!res) return p;
        return { ...p, status: res.ok ? "done" : "error" };
      }));
      setOpCurrent(all.length);
      setOpDone(true);
      if (!r.ok) {
        const failed = r.results?.filter((x) => !x.ok).map((x) => `${x.name}: ${localizeBackendError(x.error)}`).join("\n") ?? (localizeBackendError(r.error) || t("d4.unknownError"));
        setOpError(failed);
      }
    } catch (e) {
      setOpError(String(e instanceof Error ? e.message : e));
      setOpDone(true);
    } finally {
      unsub();
      progressRef.current.unsubPack = undefined;
    }
  }, [status, files]);

  // ── Render: file editor (modal-like inline). ──────────────────
  if (activeFile) {
    return (
      <D4TextItemEditor
        file={activeFile}
        onClose={() => { setActiveFile(null); reloadStatus(); }}
      />
    );
  }

  // ── Render: empty d4Root state. ───────────────────────────────
  const isReady = !!status?.d4Root && !!status.cooked && status.tools.ready;
  const hasExtracted = status && status.originalCount > 0;

  return (
    <div
      className="flex-1 flex flex-col min-h-0 relative overflow-hidden"
      style={{ background: "#0d0204" }}
    >
      <D4Hero />

      <header
        className="h-12 px-4 flex items-center gap-3 shrink-0 relative"
        style={{
          background: "rgba(13, 2, 4, 0.75)",
          backdropFilter: "blur(8px)",
          borderBottom: "1px solid rgba(220, 38, 38, 0.25)",
          zIndex: 2,
        }}
      >
        <button
          className="dp-btn dp-btn--ghost"
          onClick={onHome}
          title={t("btn.home")}
          style={{ color: "#f5e6e6" }}
        >
          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M10 19l-7-7m0 0l7-7m-7 7h18" />
          </svg>
        </button>
        <span className="text-[10px] tracking-[0.3em] uppercase font-semibold" style={{ color: "#dc2626" }}>
          {t("d4.case")}
        </span>
        <span className="text-[13px]" style={{ color: "rgba(245,230,230,0.75)" }}>
          {t("d4.text.title", { brand: t("d4.brand"), mode: t("d4.mode.text") })}
        </span>
        <div className="flex-1" />
        <D4ToolbarBtn onClick={() => setStatsOpen(true)} title={`${t("d4.stats.title")} (${t("d4.shortcut.stats")})`}>
          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M3 13.125C3 12.504 3.504 12 4.125 12h2.25c.621 0 1.125.504 1.125 1.125v6.75C7.5 20.496 6.996 21 6.375 21h-2.25A1.125 1.125 0 0 1 3 19.875v-6.75ZM9.75 8.625c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125v11.25c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 0 1-1.125-1.125V8.625ZM16.5 4.125c0-.621.504-1.125 1.125-1.125h2.25C20.496 3 21 3.504 21 4.125v15.75c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 0 1-1.125-1.125V4.125Z" /></svg>
        </D4ToolbarBtn>
        <D4ToolbarBtn onClick={() => setSearchOpen(true)} title={`${t("d4.search.title")} (${t("d4.shortcut.globalSearch")})`}>
          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="m21 21-5.197-5.197m0 0A7.5 7.5 0 1 0 5.196 5.196a7.5 7.5 0 0 0 10.607 10.607Z" /></svg>
        </D4ToolbarBtn>
        <D4ToolbarBtn onClick={() => setBatchOpen(true)} title={`${t("d4.batch.title")} (${t("d4.shortcut.batchReplace")})`}>
          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M16 3h5v5M4 20 21 3M21 16v5h-5M15 15l6 6M4 4l5 5" /></svg>
        </D4ToolbarBtn>
        <D4ToolbarBtn onClick={() => setGlossaryOpen(true)} title={`${t("d4.gloss.title")} (${t("d4.shortcut.glossary")})`}>
          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M12 6.042A8.967 8.967 0 0 0 6 3.75c-1.052 0-2.062.18-3 .512v14.25A8.987 8.987 0 0 1 6 18c2.305 0 4.408.867 6 2.292m0-14.25a8.966 8.966 0 0 1 6-2.292c1.052 0 2.062.18 3 .512v14.25A8.987 8.987 0 0 0 18 18a8.967 8.967 0 0 0-6 2.292m0-14.25v14.25" /></svg>
        </D4ToolbarBtn>
      </header>

      <div className="flex-1 overflow-y-auto relative" style={{ zIndex: 1 }}>
        <div className="max-w-[1100px] mx-auto px-8 py-10 space-y-6">
          {/* Hero title block */}
          <section className="text-center mb-2">
            <div
              className="text-[10px] font-bold tracking-[0.4em] mb-3"
              style={{ color: "#dc2626" }}
            >
              {t("d4.brandFull")}
            </div>
            <h1
              className="text-[32px] font-light tracking-wider mb-1"
              style={{ color: "#fff", textShadow: "0 0 30px rgba(220,38,38,0.5)" }}
            >
              {t("d4.heroTitle")}
            </h1>
            <p className="text-[12px] tracking-[0.2em] uppercase" style={{ color: "rgba(245,230,230,0.5)" }}>
              {t("d4.heroSub")}
            </p>
          </section>

          {/* Status grid */}
          <section className="grid grid-cols-1 md:grid-cols-4 gap-4">
            <StatusCard
              label={t("d4.status.gameDir")}
              value={status?.d4Root ? shortPath(status.d4Root, 2) : t("d4.status.gameDir.notSet")}
              ok={!!status?.d4Root}
              hint={status?.cookedError ? t("d4.status.gameDir.cookedMissing") : status?.cooked ? t("d4.status.gameDir.cookedOk") : "—"}
            />
            <StatusCard
              label={t("d4.status.extracted")}
              value={`${status?.originalCount ?? 0} / ${status?.sourceFiles?.length ?? 0}`}
              ok={(status?.originalCount ?? 0) > 0}
              hint={status?.sourceFiles?.length ? t("d4.status.upkInGame", { n: status.sourceFiles.length }) : "—"}
            />
            <StatusCard
              label={t("d4.status.translated")}
              value={`${aggregate.totalTranslated.toLocaleString("uk-UA")} / ${aggregate.totalStrings.toLocaleString("uk-UA")}`}
              ok={aggregate.pct > 0}
              hint={t("d4.status.translatedHint", { pct: aggregate.pct, entries: aggregate.totalEntries })}
            />
            <StatusCard
              label={t("d4.status.tools")}
              value={status?.tools.ready ? t("d4.status.tools.ready") : t("d4.status.tools.missing")}
              ok={!!status?.tools.ready}
              hint={status?.tools.uelibDll ? t("d4.status.tools.hint.ok") : t("d4.status.tools.hint.uelib")}
            />
          </section>

          {/* Action ribbon — велика D4-themed смуга з кнопками. */}
          <section
            className="rounded-sm p-5"
            style={{
              background: "rgba(13, 2, 4, 0.6)",
              backdropFilter: "blur(8px)",
              border: "1px solid rgba(220, 38, 38, 0.35)",
              boxShadow: "0 4px 30px rgba(0,0,0,0.5)",
            }}
          >
            <div className="flex items-center justify-between gap-4 flex-wrap">
              <div>
                <div className="text-[10px] tracking-[0.3em] uppercase font-semibold mb-1" style={{ color: "#dc2626" }}>
                  {t("d4.text.actions.label")}
                </div>
                <h3 className="text-[16px] font-semibold" style={{ color: "#fff" }}>
                  {!status?.d4Root ? t("d4.text.actions.step.pickDir")
                    : !status.cooked ? t("d4.text.actions.step.noCooked")
                    : !status.tools.ready ? t("d4.text.actions.step.noTools")
                    : !hasExtracted ? t("d4.text.actions.step.readyExtract")
                    : t("d4.text.actions.step.readyEdit")}
                </h3>
                <p className="text-[11.5px] mt-1" style={{ color: "rgba(245,230,230,0.55)" }}>
                  {!status?.d4Root ? t("d4.text.actions.hint.pickDir")
                    : !status.tools.ready ? t("d4.text.actions.hint.noTools", { dir: status.toolsDir })
                    : !hasExtracted ? t("d4.text.actions.hint.readyExtract")
                    : t("d4.text.actions.hint.readyEdit")}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <D4Button
                  onClick={runExtract}
                  disabled={!isReady || busy !== "idle"}
                  variant="primary"
                  title={!isReady ? t("d4.text.btn.extractTitleDisabled") : t("d4.text.btn.extractTitle")}
                >
                  {hasExtracted ? t("d4.text.btn.reextract") : t("d4.text.btn.extract")}
                </D4Button>
                <D4Button
                  onClick={runPack}
                  disabled={!hasExtracted || busy !== "idle"}
                  variant="danger"
                  title={!hasExtracted ? t("d4.text.btn.packTitleDisabled") : t("d4.text.btn.packTitle")}
                >
                  {t("d4.text.btn.pack")}
                </D4Button>
              </div>
            </div>
          </section>

          {/* Files list */}
          {files.length > 0 && (
            <section
              className="rounded-sm overflow-hidden"
              style={{
                background: "rgba(13, 2, 4, 0.6)",
                backdropFilter: "blur(8px)",
                border: "1px solid rgba(220, 38, 38, 0.25)",
              }}
            >
              <header
                className="px-5 py-3 flex items-center justify-between"
                style={{
                  borderBottom: "1px solid rgba(220, 38, 38, 0.2)",
                  background: "linear-gradient(90deg, rgba(220,38,38,0.08) 0%, transparent 100%)",
                }}
              >
                <h3
                  className="text-[11px] font-semibold tracking-[0.3em] uppercase"
                  style={{ color: "#dc2626" }}
                >
                  {t("d4.files.header", { n: files.length })}
                </h3>
                <span className="text-[11px] font-mono" style={{ color: "rgba(245,230,230,0.55)" }}>
                  {t("d4.files.doneSize", { size: fmtBytes(files.reduce((a, f) => a + f.doneSize, 0)) })}
                </span>
              </header>
              <div>
                {files.map((f) => {
                  const pct = f.strings > 0 ? Math.round((f.translated / f.strings) * 100) : 0;
                  return (
                    <div
                      key={f.name}
                      className="w-full px-5 py-3 flex items-center gap-4 transition-colors group"
                      style={{
                        borderBottom: "1px solid rgba(220, 38, 38, 0.1)",
                        background: "transparent",
                      }}
                      onMouseEnter={(e) => { e.currentTarget.style.background = "rgba(220, 38, 38, 0.08)"; }}
                      onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
                    >
                      <button
                        onClick={() => setActiveFile(f)}
                        className="flex items-center gap-4 flex-1 min-w-0 text-left cursor-pointer"
                        title={t("d4.files.openEditor")}
                      >
                        <span
                          className="font-mono text-[12.5px] font-semibold w-[260px] truncate"
                          style={{ color: pct > 0 ? "#fff" : "rgba(245,230,230,0.75)" }}
                        >
                          {f.name.replace(/\.json$/, "")}
                        </span>
                        <span className="text-[11px] font-mono tabular-nums" style={{ color: "rgba(245,230,230,0.55)" }}>
                          {t("d4.files.msgsStr", { msgs: f.entries, str: f.strings })}
                        </span>
                        <div className="flex-1" />
                        <div className="w-[180px] flex items-center gap-2">
                          <div
                            className="flex-1 h-1.5 rounded-sm overflow-hidden"
                            style={{ background: "rgba(245,230,230,0.08)" }}
                          >
                            <div
                              className="h-full"
                              style={{
                                width: `${pct}%`,
                                background: pct === 100
                                  ? "linear-gradient(90deg, #15803d 0%, #22c55e 100%)"
                                  : "linear-gradient(90deg, #991b1b 0%, #dc2626 100%)",
                                boxShadow: pct > 0 ? "0 0 8px rgba(220,38,38,0.4)" : "none",
                              }}
                            />
                          </div>
                          <span className="text-[11px] font-mono tabular-nums w-[36px] text-right" style={{ color: pct > 0 ? "#22c55e" : "rgba(245,230,230,0.4)" }}>
                            {pct}%
                          </span>
                        </div>
                      </button>
                      <div className="flex items-center gap-1.5 ml-3 opacity-70 group-hover:opacity-100 transition-opacity">
                        <D4TxtIconBtn
                          title={t("d4.txt.exportTitle")}
                          variant="export"
                          onClick={async () => {
                            const baseName = f.name.replace(/\.json$/, "");
                            const defaultPath = f.donePath.replace(/\.json$/i, ".txt");
                            const picked = await window.dp2.pickSaveFile({
                              title: t("d4.txt.exportPick", { name: baseName }),
                              defaultPath,
                              filters: [{ name: "Text", extensions: ["txt"] }],
                            });
                            if (!picked) return;
                            const r = await window.dp2.d4TextExportTxt({ donePath: f.donePath, outPath: picked });
                            if (r.ok) {
                              await dpAlert(
                                t("d4.txt.exportSavedTitle"),
                                t("d4.txt.exportSaved", { path: r.txtPath ?? "?", bytes: (r.bytes ?? 0).toLocaleString("uk-UA") }),
                                { tone: "success" }
                              );
                            } else {
                              await dpAlert(t("d4.txt.exportFailTitle"), localizeBackendError(r.error) || "?", { tone: "danger" });
                            }
                          }}
                        >
                          {t("d4.txt.btn.export")}
                        </D4TxtIconBtn>
                        <D4TxtIconBtn
                          title={t("d4.txt.importTitle")}
                          variant="import"
                          onClick={async () => {
                            const picked = await window.dp2.pickFile({
                              title: t("d4.txt.importPick", { name: f.name.replace(/\.json$/, "") }),
                              filters: [{ name: "Text", extensions: ["txt"] }],
                            });
                            if (!picked) return;
                            const r = await window.dp2.d4TextImportTxt({ donePath: f.donePath, txtPath: picked });
                            if (r.ok) {
                              await dpAlert(
                                t("d4.txt.importDoneTitle"),
                                t("d4.txt.importReport", { applied: r.applied ?? 0, skipped: r.skipped ?? 0, missing: r.missing ?? 0, blocks: r.blocks ?? 0 }),
                                { tone: "success" }
                              );
                              await reloadStatus();
                            } else {
                              await dpAlert(t("d4.txt.importFailTitle"), localizeBackendError(r.error) || "?", { tone: "danger" });
                            }
                          }}
                        >
                          {t("d4.txt.btn.import")}
                        </D4TxtIconBtn>
                      </div>
                    </div>
                  );
                })}
              </div>
            </section>
          )}

          {files.length === 0 && status?.d4Root && (
            <section
              className="rounded-sm p-8 text-center"
              style={{
                background: "rgba(13, 2, 4, 0.5)",
                border: "1px dashed rgba(220, 38, 38, 0.3)",
              }}
            >
              <p className="text-[12px]" style={{ color: "rgba(245,230,230,0.55)" }}>
                {t("d4.files.empty.intro")} <strong style={{ color: "#dc2626" }}>{t("d4.files.empty.cta")}</strong> {t("d4.files.empty.outro")}
              </p>
            </section>
          )}
        </div>
      </div>

      <D4CorpusStatsModal open={statsOpen} onClose={() => setStatsOpen(false)} />
      <D4GlobalSearchModal open={searchOpen} onClose={() => setSearchOpen(false)} onJump={(fileBase, msgIdx) => {
        const f = files.find((x) => x.name.replace(/\.json$/, "") === fileBase);
        if (f) { setSearchOpen(false); setActiveFile(f); /* TODO: pass msgIdx далі */ void msgIdx; }
      }} />
      <D4BatchReplaceModal open={batchOpen} onClose={() => setBatchOpen(false)} onApplied={reloadStatus} />
      <D4GlossaryModal open={glossaryOpen} onClose={() => setGlossaryOpen(false)} />
      <D4ProgressModal
        open={busy !== "idle"}
        title={busy === "extracting" ? t("d4.progress.text.title") : t("d4.progress.pack.title")}
        subtitle={busy === "extracting"
          ? t("d4.progress.text.subtitle")
          : t("d4.progress.pack.subtitle")}
        lines={logLines}
        files={fileProgress}
        current={opCurrent}
        total={opTotal}
        done={opDone}
        error={opError}
        onClose={() => {
          setBusy("idle");
          progressRef.current.unsubExtract?.();
          progressRef.current.unsubPack?.();
        }}
      />
    </div>
  );
}

// ── Дрібні UI-компоненти ─────────────────────────────────────────

function StatusCard({
  label, value, hint, ok,
}: { label: string; value: string; hint?: string; ok?: boolean }) {
  return (
    <div
      className="rounded-sm p-4"
      style={{
        background: "rgba(13, 2, 4, 0.6)",
        backdropFilter: "blur(8px)",
        border: `1px solid ${ok ? "rgba(34, 197, 94, 0.35)" : "rgba(220, 38, 38, 0.25)"}`,
        boxShadow: "0 4px 20px rgba(0,0,0,0.4)",
      }}
    >
      <div
        className="text-[9px] font-bold tracking-[0.3em] uppercase mb-2"
        style={{ color: ok ? "#22c55e" : "#dc2626" }}
      >
        {label}
      </div>
      <div
        className="text-[17px] font-semibold tabular-nums truncate"
        style={{ color: "#fff" }}
        title={value}
      >
        {value}
      </div>
      {hint && (
        <div
          className="text-[10.5px] mt-1.5 truncate"
          style={{ color: "rgba(245,230,230,0.5)" }}
          title={hint}
        >
          {hint}
        </div>
      )}
    </div>
  );
}

function D4ToolbarBtn({
  onClick, title, children,
}: { onClick: () => void; title: string; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      title={title}
      className="w-7 h-7 flex items-center justify-center rounded-sm transition-colors"
      style={{
        background: "rgba(220, 38, 38, 0.1)",
        border: "1px solid rgba(220, 38, 38, 0.25)",
        color: "#f5e6e6",
      }}
      onMouseEnter={(e) => { e.currentTarget.style.background = "rgba(220, 38, 38, 0.25)"; }}
      onMouseLeave={(e) => { e.currentTarget.style.background = "rgba(220, 38, 38, 0.1)"; }}
    >
      {children}
    </button>
  );
}

function D4TxtIconBtn({
  onClick, title, children, variant = "export",
}: { onClick: () => void; title?: string; children: React.ReactNode; variant?: "export" | "import" }) {
  // Heroicons arrow-down-tray (експорт = «зберегти у тацю» / .txt файл)
  // і arrow-up-tray (імпорт = «дістати з таці» / .txt → JSON).
  const icon = variant === "export" ? (
    <svg className="w-3.5 h-3.5 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75V16.5M16.5 12 12 16.5m0 0L7.5 12m4.5 4.5V3" />
    </svg>
  ) : (
    <svg className="w-3.5 h-3.5 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75V16.5m-13.5-9L12 3m0 0 4.5 4.5M12 3v13.5" />
    </svg>
  );
  return (
    <button
      onClick={onClick}
      title={title}
      className="px-2 py-1 text-[10.5px] font-semibold rounded-sm transition-colors flex items-center gap-1.5"
      style={{
        background: "rgba(220, 38, 38, 0.12)",
        border: "1px solid rgba(220, 38, 38, 0.3)",
        color: "#fca5a5",
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.background = "rgba(220, 38, 38, 0.25)";
        e.currentTarget.style.color = "#fff";
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = "rgba(220, 38, 38, 0.12)";
        e.currentTarget.style.color = "#fca5a5";
      }}
    >
      {icon}
      <span>{children}</span>
    </button>
  );
}

function D4Button({
  onClick, disabled, variant, children, title,
}: {
  onClick: () => void;
  disabled?: boolean;
  variant: "primary" | "danger";
  children: React.ReactNode;
  title?: string;
}) {
  const base = variant === "primary"
    ? { bg: "linear-gradient(135deg, #dc2626 0%, #991b1b 100%)", border: "#ef4444" }
    : { bg: "linear-gradient(135deg, #7f1d1d 0%, #450a0a 100%)", border: "#dc2626" };
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      className="px-5 py-2 text-[11.5px] font-semibold tracking-wider uppercase transition-all rounded-sm"
      style={{
        background: disabled ? "rgba(245,230,230,0.05)" : base.bg,
        border: `1px solid ${disabled ? "rgba(245,230,230,0.15)" : base.border}`,
        color: disabled ? "rgba(245,230,230,0.3)" : "#fff",
        boxShadow: disabled ? "none" : "0 4px 15px rgba(220,38,38,0.4)",
        cursor: disabled ? "not-allowed" : "pointer",
      }}
    >
      {children}
    </button>
  );
}
