import { useEffect, useRef, useState } from "react";
import { useT } from "../../lib/i18n";
import dp1Hero from "../../ui-v2/assets/dp1-hero.jpg";
import { Dp1TextEditor } from "./Dp1TextEditor";

interface Props {
  onHome: () => void;
}

interface SetupStatus {
  root: string;
  exePath: string | null;
  mesPath: string | null;
  mesCopied: boolean;
  jsonPath: string | null;
  jsonSize: number;
  doneExists: boolean;
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

// Покрокова майстерня: 1) Завантажити DPMsgTool, 2) Згенерувати JSON-дамп
// із mes_all.mes, 3) Перехід у Dp1TextEditor (Original/Done/Meta пайплайн).
type Phase = "init" | "checking" | "downloading" | "extracted" | "ready";
type Mode = "checking" | "wizard" | "editor";

export function Dp1Editor({ onHome }: Props) {
  const t = useT();
  const [mode, setMode] = useState<Mode>("checking");
  const [phase, setPhase] = useState<Phase>("init");
  const [status, setStatus] = useState<SetupStatus | null>(null);
  const [toolProgress, setToolProgress] = useState<ToolProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [extractBusy, setExtractBusy] = useState(false);
  const [recordCount, setRecordCount] = useState<number | null>(null);
  const triedRef = useRef(false);

  // Прогрес-канал для завантаження інструмента.
  useEffect(() => {
    const off = window.dp2.onDp1ToolProgress?.((p: ToolProgress) => setToolProgress(p));
    return () => { if (typeof off === "function") off(); };
  }, []);

  async function refreshStatus(): Promise<SetupStatus> {
    const r = await window.dp2.dp1SetupStatus();
    const s: SetupStatus = {
      root: r.root,
      exePath: r.exePath,
      mesPath: r.mesPath,
      mesCopied: r.mesCopied,
      jsonPath: r.jsonPath,
      jsonSize: r.jsonSize,
      doneExists: !!r.doneExists,
    };
    setStatus(s);
    return s;
  }

  async function runFlow() {
    setPhase("checking");
    setError(null);
    try {
      const initial = await refreshStatus();
      // Якщо вже є Done/mes_all.json — одразу йдемо у редактор.
      if (initial.doneExists) { setMode("editor"); return; }
      setMode("wizard");
      if (!initial.exePath) {
        setPhase("downloading");
        const dl = await window.dp2.dp1DownloadTool();
        if (!dl.ok) { setError(dl.error ?? "download failed"); setPhase("init"); return; }
        const after = await refreshStatus();
        if (after.doneExists) { setMode("editor"); return; }
      }
      // Інструмент готовий — одразу авто-екстракт (без кнопки). Якщо
      // mes_all.mes не знайдено у грі автоматично, runExtract сам відкриє
      // file picker (`needsPick`-гілка).
      setPhase("extracted");
      await runExtract();
    } catch (e: unknown) {
      setError(String((e as Error)?.message ?? e));
      setPhase("init");
    }
  }

  useEffect(() => {
    if (triedRef.current) return;
    triedRef.current = true;
    runFlow();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function runExtract(overrideMes?: string) {
    setExtractBusy(true);
    setError(null);
    try {
      const r = await window.dp2.dp1PrepMes(overrideMes ? { mesPath: overrideMes } : {});
      if (!r.ok) {
        if (r.needsPick) {
          // Знайти не вдалось — пропонуємо вибрати руками.
          const picked = await window.dp2.pickFile({
            title: t("dp1.setup.step2.pickTitle"),
            filters: [{ name: "mes_all.mes", extensions: ["mes"] }],
          });
          if (!picked) return;
          await runExtract(picked);
          return;
        }
        setError(r.error ?? "extract failed");
        return;
      }
      setRecordCount(r.recordCount ?? null);
      const s = await refreshStatus();
      if (s.doneExists) { setMode("editor"); return; }
      setPhase("ready");
    } finally {
      setExtractBusy(false);
    }
  }

  async function pickMesManually() {
    const picked = await window.dp2.pickFile({
      title: t("dp1.setup.step2.pickTitle"),
      filters: [{ name: "mes_all.mes", extensions: ["mes"] }],
    });
    if (picked) await runExtract(picked);
  }

  function openToolFolder() {
    if (status?.root) window.dp2.openFolder(status.root);
  }

  const installed = !!status?.exePath;
  const haveJson = !!status?.jsonPath;
  const dlPercent = toolProgress?.percent;

  // Якщо setup завершено і Done/mes_all.json вже існує — рендеримо повний редактор.
  if (mode === "editor") {
    return <Dp1TextEditor onHome={onHome} />;
  }
  if (mode === "checking") {
    return (
      <div className="flex-1 flex items-center justify-center bg-[var(--bg)] text-[var(--text-muted)] text-[13px]">
        Перевірка стану DP1…
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col bg-[var(--bg)] min-h-0">
      <header className="h-12 px-4 border-b border-[var(--border-soft)] bg-[var(--bg-surface)] flex items-center gap-2 shrink-0">
        <button className="dp-btn dp-btn--ghost" onClick={onHome} title={t("header.home")}>←</button>
        <span className="text-[13px] font-semibold text-[var(--text-strong)] truncate">
          Deadly Premonition · {t("home.v2.action.text")}
        </span>
      </header>

      <div className="flex-1 flex items-center justify-center p-8 overflow-y-auto relative" style={{ background: "#0d1117" }}>
        <div
          aria-hidden
          style={{
            position: "absolute", inset: 0,
            backgroundImage: `url(${dp1Hero})`,
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

        <div className="w-full max-w-[520px] relative" style={{ zIndex: 1 }}>
          <header className="mb-6 text-center">
            <p className="text-[11px] uppercase tracking-[0.2em] text-[var(--text-faint)] mb-1">{t("dp1.brand")}</p>
            <h2 className="text-[20px] font-bold text-[var(--text-strong)] mb-1">Готуємо переклад</h2>
            <p className="text-[12.5px] text-[var(--text-muted)] leading-relaxed mb-1">
              Перший запуск — потрібно завантажити інструмент та витягнути текст із гри. Кілька секунд і відкриється редактор.
            </p>
            <p className="text-[11px] italic text-[var(--text-faint)]">{t("dp1.byline")}</p>
          </header>

          {/* Одна жива картка — показує що зараз відбувається */}
          {(() => {
            // Поточна фаза для UI:
            //   download: завантаження DPMsgTool
            //   extract:  виклик DPMsgTool to-json
            //   pick:     потрібен вибір mes_all.mes вручну (game folder не знайдено)
            //   start:    стартовий стан (натисніть, щоб почати)
            let stage: "start" | "download" | "extract" | "pick" = "start";
            if (phase === "downloading") stage = "download";
            else if (extractBusy) stage = "extract";
            else if (installed && !haveJson) stage = "pick";

            const title =
              stage === "download" ? "Завантаження DPMsgTool by MrIkso"
              : stage === "extract" ? "Розпакування mes_all.mes у JSON"
              : stage === "pick" ? "Вибери mes_all.mes вручну"
              : "Готовий розпочати?";
            const desc =
              stage === "download"
                ? "Скачуємо CLI, який читає та запаковує .mes-діалоги Deadly Premonition. Покладемо у Documents\\SWERY-Localization-Tool\\DP1\\Text\\Tool\\."
              : stage === "extract"
                ? "Беремо mes_all.mes з теки гри, запускаємо DPMsgTool і отримуємо JSON-дамп для редактора."
              : stage === "pick"
                ? "Не вдалося автоматично знайти mes_all.mes у грі. Вкажи файл вручну — далі він сам конвертується."
                : "Натисни Старт — інструмент завантажиться, текст витягнеться, і відкриється редактор.";

            return (
              <section className="p-4 rounded-md border border-[var(--border-soft)] bg-[var(--bg-surface)]">
                <div className="flex items-center gap-3 mb-2">
                  <span className={`flex h-8 w-8 items-center justify-center rounded-full border ${
                    stage === "start"
                      ? "bg-[var(--bg-elevated)] text-[var(--text-muted)] border-[var(--border-soft)]"
                      : "bg-[var(--accent)]/15 text-[var(--accent)] border-[var(--accent)]/40"
                  }`}>
                    {stage === "start" || stage === "pick" ? (
                      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M14 5l7 7-7 7M3 12h18" />
                      </svg>
                    ) : (
                      <span className="inline-block w-3.5 h-3.5 rounded-full border-2 border-[var(--text-faint)] border-t-[var(--accent)] animate-spin" aria-hidden />
                    )}
                  </span>
                  <div className="flex-1 min-w-0">
                    <p className="text-[13px] font-semibold text-[var(--text-strong)]">{title}</p>
                    <p className="text-[11.5px] text-[var(--text-muted)] leading-relaxed">{desc}</p>
                  </div>
                </div>

                <div className="ml-11 mt-3">
                  {/* Download — прогрес-бар із швидкістю */}
                  {stage === "download" && (
                    <div className="flex flex-col gap-2">
                      <div className="flex items-center justify-between gap-3">
                        <span className="text-[11.5px] text-[var(--text-muted)] truncate">
                          {toolProgress?.i18nKey ? t(toolProgress.i18nKey, toolProgress.i18nParams) : "Завантаження…"}
                        </span>
                        {toolProgress?.total ? (
                          <span className="text-[11px] tabular-nums text-[var(--text-muted)] shrink-0">
                            {humanBytes(toolProgress.downloaded)} / {humanBytes(toolProgress.total)}
                            {dlPercent != null && ` · ${dlPercent}%`}
                          </span>
                        ) : dlPercent != null ? (
                          <span className="text-[11px] tabular-nums text-[var(--text-muted)] shrink-0">{dlPercent}%</span>
                        ) : null}
                      </div>
                      <div className="h-1.5 rounded-full bg-[var(--bg-elevated)] overflow-hidden">
                        <div className="h-full bg-[var(--accent)] transition-all" style={{ width: dlPercent != null ? `${dlPercent}%` : "0%" }} />
                      </div>
                      {toolProgress?.bytesPerSec != null && toolProgress.bytesPerSec > 0 && (
                        <p className="text-[11px] tabular-nums text-[var(--text-muted)]">
                          {t("dp1.setup.speed", { speed: humanBytes(toolProgress.bytesPerSec) })}
                        </p>
                      )}
                    </div>
                  )}

                  {/* Extract — indeterminate бар */}
                  {stage === "extract" && (
                    <div className="h-1.5 rounded-full bg-[var(--bg-elevated)] overflow-hidden">
                      <div className="h-full bg-[var(--accent)]" style={{ width: "40%", animation: "dp1-setup-slide 1.2s ease-in-out infinite" }} />
                    </div>
                  )}

                  {/* Manual pick */}
                  {stage === "pick" && (
                    <div className="flex gap-2 flex-wrap">
                      <button className="dp-btn dp-btn--primary" onClick={pickMesManually}>
                        {t("dp1.setup.step2.pickBtn")}
                      </button>
                      <button className="dp-btn dp-btn--ghost" onClick={() => runExtract()}>
                        Спробувати ще раз
                      </button>
                    </div>
                  )}

                  {/* Start (cold start, нема ні download ні extract) */}
                  {stage === "start" && (
                    <button className="dp-btn dp-btn--primary" onClick={runFlow}>
                      Розпочати
                    </button>
                  )}
                </div>
              </section>
            );
          })()}

          {error && (
            <section className="mt-3 p-4 rounded-md border border-[var(--danger)]/40 bg-[var(--danger)]/10">
              <p className="text-[13px] font-bold text-[var(--danger)] mb-1">{t("dp1.setup.errTitle")}</p>
              <p className="text-[12px] text-[var(--text)] whitespace-pre-wrap leading-relaxed font-mono break-words max-h-40 overflow-auto">{error}</p>
              <div className="flex gap-2 mt-3">
                <button className="dp-btn dp-btn--primary" onClick={() => { setError(null); runFlow(); }}>
                  {t("dp1.setup.retry")}
                </button>
              </div>
            </section>
          )}
        </div>
      </div>

      <style>{`
        @keyframes dp1-setup-slide {
          0%   { transform: translateX(-100%); }
          50%  { transform: translateX(50%); }
          100% { transform: translateX(250%); }
        }
      `}</style>
    </div>
  );
}
