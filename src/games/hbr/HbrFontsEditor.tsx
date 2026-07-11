import { useEffect, useRef, useState } from "react";
import { useT, localizeBackendError } from "../../lib/i18n";
import hbrHero from "../../ui-v2/assets/hbr-hero.jpg";
import { HbrFontsGuideModal } from "./HbrFontsGuideModal";

interface Props {
  onHome: () => void;
}

interface ToolProgress {
  phase: "download" | "extract" | "done" | "error";
  i18nKey?: string;
  i18nParams?: Record<string, string | number>;
  message?: string;
  total?: number;
  downloaded?: number;
  percent?: number;
  bytesPerSec?: number;
}

function humanBytes(n?: number): string {
  if (!n || n <= 0) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

// Step-1: завантаження FontGen-тулзи. Step-2: розпакування атласів. Step-3:
// розпакування TMP_FontAsset-MonoBehaviour. Step-4 (поки заглушка): готово.
type Phase = "init" | "downloading" | "fontgenReady" | "extracting" | "ready" | "error";
type ExtractKind = "atlas" | "mono" | null;

interface FontsStatus {
  atlasCount: number;
  monoCount: number;
  atlasDir: string | null;
  monoDir: string | null;
  bundleOk: boolean;
}

export function HbrFontsEditor({ onHome }: Props) {
  const t = useT();
  const [phase, setPhase] = useState<Phase>("init");
  const [toolProgress, setToolProgress] = useState<ToolProgress | null>(null);
  const [exePath, setExePath] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Atlas/Mono extraction state.
  const [fontsStatus, setFontsStatus] = useState<FontsStatus | null>(null);
  const [extractKind, setExtractKind] = useState<ExtractKind>(null);
  const [extractStatusLine, setExtractStatusLine] = useState<string>("");
  const [atlasProgress, setAtlasProgress] = useState<{ done: number; total: number | null } | null>(null);
  const [monoProgress, setMonoProgress] = useState<{ done: number; total: number | null } | null>(null);
  const [usedCache, setUsedCache] = useState(false);
  const [guideOpen, setGuideOpen] = useState(false);

  // Авто-показ інструкції після першого готового extract'у. Прапор зберігаємо
  // у settings, щоб модалка не з'являлась знов на повторних запусках. Кнопкою
  // "?" поряд із "Запустити TMPUnity" можна відкрити її назад вручну.
  useEffect(() => {
    if (phase !== "ready") return;
    let cancelled = false;
    (async () => {
      try {
        const s = await window.dp2.getSettings();
        if (cancelled) return;
        if (!(s as { hbrFontsGuideSeen?: boolean }).hbrFontsGuideSeen) {
          setGuideOpen(true);
        }
      } catch { /* silent */ }
    })();
    return () => { cancelled = true; };
  }, [phase]);

  async function closeGuide() {
    setGuideOpen(false);
    try {
      await window.dp2.saveSettings({ hbrFontsGuideSeen: true } as Record<string, unknown>);
    } catch { /* silent */ }
  }

  const triedRef = useRef(false);

  // Підписка на прогрес-канали обох скриптів.
  useEffect(() => {
    const w = window.dp2;
    const offFontgen = w.onHbrFontgenProgress?.((p: ToolProgress) => setToolProgress(p));
    const offAtlas = w.onHbrFontsAtlasProgress?.((line: string) => {
      handleExtractLine(line, "atlas");
    });
    const offMono = w.onHbrFontsMonoProgress?.((line: string) => {
      handleExtractLine(line, "mono");
    });
    return () => {
      if (typeof offFontgen === "function") offFontgen();
      if (typeof offAtlas === "function") offAtlas();
      if (typeof offMono === "function") offMono();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function handleExtractLine(line: string, kind: "atlas" | "mono") {
    // [STEP] / [DIAG] беремо як «поточний крок». [EXPORTED] інкрементує лічильник.
    const stepMatch = line.match(/^\[STEP\]\s*(.+)$/);
    if (stepMatch) setExtractStatusLine(stepMatch[1].trim());
    if (/^\[EXPORTED\]/.test(line)) {
      if (kind === "atlas") {
        setAtlasProgress((p) => ({ done: (p?.done ?? 0) + 1, total: p?.total ?? null }));
      } else {
        setMonoProgress((p) => ({ done: (p?.done ?? 0) + 1, total: p?.total ?? null }));
      }
    }
  }

  async function refreshFontsStatus(): Promise<FontsStatus> {
    const r = await window.dp2.hbrFontsStatus();
    const status: FontsStatus = {
      atlasCount: r.atlasCount ?? 0,
      monoCount: r.monoCount ?? 0,
      atlasDir: r.atlasDir ?? null,
      monoDir: r.monoDir ?? null,
      bundleOk: !!r.bundleOk,
    };
    setFontsStatus(status);
    return status;
  }

  async function runFlow() {
    try {
      // Step 1: TMP_FontAssetCreator (Dropbox).
      const s = await window.dp2.hbrFontgenStatus();
      if (s.installed && s.exePath) {
        setExePath(s.exePath);
      } else {
        setPhase("downloading");
        const dl = await window.dp2.hbrFontgenDownload();
        if (!dl.ok) { setErrorMsg(localizeBackendError(dl.error) || "download fail"); setPhase("error"); return; }
        setExePath(dl.exePath ?? null);
      }
      setPhase("fontgenReady");

      // Якщо обидві теки вже мають файли — нічого не перезапускаємо. Інакше
      // прогон скрипта на кожен захід у редактор просто палить диск/CPU.
      const initial = await refreshFontsStatus();
      if (!initial.bundleOk) {
        setErrorMsg(t("hbr.fonts.errNoBundle"));
        setPhase("error");
        return;
      }
      if (initial.atlasCount > 0 && initial.monoCount > 0) {
        // Прогрес-бари заповнюємо вручну (100%), щоб UI Step 2 виглядав
        // завершеним замість порожнього стану.
        setAtlasProgress({ done: initial.atlasCount, total: initial.atlasCount });
        setMonoProgress({ done: initial.monoCount, total: initial.monoCount });
        setUsedCache(true);
        setPhase("ready");
        return;
      }
      await runExtraction();
    } catch (e: unknown) {
      setErrorMsg(String((e as Error)?.message ?? e));
      setPhase("error");
    }
  }

  async function runExtraction() {
    setPhase("extracting");
    setExtractStatusLine("");
    setAtlasProgress({ done: 0, total: null });
    setMonoProgress({ done: 0, total: null });

    setExtractKind("atlas");
    const rA = await window.dp2.hbrFontsAtlasExport();
    if (!rA.ok) { setErrorMsg(localizeBackendError(rA.error) || "atlas export failed"); setPhase("error"); return; }
    if (rA.summary?.total != null) {
      setAtlasProgress({ done: rA.summary.total, total: rA.summary.total });
    }

    setExtractKind("mono");
    const rM = await window.dp2.hbrFontsMonoExport();
    if (!rM.ok) { setErrorMsg(localizeBackendError(rM.error) || "mono export failed"); setPhase("error"); return; }
    if (rM.summary?.total != null) {
      setMonoProgress({ done: rM.summary.total, total: rM.summary.total });
    }

    setExtractKind(null);
    await refreshFontsStatus();
    setPhase("ready");
  }

  useEffect(() => {
    if (triedRef.current) return;
    triedRef.current = true;
    runFlow();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function openFontgenFolder() {
    const r = await window.dp2.hbrFontgenStatus();
    if (r.ok && window.dp2.openFolder) window.dp2.openFolder(r.root);
  }

  const [launchError, setLaunchError] = useState<string | null>(null);
  async function launchFontgen() {
    setLaunchError(null);
    const r = await window.dp2.hbrFontgenLaunch();
    if (!r.ok) setLaunchError(localizeBackendError(r.error) || "launch failed");
  }

  // Step 4: pack-back state.
  const [packBusy, setPackBusy] = useState(false);
  const [packStatusLine, setPackStatusLine] = useState<string>("");
  const [packCounts, setPackCounts] = useState<{ mb: number; tex: number }>({ mb: 0, tex: 0 });
  const [packResult, setPackResult] = useState<{
    ok: boolean;
    monoApplied?: number;
    atlasApplied?: number;
    failed?: Array<{ file: string; reason: string }>;
    error?: string;
  } | null>(null);

  useEffect(() => {
    const off = window.dp2.onHbrFontsImportProgress?.((line: string) => {
      const stepMatch = line.match(/^\[STEP\]\s*(.+)$/);
      if (stepMatch) setPackStatusLine(stepMatch[1].trim());
      if (/^\[PATCHED-MB\]/.test(line)) setPackCounts((p) => ({ ...p, mb: p.mb + 1 }));
      if (/^\[PATCHED-TEX\]/.test(line)) setPackCounts((p) => ({ ...p, tex: p.tex + 1 }));
    });
    return () => { if (typeof off === "function") off(); };
  }, []);

  async function packBack() {
    setPackBusy(true);
    setPackStatusLine("");
    setPackCounts({ mb: 0, tex: 0 });
    setPackResult(null);
    try {
      const r = await window.dp2.hbrFontsImport();
      if (!r.ok) {
        setPackResult({ ok: false, error: localizeBackendError(r.error) || "pack failed" });
        return;
      }
      setPackResult({
        ok: true,
        monoApplied: r.summary?.monoApplied ?? 0,
        atlasApplied: r.summary?.atlasApplied ?? 0,
        failed: r.summary?.failed ?? [],
      });
    } finally {
      setPackBusy(false);
    }
  }

  const renderToolProgress = () => (
    <section className="p-4 rounded-md border border-[var(--border-soft)] bg-[var(--bg)]">
      <div className="flex items-center justify-between mb-2 gap-3">
        <span className="text-[13px] font-semibold text-[var(--text-strong)] truncate">
          {toolProgress?.i18nKey
            ? t(toolProgress.i18nKey, toolProgress.i18nParams)
            : t("hbr.fontgen.checking")}
        </span>
        {toolProgress?.total ? (
          <span className="text-[11px] tabular-nums text-[var(--text-muted)] shrink-0">
            {humanBytes(toolProgress.downloaded)} / {humanBytes(toolProgress.total)}
            {toolProgress.percent != null && ` · ${toolProgress.percent}%`}
          </span>
        ) : toolProgress?.percent != null ? (
          <span className="text-[11px] tabular-nums text-[var(--text-muted)] shrink-0">{toolProgress.percent}%</span>
        ) : null}
      </div>
      <div className="h-1.5 rounded-full bg-[var(--bg-elevated)] overflow-hidden">
        <div
          className="h-full bg-[var(--accent)] transition-all"
          style={{ width: toolProgress?.percent != null ? `${toolProgress.percent}%` : "0%" }}
        />
      </div>
      {toolProgress && toolProgress.bytesPerSec != null && toolProgress.bytesPerSec > 0 && (
        <p className="mt-2 text-[11px] tabular-nums text-[var(--text-muted)]">
          {t("hbr.fontgen.speed", { speed: humanBytes(toolProgress.bytesPerSec) })}
        </p>
      )}
    </section>
  );

  const renderExtractRow = (
    kind: "atlas" | "mono",
    progress: { done: number; total: number | null } | null,
    labelKey: string,
    descKey: string,
  ) => {
    const active = extractKind === kind;
    const done = progress?.done ?? 0;
    const total = progress?.total ?? null;
    const isComplete = total != null && done >= total && total > 0;
    // Атласів зазвичай ~14, MB ~10. Якщо total ще невідомий — показуємо
    // indeterminate-стиль (counter без знаменника).
    const percent = total != null && total > 0 ? Math.min(100, Math.round((done / total) * 100)) : null;
    return (
      <div className="p-3 rounded-md border border-[var(--border-soft)] bg-[var(--bg)]">
        <div className="flex items-center justify-between gap-3 mb-1.5">
          <span className="text-[12.5px] font-semibold text-[var(--text-strong)] truncate flex items-center gap-2">
            {isComplete ? (
              <span className="text-[var(--success)]">✓</span>
            ) : active ? (
              <span className="inline-block w-3.5 h-3.5 rounded-full border-2 border-[var(--text-faint)] border-t-[var(--accent)] animate-spin" aria-hidden />
            ) : (
              <span className="text-[var(--text-faint)]">·</span>
            )}
            {t(labelKey)}
          </span>
          <span className="text-[11px] tabular-nums text-[var(--text-muted)] shrink-0">
            {total != null ? `${done}/${total}` : done > 0 ? `${done}` : "—"}
            {percent != null && ` · ${percent}%`}
          </span>
        </div>
        <div className="h-1.5 rounded-full bg-[var(--bg-elevated)] overflow-hidden">
          <div
            className={`h-full transition-all ${isComplete ? "bg-[var(--success)]" : "bg-[var(--accent)]"}`}
            style={{
              width: percent != null
                ? `${percent}%`
                : active ? "40%" : "0%",
              animation: active && percent == null ? "hbr-fonts-slide 1.2s ease-in-out infinite" : undefined,
            }}
          />
        </div>
        <p className="mt-1.5 text-[11px] text-[var(--text-muted)] leading-relaxed">{t(descKey)}</p>
        {active && extractStatusLine && (
          <p className="mt-1 text-[10.5px] font-mono text-[var(--text-faint)] truncate" title={extractStatusLine}>
            {extractStatusLine}
          </p>
        )}
      </div>
    );
  };

  return (
    <div className="flex-1 flex flex-col bg-[var(--bg)] min-h-0">
      <header className="h-12 px-4 border-b border-[var(--border-soft)] bg-[var(--bg-surface)] flex items-center gap-2 shrink-0">
        <button className="dp-btn dp-btn--ghost" onClick={onHome} title={t("header.home")}>←</button>
        <span className="text-[13px] font-semibold text-[var(--text-strong)] truncate">Hotel Barcelona · {t("home.v2.action.fonts")}</span>
      </header>

      <div className="flex-1 flex items-center justify-center p-8 overflow-y-auto relative" style={{ background: "#0d1117" }}>
        <div
          aria-hidden
          style={{
            position: "absolute", inset: 0,
            backgroundImage: `url(${hbrHero})`,
            backgroundSize: "cover", backgroundPosition: "center",
            filter: "blur(2px) brightness(0.45) saturate(1.1)",
            opacity: 0.6, zIndex: 0,
          }}
        />
        <div
          aria-hidden
          style={{
            position: "absolute", inset: 0,
            background: "linear-gradient(180deg, rgba(13,17,23,0.45) 0%, rgba(13,17,23,0.85) 60%, rgba(13,17,23,0.95) 100%)",
            zIndex: 0,
          }}
        />
        <div className="w-full max-w-[680px] relative" style={{ zIndex: 1 }}>
          <header className="mb-6 text-center">
            <p className="text-[11px] uppercase tracking-[0.2em] text-[var(--text-faint)] mb-1">Hotel Barcelona</p>
            <h2 className="text-[20px] font-bold text-[var(--text-strong)] mb-1">{t("hbr.fontgen.title")}</h2>
            <p className="text-[12.5px] text-[var(--text-muted)] leading-relaxed mb-1">{t("hbr.fontgen.subtitle")}</p>
            <p className="text-[11px] italic text-[var(--text-faint)]">{t("hbr.fontgen.byline")}</p>
          </header>

          {(phase === "init" || phase === "downloading") && renderToolProgress()}

          {(phase === "fontgenReady" || phase === "extracting" || phase === "ready") && (
            <div className="flex flex-col gap-3">
              <section className="p-4 rounded-md border border-[var(--success)]/40 bg-[var(--success)]/5">
                <div className="flex items-center gap-3 mb-1">
                  <span className="flex h-7 w-7 items-center justify-center rounded-full bg-[var(--success)]/15 text-[var(--success)] border border-[var(--success)]/40 text-[12px] font-bold">1</span>
                  <p className="text-[13px] font-semibold text-[var(--text-strong)]">{t("hbr.fonts.step1Title")}</p>
                </div>
                {exePath && (
                  <p className="text-[11px] font-mono text-[var(--text-faint)] break-all ml-10" title={exePath}>{exePath}</p>
                )}
                <div className="flex gap-2 mt-2 ml-10">
                  <button className="dp-btn" onClick={openFontgenFolder}>
                    {t("hbr.fontgen.openFolder")}
                  </button>
                </div>
              </section>

              <section className="p-4 rounded-md border border-[var(--border-soft)] bg-[var(--bg-surface)]">
                <div className="flex items-center gap-3 mb-3">
                  <span className={`flex h-7 w-7 items-center justify-center rounded-full border text-[12px] font-bold ${
                    phase === "ready"
                      ? "bg-[var(--success)]/15 text-[var(--success)] border-[var(--success)]/40"
                      : "bg-[var(--accent)]/15 text-[var(--accent)] border-[var(--accent)]/40"
                  }`}>2</span>
                  <div className="flex-1 min-w-0">
                    <p className="text-[13px] font-semibold text-[var(--text-strong)]">{t("hbr.fonts.step2Title")}</p>
                    <p className="text-[11.5px] text-[var(--text-muted)] leading-relaxed">{t("hbr.fonts.step2Subtitle")}</p>
                  </div>
                </div>

                <div className="flex flex-col gap-2 ml-10">
                  {renderExtractRow("atlas", atlasProgress, "hbr.fonts.atlasLabel", "hbr.fonts.atlasDesc")}
                  {renderExtractRow("mono", monoProgress, "hbr.fonts.monoLabel", "hbr.fonts.monoDesc")}
                </div>

                {phase === "ready" && fontsStatus && (
                  <div className="ml-10 mt-3 flex items-center gap-3 flex-wrap">
                    <p className="text-[11.5px] text-[var(--text-muted)] flex-1 min-w-0">
                      {t(usedCache ? "hbr.fonts.cachedSummary" : "hbr.fonts.readySummary", {
                        atlas: fontsStatus.atlasCount,
                        mono: fontsStatus.monoCount,
                      })}
                    </p>
                    <button
                      className="dp-btn dp-btn--ghost shrink-0 !text-[11px]"
                      title={t("hbr.fonts.reExtractHint")}
                      onClick={async () => {
                        // Видаляємо обидві теки і перезапускаємо extract.
                        // У main.cjs `hbrFontsAtlasExport`/`MonoExport` обидва
                        // тільки пишуть, не очищують — тож видалення робимо
                        // через локальний IPC (далі додам purge), а зараз
                        // просто перезапускаємо runFlow.
                        setUsedCache(false);
                        setAtlasProgress(null);
                        setMonoProgress(null);
                        await runExtraction();
                      }}
                    >
                      {t("hbr.fonts.reExtract")}
                    </button>
                  </div>
                )}
              </section>

              {phase === "ready" && (
                <section className="p-4 rounded-md border border-[var(--accent)]/40 bg-[var(--accent)]/5">
                  <div className="flex items-center gap-3 mb-2">
                    <span className="flex h-7 w-7 items-center justify-center rounded-full bg-[var(--accent)]/15 text-[var(--accent)] border border-[var(--accent)]/40 text-[12px] font-bold">3</span>
                    <p className="text-[13px] font-semibold text-[var(--text-strong)]">{t("hbr.fonts.step3Title")}</p>
                  </div>
                  <p className="text-[12px] text-[var(--text-muted)] leading-relaxed ml-10 mb-3">
                    {t("hbr.fonts.step3Body")}
                  </p>
                  <div className="flex items-center gap-2 ml-10">
                    <button className="dp-btn dp-btn--primary" onClick={launchFontgen}>
                      {t("hbr.fonts.launchTmpUnity")}
                    </button>
                    <button
                      className="dp-btn dp-btn--ghost"
                      onClick={() => setGuideOpen(true)}
                      title={t("hbr.fontsGuide.openHint")}
                    >
                      {t("hbr.fontsGuide.openBtn")}
                    </button>
                  </div>
                  {launchError && (
                    <p className="ml-10 mt-2 text-[11px] text-[var(--danger)] whitespace-pre-wrap">{launchError}</p>
                  )}
                </section>
              )}

              {phase === "ready" && (
                <section className="p-4 rounded-md border border-[var(--border-soft)] bg-[var(--bg-surface)]">
                  <div className="flex items-center gap-3 mb-2">
                    <span className={`flex h-7 w-7 items-center justify-center rounded-full border text-[12px] font-bold ${
                      packResult?.ok
                        ? "bg-[var(--success)]/15 text-[var(--success)] border-[var(--success)]/40"
                        : packResult && !packResult.ok
                          ? "bg-[var(--danger)]/15 text-[var(--danger)] border-[var(--danger)]/40"
                          : "bg-[var(--bg-elevated)] text-[var(--text-muted)] border-[var(--border-soft)]"
                    }`}>4</span>
                    <div className="flex-1 min-w-0">
                      <p className="text-[13px] font-semibold text-[var(--text-strong)]">{t("hbr.fonts.step4Title")}</p>
                      <p className="text-[11.5px] text-[var(--text-muted)] leading-relaxed">{t("hbr.fonts.step4Subtitle")}</p>
                    </div>
                  </div>

                  <div className="ml-10">
                    {!packBusy && !packResult && (
                      <button className="dp-btn dp-btn--primary" onClick={packBack}>
                        {t("hbr.fonts.packBtn")}
                      </button>
                    )}

                    {packBusy && (
                      <div className="flex flex-col gap-2">
                        <div className="flex items-center gap-2 text-[12px] text-[var(--text-strong)]">
                          <span className="inline-block w-3.5 h-3.5 rounded-full border-2 border-[var(--text-faint)] border-t-[var(--accent)] animate-spin" aria-hidden />
                          {t("hbr.fonts.packBusy")}
                        </div>
                        <div className="h-1.5 rounded-full bg-[var(--bg-elevated)] overflow-hidden">
                          <div
                            className="h-full bg-[var(--accent)]"
                            style={{ width: "40%", animation: "hbr-fonts-slide 1.2s ease-in-out infinite" }}
                          />
                        </div>
                        <p className="text-[11px] tabular-nums text-[var(--text-muted)]">
                          {t("hbr.fonts.packCounts", { mb: packCounts.mb, tex: packCounts.tex })}
                        </p>
                        {packStatusLine && (
                          <p className="text-[10.5px] font-mono text-[var(--text-faint)] truncate" title={packStatusLine}>
                            {packStatusLine}
                          </p>
                        )}
                      </div>
                    )}

                    {packResult?.ok && (
                      <div className="p-3 rounded-md border border-[var(--success)]/40 bg-[var(--success)]/5">
                        <p className="text-[12px] text-[var(--text-strong)] font-semibold mb-1">
                          {t("hbr.fonts.packDoneTitle")}
                        </p>
                        <p className="text-[11.5px] text-[var(--text-muted)] leading-relaxed">
                          {t("hbr.fonts.packDoneBody", {
                            mb: packResult.monoApplied ?? 0,
                            tex: packResult.atlasApplied ?? 0,
                          })}
                        </p>
                        {packResult.failed && packResult.failed.length > 0 && (
                          <details className="mt-2">
                            <summary className="text-[11px] text-[var(--danger)] cursor-pointer">
                              {t("hbr.fonts.packFailedSummary", { n: packResult.failed.length })}
                            </summary>
                            <ul className="mt-1 ml-4 list-disc text-[11px] text-[var(--text-muted)]">
                              {packResult.failed.slice(0, 20).map((f, i) => (
                                <li key={i}><span className="font-mono">{f.file}</span> — {f.reason}</li>
                              ))}
                            </ul>
                          </details>
                        )}
                        <button className="dp-btn mt-2" onClick={() => { setPackResult(null); setPackCounts({ mb: 0, tex: 0 }); setPackStatusLine(""); }}>
                          {t("hbr.fonts.packAgain")}
                        </button>
                      </div>
                    )}

                    {packResult && !packResult.ok && (
                      <div className="p-3 rounded-md border border-[var(--danger)]/40 bg-[var(--danger)]/10">
                        <p className="text-[12px] text-[var(--danger)] font-semibold mb-1">{t("hbr.fonts.packErrTitle")}</p>
                        <p className="text-[11px] font-mono text-[var(--text)] whitespace-pre-wrap break-words max-h-40 overflow-auto">
                          {packResult.error}
                        </p>
                        <button className="dp-btn mt-2" onClick={() => { setPackResult(null); setPackCounts({ mb: 0, tex: 0 }); setPackStatusLine(""); }}>
                          {t("hbr.fonts.packAgain")}
                        </button>
                      </div>
                    )}
                  </div>
                </section>
              )}
            </div>
          )}

          {phase === "error" && (
            <section className="rounded-md border border-[var(--danger)]/40 bg-[var(--danger)]/10 p-4">
              <p className="text-[13px] font-bold text-[var(--danger)] mb-1">{t("hbr.fontgen.errTitle")}</p>
              <p className="text-[12.5px] text-[var(--text)] whitespace-pre-wrap leading-relaxed">{errorMsg}</p>
              <div className="flex gap-2 mt-3">
                <button className="dp-btn dp-btn--primary" onClick={() => { setErrorMsg(null); triedRef.current = false; runFlow(); triedRef.current = true; }}>
                  {t("hbr.fontgen.retry")}
                </button>
              </div>
            </section>
          )}
        </div>
      </div>

      <HbrFontsGuideModal open={guideOpen} onClose={closeGuide} />

      <style>{`
        @keyframes hbr-fonts-slide {
          0%   { transform: translateX(-100%); }
          50%  { transform: translateX(50%); }
          100% { transform: translateX(250%); }
        }
      `}</style>
    </div>
  );
}
