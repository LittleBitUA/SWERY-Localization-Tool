// THE MISSING — fonts editor (HBR-style polished UI).
//
// Робочий процес:
//   1. Extract → AssetsTools.NET читає сирі байти Font-asset'ів, magic-scan
//      витягає TTF/OTF blob у Original/.
//   2. Користувач натискає «Замінити» біля кожного → файл-picker → копіюємо
//      .ttf/.otf у Replacement/.
//   3. Pack → PS-script знаходить m_FontData у raw-asset bytes, splice'ить
//      новий шрифт із правильним alignment(4), info.SetNewData, write assets.
//
// UI: header з лічильником + кнопками; таблиця з прогрес-баром та кольоровою
// смужкою; модалки extract/pack у HBR-стилі (hero + checklist + log).

import { useEffect, useMemo, useState } from "react";
import { useT } from "../../lib/i18n";
import { alert as dpAlert, confirm as dpConfirm } from "../../lib/dialogs";

interface Props { onHome: () => void; }

interface FontItem {
  name: string;
  file: string;
  pathId: string;
  typeId: number;
  assets: string;
  fontSize: number;
  ext: string;
  origPath: string;
  replacePath: string;
  hasOrig: boolean;
  hasReplace: boolean;
  replaceSize: number;
}

interface MissingFontsApi {
  missingFontsStatus: () => Promise<{ ok: boolean; assetsOk?: boolean; assetsPath?: string; originalCount?: number; replaceCount?: number; error?: string }>;
  missingFontsExport: () => Promise<{ ok: boolean; error?: string; summary?: { total: number; checked: number; seconds: number } }>;
  missingFontsList: () => Promise<{ ok: boolean; items: FontItem[] }>;
  missingFontsPickReplace: (p: { item: FontItem }) => Promise<{ ok: boolean; error?: string; replacePath?: string; src?: string }>;
  missingFontsClearReplace: (p: { item: FontItem }) => Promise<{ ok: boolean; error?: string }>;
  missingFontsPack: () => Promise<{ ok: boolean; error?: string; summary?: { applied: number; failed: Array<{ name: string; reason: string }>; changedAssets: string[] } }>;
  onMissingFontsProgress: (cb: (line: string) => void) => () => void;
  onMissingFontsPackProgress: (cb: (line: string) => void) => () => void;
  missingTextRead: (path: string) => Promise<{ ok: boolean; base64?: string; error?: string }>;
  openFolder?: (path: string) => void;
}
const W = window.dp2 as unknown as MissingFontsApi;

type Phase = "loading" | "needs-export" | "ready" | "exporting" | "error";

// FontFace-кеш — щоб preview-шрифти не перезавантажувались на кожен render.
const loadedFamilies = new Set<string>();
function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
async function ensureFontFace(family: string, path: string): Promise<boolean> {
  if (loadedFamilies.has(family)) return true;
  try {
    const r = await W.missingTextRead(path);
    if (!r.ok || !r.base64) return false;
    const bytes = b64ToBytes(r.base64);
    const face = new FontFace(family, bytes.buffer as ArrayBuffer, { display: "swap" });
    await face.load();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (document as any).fonts.add(face);
    loadedFamilies.add(family);
    return true;
  } catch (e) {
    console.warn("[missing-fonts] FontFace load failed:", family, e);
    return false;
  }
}

export function MissingFontsEditor({ onHome }: Props) {
  const t = useT();
  const [phase, setPhase] = useState<Phase>("loading");
  const [errMsg, setErrMsg] = useState<string | null>(null);
  const [previewText, setPreviewText] = useState("Your text");
  const [items, setItems] = useState<FontItem[]>([]);
  const [exportLog, setExportLog] = useState<string[]>([]);
  const [packLog, setPackLog] = useState<string[]>([]);
  const [packing, setPacking] = useState(false);
  const [search, setSearch] = useState("");
  // Pack-success modal у HBR-стилі.
  const [packSuccess, setPackSuccess] = useState<null | {
    applied: number;
    failed: number;
    failedRows: Array<{ name: string; reason: string }>;
    changedAssets: string[];
  }>(null);
  // Export-success modal — HBR-style крок з метрикою.
  const [exportSuccess, setExportSuccess] = useState<null | {
    total: number;
    seconds: number;
    originalDir: string;
  }>(null);

  async function refreshStatus() {
    const s = await W.missingFontsStatus();
    if (!s.ok || !s.assetsOk) {
      setPhase("error");
      setErrMsg(s.error || `resources.assets не знайдено: ${s.assetsPath || "missingRoot не задано"}`);
      return;
    }
    if ((s.originalCount ?? 0) === 0) { setPhase("needs-export"); return; }
    setPhase("ready");
    await refreshItems();
  }

  async function refreshItems() {
    const r = await W.missingFontsList();
    if (r.ok) setItems(r.items);
  }

  useEffect(() => {
    refreshStatus();
    const offX = W.onMissingFontsProgress((line) => setExportLog((prev) => [...prev.slice(-200), line]));
    const offP = W.onMissingFontsPackProgress((line) => setPackLog((prev) => [...prev.slice(-200), line]));
    return () => { offX?.(); offP?.(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function runExport() {
    setPhase("exporting"); setExportLog([]);
    const r = await W.missingFontsExport();
    if (!r.ok) { setPhase("error"); setErrMsg(r.error || "export fail"); return; }
    await refreshStatus();
    const fresh = await W.missingFontsList();
    const sample = (fresh.items || [])[0];
    const dir = sample?.origPath ? sample.origPath.replace(/[\\/][^\\/]+$/, "") : "";
    setExportSuccess({
      total: r.summary?.total ?? 0,
      seconds: r.summary?.seconds ?? 0,
      originalDir: dir,
    });
  }

  async function pickReplace(it: FontItem) {
    const r = await W.missingFontsPickReplace({ item: it });
    if (r.ok) await refreshItems();
    else if (r.error && r.error !== "cancelled") {
      await dpAlert(t("missing.fonts.pickErr"), r.error, { tone: "danger" });
    }
  }

  async function clearReplace(it: FontItem) {
    const ok = await dpConfirm(t("missing.fonts.clearTitle"), t("missing.fonts.clearBody", { name: it.name }), { tone: "warning" });
    if (!ok) return;
    await W.missingFontsClearReplace({ item: it });
    await refreshItems();
  }

  async function clearAllReplacements() {
    const withReplace = items.filter((i) => i.hasReplace);
    if (withReplace.length === 0) return;
    const ok = await dpConfirm(
      t("missing.fonts.clearAllTitle"),
      t("missing.fonts.clearAllBody", { n: String(withReplace.length) }),
      { tone: "warning" }
    );
    if (!ok) return;
    for (const it of withReplace) await W.missingFontsClearReplace({ item: it });
    await refreshItems();
  }

  async function runPack() {
    if (packing) return;
    const replaceCount = items.filter((i) => i.hasReplace).length;
    if (replaceCount === 0) {
      await dpAlert(t("missing.fonts.nothingTitle"), t("missing.fonts.nothingBody"), { tone: "warning" });
      return;
    }
    setPacking(true); setPackLog([]);
    try {
      const r = await W.missingFontsPack();
      if (!r.ok) { await dpAlert(t("missing.fonts.packErrTitle"), r.error || "?", { tone: "danger" }); return; }
      const applied = r.summary?.applied ?? 0;
      const failedArr = r.summary?.failed ?? [];
      const changed = r.summary?.changedAssets ?? [];
      setPackSuccess({ applied, failed: failedArr.length, failedRows: failedArr, changedAssets: changed });
    } finally {
      setPacking(false);
    }
  }

  const filteredItems = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return items;
    return items.filter((it) =>
      it.name.toLowerCase().includes(q) ||
      it.assets.toLowerCase().includes(q) ||
      it.pathId.includes(q)
    );
  }, [items, search]);

  const replaceCount = items.filter((i) => i.hasReplace).length;
  const pctReplaced = items.length > 0 ? Math.round((replaceCount / items.length) * 100) : 0;

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <header className="h-12 px-4 border-b border-[var(--border-soft)] bg-[var(--bg)] flex items-center gap-3 shrink-0">
        <button className="dp-btn dp-btn--ghost" onClick={onHome}>← {t("btn.home")}</button>
        <span className="text-[13px] font-semibold text-[var(--text-strong)]">THE MISSING</span>
        <span className="text-[11px] text-[var(--text-faint)]">— {t("missing.fonts.title")}</span>
        <div className="flex-1" />
        {phase === "ready" && (
          <>
            <div className="flex items-center gap-2 mr-2 px-2.5 py-1 rounded border border-[var(--border-soft)] bg-[var(--bg)]">
              <span className="text-[10.5px] uppercase tracking-wider text-[var(--text-faint)]">{t("missing.fonts.statsLabel")}</span>
              <span className="text-[12.5px] font-semibold tabular-nums text-[var(--text-strong)]">{replaceCount} / {items.length}</span>
              <span className="text-[11.5px] tabular-nums" style={{ color: pctReplaced >= 100 ? "var(--success)" : pctReplaced > 0 ? "var(--accent)" : "var(--text-muted)" }}>{pctReplaced}%</span>
              <div className="w-20 h-1.5 rounded-full bg-[var(--bg-elev)] overflow-hidden">
                <div className="h-full transition-all" style={{ width: `${pctReplaced}%`, background: pctReplaced >= 100 ? "var(--success)" : "var(--accent)" }} />
              </div>
            </div>
            <button
              className="dp-btn dp-btn--ghost"
              onClick={() => {
                const sample = items[0];
                if (sample?.origPath) {
                  const dir = sample.origPath.replace(/[\\/][^\\/]+$/, "");
                  W.openFolder?.(dir);
                }
              }}
              title={t("missing.fonts.openFolderHint")}
            >
              <svg className="w-3.5 h-3.5 mr-1 inline" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-7l-2-2H5a2 2 0 00-2 2z" />
              </svg>
              {t("missing.fonts.openFolder")}
            </button>
            <button className="dp-btn dp-btn--ghost" disabled={replaceCount === 0} onClick={clearAllReplacements} title={t("missing.fonts.clearAll")}>
              {t("missing.fonts.clearAll")}
            </button>
            <button className="dp-btn dp-btn--ghost" onClick={runExport} title={t("missing.fonts.reExportHint")}>
              {t("missing.fonts.reExport")}
            </button>
            <button className="dp-btn dp-btn--success" disabled={packing || replaceCount === 0} onClick={runPack}>
              {packing ? "…" : t("missing.fonts.pack")}
            </button>
          </>
        )}
      </header>

      {phase === "loading" && <div className="flex-1 flex items-center justify-center text-[var(--text-muted)]">{t("missing.editor.loading")}</div>}

      {phase === "error" && (
        <div className="flex-1 flex flex-col items-center justify-center p-8 gap-3">
          <div className="text-[14px] font-semibold text-[var(--danger)]">{t("missing.editor.errorTitle")}</div>
          <div className="text-[12px] text-[var(--text-muted)] max-w-xl text-center">{errMsg}</div>
        </div>
      )}

      {phase === "needs-export" && (
        <div className="flex-1 flex flex-col items-center justify-center p-8 gap-3">
          <svg className="w-12 h-12 text-[var(--text-faint)]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M4 6h16M4 12h16M4 18h16" />
          </svg>
          <div className="text-[14px] font-semibold text-[var(--text-strong)]">{t("missing.fonts.exportTitle")}</div>
          <div className="text-[12px] text-[var(--text-muted)] max-w-xl text-center mb-4">{t("missing.fonts.exportBody")}</div>
          <button className="dp-btn dp-btn--primary" onClick={runExport}>{t("missing.fonts.exportBtn")}</button>
        </div>
      )}

      {phase === "exporting" && (
        <div className="fixed inset-0 z-40 bg-black/60 flex items-center justify-center p-6">
          <div className="w-full max-w-[560px] bg-[var(--bg-surface)] border border-[var(--border-soft)] rounded-lg shadow-xl">
            <div className="px-5 py-3 border-b border-[var(--border-soft)] flex items-center gap-3">
              <span className="inline-block h-3 w-3 rounded-full border-2 border-[var(--accent)] border-t-transparent animate-spin" />
              <p className="text-[13px] font-semibold text-[var(--text-strong)]">{t("missing.fonts.exporting")}</p>
              <span className="ml-auto text-[10.5px] text-[var(--text-faint)] tabular-nums">
                {exportLog.filter((l) => l.startsWith("[EXPORTED]")).length}
              </span>
            </div>
            <div className="px-5 py-3 text-[10.5px] font-mono bg-[var(--bg)] max-h-[280px] overflow-y-auto whitespace-pre-wrap">
              {exportLog.length === 0 ? <span className="text-[var(--text-faint)]">{t("missing.pack.starting")}</span> :
                exportLog.slice(-150).map((l, i) => (
                  <div key={i} className={l.startsWith("[EXPORTED]") ? "text-[var(--success)]" : l.startsWith("[STEP]") ? "text-[var(--accent)]" : l.startsWith("[DIAG]") ? "text-[var(--text-faint)]" : "text-[var(--text-muted)]"}>{l}</div>
                ))}
            </div>
          </div>
        </div>
      )}

      {phase === "ready" && (
        <div className="flex-1 overflow-auto p-4">
          <div className="mb-4 border border-[var(--border-soft)] rounded bg-[var(--bg-surface)] p-4">
            <label className="text-[10px] font-semibold uppercase tracking-wider text-[var(--text-muted)] block mb-2">
              {t("missing.fonts.previewText")}
            </label>
            <input
              className="dp-input w-full mb-2"
              value={previewText}
              onChange={(e) => setPreviewText(e.target.value)}
              placeholder={t("missing.fonts.previewPlaceholder")}
            />
            <div className="flex items-center gap-2">
              <input
                className="dp-input flex-1 text-[11.5px]"
                placeholder={t("missing.fonts.searchPlaceholder")}
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
              <span className="text-[11px] text-[var(--text-faint)] tabular-nums">{filteredItems.length}/{items.length}</span>
            </div>
            <p className="text-[10.5px] text-[var(--text-faint)] mt-2">{t("missing.fonts.previewHint")}</p>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
            {filteredItems.map((it) => (
              <MissingFontCard
                key={it.pathId}
                item={it}
                previewText={previewText}
                onPickReplace={() => pickReplace(it)}
                onClearReplace={() => clearReplace(it)}
              />
            ))}
          </div>
        </div>
      )}

      {/* Pack-progress модалка */}
      {packing && (() => {
        const replaced = packLog.filter((l) => l.startsWith("[REPLACED]")).length;
        const totalGuess = replaceCount;
        const pct = totalGuess > 0 ? Math.min(100, Math.round((replaced / totalGuess) * 100)) : 0;
        const isLoaded = packLog.some((l) => /\[STEP\] Patching/i.test(l));
        const isWriting = packLog.some((l) => /Writing assets/i.test(l));
        const lastRep = (() => {
          const lp = [...packLog].reverse().find((l) => l.startsWith("[REPLACED]"));
          const m = lp?.match(/\[REPLACED\]\s+(\S+)/);
          return m ? m[1] : "";
        })();
        type StepKey = "load" | "patch" | "write";
        const stepStatus = (k: StepKey): "pending" | "running" | "done" => {
          if (k === "load") return isLoaded ? "done" : "running";
          if (k === "patch") {
            if (!isLoaded) return "pending";
            if (totalGuess > 0 && replaced >= totalGuess) return "done";
            return "running";
          }
          if (k === "write") return isWriting ? "running" : "pending";
          return "pending";
        };
        const renderStep = (k: StepKey, title: string, sub?: React.ReactNode) => {
          const s = stepStatus(k);
          const icon = s === "done"
            ? <span className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-[var(--success)]/15 text-[var(--success)] border border-[var(--success)]/40 text-[10px] font-bold shrink-0">✓</span>
            : s === "running"
              ? <span className="inline-flex items-center justify-center w-5 h-5 rounded-full border border-[var(--accent)]/40 bg-[var(--accent)]/10 shrink-0"><span className="inline-block h-2.5 w-2.5 rounded-full border-2 border-[var(--accent)] border-t-transparent animate-spin" /></span>
              : <span className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-[var(--bg-elev)] border border-[var(--border-soft)] text-[var(--text-faint)] text-[10px] shrink-0">○</span>;
          const cls = s === "running" ? "text-[var(--text-strong)]" : s === "done" ? "text-[var(--text)]" : "text-[var(--text-faint)]";
          return (
            <li className="flex items-start gap-2.5 py-1.5">
              {icon}
              <div className="flex-1 min-w-0">
                <p className={`text-[12.5px] leading-snug ${cls}`}>{title}</p>
                {sub && <div className="text-[11px] text-[var(--text-muted)] mt-0.5">{sub}</div>}
              </div>
            </li>
          );
        };
        const colorize = (l: string) =>
          l.startsWith("[REPLACED]") ? "text-[var(--success)]" :
            l.startsWith("[STEP]") ? "text-[var(--accent)]" :
              l.startsWith("[DIAG]") ? "text-[var(--text-faint)]" :
                /WARNING|Error/i.test(l) ? "text-[var(--danger)]" : "text-[var(--text-muted)]";
        return (
          <div className="fixed inset-0 z-40 bg-black/60 flex items-center justify-center p-6">
            <div className="w-full max-w-[600px] bg-[var(--bg-surface)] border border-[var(--border-soft)] rounded-lg shadow-xl">
              <div className="px-5 py-3 border-b border-[var(--border-soft)] flex items-center gap-3">
                <span className="inline-block h-3 w-3 rounded-full border-2 border-[var(--accent)] border-t-transparent animate-spin" />
                <p className="text-[13px] font-semibold text-[var(--text-strong)]">{t("missing.fonts.packing")}</p>
                <span className="ml-auto text-[10.5px] tabular-nums text-[var(--text-faint)]">{replaced}/{totalGuess}</span>
              </div>
              <ol className="px-5 py-3">
                {renderStep("load", t("missing.fonts.step.load"))}
                {renderStep(
                  "patch", t("missing.fonts.step.patch"),
                  stepStatus("patch") !== "pending" ? (
                    <div>
                      <div className="flex items-baseline justify-between mb-1 gap-2">
                        <span className="tabular-nums text-[var(--text-muted)]">{replaced} / {totalGuess} · {pct}%</span>
                        {lastRep && <span className="font-mono text-[10.5px] text-[var(--text-faint)] truncate max-w-[260px]" title={lastRep}>{lastRep}</span>}
                      </div>
                      <div className="h-1 rounded-full bg-[var(--bg-elev)] overflow-hidden">
                        <div className="h-full bg-[var(--accent)] transition-all" style={{ width: `${pct}%` }} />
                      </div>
                    </div>
                  ) : undefined,
                )}
                {renderStep("write", t("missing.fonts.step.write"))}
              </ol>
              <div className="px-5 pb-4">
                <details className="group">
                  <summary className="cursor-pointer list-none text-[11px] text-[var(--text-muted)] hover:text-[var(--text)] flex items-center gap-1 select-none">
                    <span className="inline-block transition-transform group-open:rotate-90">›</span>
                    {t("missing.pack.logToggle")} <span className="text-[var(--text-faint)]">({packLog.length})</span>
                  </summary>
                  <div className="mt-2 text-[10.5px] font-mono bg-[var(--bg)] border border-[var(--border-soft)] rounded p-2 max-h-[220px] overflow-y-auto whitespace-pre-wrap break-all">
                    {packLog.length === 0 ? <span className="text-[var(--text-faint)]">{t("missing.pack.starting")}</span> : packLog.slice(-150).map((l, i) => <div key={i} className={colorize(l)}>{l}</div>)}
                  </div>
                </details>
              </div>
            </div>
          </div>
        );
      })()}

      {/* Export-success модалка — HBR-step-card стиль. */}
      {exportSuccess && (() => {
        const total = exportSuccess.total;
        return (
          <div className="fixed inset-0 z-40 bg-black/60 flex items-center justify-center p-6" onClick={() => setExportSuccess(null)}>
            <div className="w-full max-w-[640px] bg-[var(--bg-surface)] border border-[var(--border-soft)] rounded-xl shadow-2xl overflow-hidden" onClick={(e) => e.stopPropagation()}>
              <div className="px-5 pt-5 pb-3 flex items-start gap-3 border-b border-[var(--border-soft)]">
                <span className="inline-flex items-center justify-center w-9 h-9 rounded-full bg-[var(--success)]/15 text-[var(--success)] border border-[var(--success)]/40 text-[13px] font-bold shrink-0">
                  ✓
                </span>
                <div className="flex-1 min-w-0">
                  <h2 className="text-[15px] font-semibold text-[var(--text-strong)] leading-tight">
                    {t("missing.fonts.stepDoneTitle")}
                  </h2>
                  <p className="text-[12px] text-[var(--text-muted)] mt-1 leading-snug">
                    {t("missing.fonts.stepDoneDesc", { sec: exportSuccess.seconds.toFixed(1) })}
                  </p>
                </div>
              </div>

              <div className="px-5 py-4">
                <div className="rounded-lg border border-[var(--border-soft)] bg-[var(--bg)] px-4 py-3">
                  <div className="flex items-center justify-between gap-3 mb-1.5">
                    <span className="text-[12px] font-semibold text-[var(--text)] flex items-center gap-1.5">
                      <span className="text-[var(--success)]">✓</span>
                      {t("missing.fonts.stepDoneMetric")}
                    </span>
                    <span className="text-[11px] tabular-nums text-[var(--success)] font-semibold">
                      {total}/{total} · 100%
                    </span>
                  </div>
                  <div className="h-1.5 rounded-full bg-[var(--bg-elev)] overflow-hidden">
                    <div className="h-full bg-[var(--success)] transition-all" style={{ width: "100%" }} />
                  </div>
                  {exportSuccess.originalDir && (
                    <p className="text-[10.5px] text-[var(--text-faint)] mt-2 font-mono break-all">
                      {t("missing.fonts.stepDoneDir")} → <span className="text-[var(--text-muted)]">{exportSuccess.originalDir}</span>
                    </p>
                  )}
                </div>
              </div>

              <div className="px-5 pb-4 flex items-center gap-2 border-t border-[var(--border-soft)] pt-3">
                <p className="text-[11px] text-[var(--text-muted)] flex-1">{t("missing.fonts.stepDoneHint")}</p>
                {exportSuccess.originalDir && (
                  <button
                    className="dp-btn"
                    onClick={() => W.openFolder?.(exportSuccess.originalDir)}
                  >
                    <svg className="w-3.5 h-3.5 mr-1 inline" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-7l-2-2H5a2 2 0 00-2 2z" />
                    </svg>
                    {t("missing.fonts.openOriginal")}
                  </button>
                )}
                <button
                  className="dp-btn"
                  onClick={async () => { setExportSuccess(null); await runExport(); }}
                  title={t("missing.fonts.reExportHint")}
                >
                  ↻ {t("missing.fonts.reExportShort")}
                </button>
                <button className="dp-btn dp-btn--primary" onClick={() => setExportSuccess(null)}>
                  {t("btn.close")}
                </button>
              </div>
            </div>
          </div>
        );
      })()}

      {/* Pack-success модалка — стиль HBR. */}
      {packSuccess && (() => {
        const hasFailed = packSuccess.failed > 0;
        const rgba = hasFailed ? "217,119,6" : "34,197,94";
        const cssVar = hasFailed ? "var(--warning,#d97706)" : "var(--success)";
        return (
          <div className="fixed inset-0 z-40 bg-black/60 flex items-center justify-center p-6" onClick={() => setPackSuccess(null)}>
            <div className="w-full max-w-[560px] bg-[var(--bg-surface)] border border-[var(--border-soft)] rounded-xl shadow-2xl overflow-hidden" onClick={(e) => e.stopPropagation()}>
              <div className="relative px-8 pt-7 pb-6 text-center"
                style={{ background: `linear-gradient(135deg, rgba(${rgba},0.18) 0%, rgba(${rgba},0.05) 60%, transparent 100%)`, borderBottom: "1px solid var(--border-soft)" }}>
                <div className="inline-flex items-center justify-center w-14 h-14 rounded-full mb-3"
                  style={{ background: `radial-gradient(circle, rgba(${rgba},0.30), rgba(${rgba},0.05))`, boxShadow: `0 0 22px -4px rgba(${rgba},0.45)` }}>
                  {hasFailed ? (
                    <svg className="w-7 h-7" fill="none" viewBox="0 0 24 24" stroke={cssVar} strokeWidth={2.5}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01M10.29 3.86l-8.18 14.18A2 2 0 003.84 21h16.32a2 2 0 001.73-2.96L13.71 3.86a2 2 0 00-3.42 0z" />
                    </svg>
                  ) : (
                    <svg className="w-7 h-7" fill="none" viewBox="0 0 24 24" stroke={cssVar} strokeWidth={2.5}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                    </svg>
                  )}
                </div>
                <h2 className="text-[22px] font-bold text-[var(--text-strong)] mb-1" style={{ fontFamily: "'Playfair Display', Georgia, serif" }}>
                  {t(hasFailed ? "missing.fonts.packDoneWarnTitle" : "missing.fonts.packDoneTitle")}
                </h2>
                <p className="text-[12.5px] text-[var(--text-muted)]">{t(hasFailed ? "missing.fonts.packDoneSubWarn" : "missing.fonts.packDoneSub")}</p>
              </div>

              <div className="grid grid-cols-2 gap-3 px-6 py-5">
                <div className="rounded-lg border border-[var(--border-soft)] bg-[var(--bg)] px-4 py-3">
                  <p className="text-[10px] uppercase tracking-wider text-[var(--text-faint)] mb-1">{t("missing.fonts.metric.applied")}</p>
                  <p className="text-[22px] font-bold text-[var(--success)] tabular-nums leading-none">{packSuccess.applied.toLocaleString("uk-UA")}</p>
                  <p className="text-[10.5px] text-[var(--text-muted)] mt-1.5">{t("missing.fonts.metric.appliedHint")}</p>
                </div>
                <div className="rounded-lg border border-[var(--border-soft)] bg-[var(--bg)] px-4 py-3">
                  <p className="text-[10px] uppercase tracking-wider text-[var(--text-faint)] mb-1">{t("missing.fonts.metric.failed")}</p>
                  <p className="text-[22px] font-bold tabular-nums leading-none" style={{ color: hasFailed ? "var(--warning,#d97706)" : "var(--text-strong)" }}>{packSuccess.failed.toLocaleString("uk-UA")}</p>
                  <p className="text-[10.5px] text-[var(--text-muted)] mt-1.5">{t("missing.fonts.metric.failedHint")}</p>
                </div>
              </div>

              {packSuccess.changedAssets.length > 0 && (
                <div className="px-6 pb-3">
                  <div className="rounded-md border border-[var(--border-soft)] bg-[var(--bg)] px-3 py-2">
                    <span className="text-[10px] uppercase tracking-wider text-[var(--text-faint)] block mb-1">{t("missing.fonts.changedAssetsLabel")}</span>
                    <p className="text-[11px] font-mono text-[var(--text)] break-all">{packSuccess.changedAssets.join(", ")}</p>
                  </div>
                </div>
              )}

              {packSuccess.failedRows.length > 0 && (
                <div className="px-6 pb-3">
                  <details className="text-[11px]">
                    <summary className="cursor-pointer text-[var(--warning,#d97706)]">{t("missing.fonts.failedSummary", { n: String(packSuccess.failedRows.length) })}</summary>
                    <ul className="mt-1.5 ml-4 list-disc text-[var(--text-muted)] space-y-0.5">
                      {packSuccess.failedRows.slice(0, 20).map((f, i) => (<li key={i}><span className="font-mono">{f.name}</span> — {f.reason}</li>))}
                    </ul>
                  </details>
                </div>
              )}

              <div className="px-6 pb-5 flex flex-wrap items-center gap-2 border-t border-[var(--border-soft)] pt-4">
                <div className="flex-1" />
                <button className="dp-btn" onClick={() => setPackSuccess(null)}>{t("btn.close")}</button>
                <button className={`dp-btn dp-btn--${hasFailed ? "primary" : "success"}`}
                  style={{ boxShadow: `0 0 18px -4px rgba(${rgba},0.55)` }}
                  onClick={() => {
                    (window.dp2 as unknown as { openExternal?: (u: string) => void }).openExternal?.("steam://rungameid/932540");
                    setPackSuccess(null);
                  }}>
                  <svg className="w-4 h-4 mr-1.5 inline" fill="currentColor" viewBox="0 0 24 24"><path d="M8 5v14l11-7z" /></svg>
                  {t("missing.fonts.launchGame")}
                </button>
              </div>
            </div>
          </div>
        );
      })()}
    </div>
  );
}

// Card із прев'ю гри-шрифту (через FontFace API). Якщо є replacement —
// показуємо ЙОГО, інакше — оригінал. Так одразу видно як виглядатиме нова
// гра з підставленим шрифтом.
function MissingFontCard({
  item, previewText, onPickReplace, onClearReplace,
}: {
  item: FontItem;
  previewText: string;
  onPickReplace: () => void;
  onClearReplace: () => void;
}) {
  const t = useT();
  const [family, setFamily] = useState<string>("");
  useEffect(() => {
    let cancelled = false;
    const sourcePath = item.hasReplace ? item.replacePath : item.origPath;
    const bust = item.hasReplace ? item.replaceSize : item.fontSize; // нова заміна → нова сімʼя
    const fam = `Missing-${item.pathId}-v${bust}`;
    ensureFontFace(fam, sourcePath).then((ok) => { if (!cancelled && ok) setFamily(fam); });
    return () => { cancelled = true; };
  }, [item.pathId, item.hasReplace, item.replacePath, item.origPath, item.replaceSize, item.fontSize]);

  const fontFamily = family
    ? `"${family}", "Inter", system-ui, sans-serif`
    : '"Inter", system-ui, sans-serif';

  return (
    <div className={`border rounded bg-[var(--bg-surface)] overflow-hidden flex flex-col ${item.hasReplace ? "border-[var(--success)]/40" : "border-[var(--border-soft)]"}`}>
      <div className="px-4 py-3 border-b border-[var(--border-soft)] flex flex-col gap-1.5">
        <div className="flex items-start justify-between gap-2">
          <h3 className="font-mono text-[12px] text-[var(--text-strong)] break-all leading-tight">
            {item.name || `(no name #${item.pathId})`}
          </h3>
          <span className={`dp-pill shrink-0 ${item.hasReplace ? "dp-pill--success" : "dp-pill--warn"}`}>
            {item.hasReplace ? t("missing.fonts.card.replaced") : t("missing.fonts.card.original")}
          </span>
        </div>
        <p className="text-[10.5px] text-[var(--text-faint)] tabular-nums leading-tight font-mono">
          PathID {item.pathId} · {item.assets}
        </p>
      </div>

      <div className="p-4 bg-[var(--bg)] flex-1 flex items-center justify-center min-h-[110px]">
        <p
          className="text-center break-words"
          style={{
            fontFamily,
            fontSize: 22,
            lineHeight: 1.3,
            letterSpacing: "0.02em",
            color: "var(--text-strong)",
            textShadow: "0 1px 3px rgba(0,0,0, 0.6)",
          }}
        >
          {previewText || t("missing.fonts.previewPlaceholder")}
        </p>
      </div>

      <div className="px-4 py-2 border-t border-[var(--border-soft)] grid grid-cols-3 gap-2 text-[10px] font-mono text-[var(--text-faint)]">
        <span>size <span className="text-[var(--text-muted)]">{(item.fontSize / 1024).toFixed(0)}K</span></span>
        <span>fmt <span className="text-[var(--text-muted)] uppercase">{item.ext}</span></span>
        <span>repl <span className="text-[var(--text-muted)]">{item.hasReplace ? `${(item.replaceSize / 1024).toFixed(0)}K` : "—"}</span></span>
      </div>

      <div className="px-3 py-2 border-t border-[var(--border-soft)] flex gap-2">
        {item.hasReplace ? (
          <>
            <button className="dp-btn flex-1" onClick={onPickReplace} title={t("missing.fonts.replaceAgain")}>
              ↺ {t("missing.fonts.replaceAgain")}
            </button>
            <button className="dp-btn dp-btn--ghost" onClick={onClearReplace} title={t("missing.fonts.clearReplace")}>✕</button>
          </>
        ) : (
          <button className="dp-btn dp-btn--primary flex-1" onClick={onPickReplace}>
            {t("missing.fonts.pickReplace")}
          </button>
        )}
      </div>
    </div>
  );
}
