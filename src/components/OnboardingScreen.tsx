import { useEffect, useState } from "react";
import type { SetupProgress, SetupStatus } from "../lib/ipc";
import { useT } from "../lib/i18n";
import { LangToggle } from "./LangToggle";
import bgImage from "../ui-v2/assets/dp-board.jpg";
import "../ui-v2/theme.css";

interface OnboardingScreenProps {
  status: SetupStatus;
  onComplete: () => void;
  // `onSkip` навмисно прибрано — установка інструментів обов'язкова.
}

function humanBytes(n?: number): string {
  if (!n || n <= 0) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

type WizardStep = "welcome" | "tools";

export function OnboardingScreen({ status, onComplete }: OnboardingScreenProps) {
  const t = useT();
  const [step, setStep] = useState<WizardStep>("welcome");
  const [toolsDir, setToolsDir] = useState(status.settings.toolsDir || status.defaults.toolsDir);

  // Чекбокси download'у: за замовч. вмикаємо, якщо інструмента ще немає.
  // Якщо обидва уже валідні — show "everything is up to date" і дозволяємо
  // одразу Continue без download.
  const [downloadUabea, setDownloadUabea] = useState(!status.validity.uabeaPath);
  const [downloadPwsh, setDownloadPwsh] = useState(!status.validity.pwshPath);

  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<SetupProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [logLines, setLogLines] = useState<string[]>([]);
  const [allValid, setAllValid] = useState(status.validity.uabeaPath && status.validity.pwshPath);

  useEffect(() => {
    const off = window.dp2.onSetupProgress((p) => {
      setProgress(p);
      // Локалізований текст через i18nKey, інакше fallback на raw message.
      const text = p.i18nKey ? t(p.i18nKey, p.i18nParams) : (p.message || "");
      const tag = `[${p.phase}${p.tool ? ":" + p.tool : ""}]`;
      const line = `${tag} ${text}`;
      // De-flood: download phase шле сотні однакових рядків (raz na 100ms) —
      // якщо tag/text повторюється — оновлюємо ОСТАННІЙ рядок замість push.
      setLogLines((prev) => {
        const last = prev[prev.length - 1];
        if (last && last.startsWith(tag)) {
          const copy = prev.slice();
          copy[copy.length - 1] = line;
          return copy;
        }
        return [...prev.slice(-60), line];
      });
    });
    return off;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const progressText = progress
    ? (progress.i18nKey ? t(progress.i18nKey, progress.i18nParams) : (progress.message || ""))
    : "";

  // Refresh статусу інструментів — чи стали валідні після download.
  async function refreshValidity() {
    try {
      const s = await window.dp2.setupStatus();
      setAllValid(s.validity.uabeaPath && s.validity.pwshPath);
      return s;
    } catch {
      return null;
    }
  }

  async function pickUabea() {
    const f = await window.dp2.pickFile({
      title: t("onb.pick.uabea"),
      filters: [{ name: "Executables", extensions: ["exe"] }],
    });
    if (f) {
      await window.dp2.saveSettings({ uabeaPath: f });
      setDownloadUabea(false);
      await refreshValidity();
    }
  }
  async function pickPwsh() {
    const f = await window.dp2.pickFile({
      title: t("onb.pick.pwsh"),
      filters: [{ name: "Executables", extensions: ["exe"] }],
    });
    if (f) {
      await window.dp2.saveSettings({ pwshPath: f });
      setDownloadPwsh(false);
      await refreshValidity();
    }
  }
  async function pickToolsDir() {
    const f = await window.dp2.pickFolder();
    if (f) setToolsDir(f);
  }

  async function runDownload() {
    setError(null);
    setRunning(true);
    setLogLines([]);
    try {
      const res = await window.dp2.setupRun({
        toolsDir,
        downloadUabea,
        downloadPwsh,
      });
      if (res.error) {
        setError(res.error);
        return;
      }
      await refreshValidity();
    } catch (e: any) {
      setError(String(e?.message ?? e));
    } finally {
      setRunning(false);
    }
  }

  async function finish() {
    // Позначаємо first-run як виконаний — і йдемо на Home.
    await window.dp2.saveSettings({ setupCompleted: true });
    onComplete();
  }

  const pct =
    progress?.percent != null
      ? Math.max(0, Math.min(100, progress.percent))
      : progress?.phase === "done"
      ? 100
      : null;

  // Якщо обидва інструменти вже валідні при відкритті — анімація "налагоджено".
  const nothingToDo = status.validity.uabeaPath && status.validity.pwshPath && !downloadUabea && !downloadPwsh;

  return (
    <div className="dp-v2 flex-1 v2-board-wrapper overflow-y-auto relative">
      <div
        className="v2-board-bg-image"
        style={{ backgroundImage: `url(${bgImage})` }}
        aria-hidden
      />
      <div className="v2-board-overlay" aria-hidden />
      <div className="absolute top-3 right-4 z-10">
        <LangToggle />
      </div>

      <div className="relative z-[1] min-h-full flex flex-col items-center justify-center px-6 py-10">
        <div className="text-center mb-6">
          <span className="v2-bureau-mark">{t("home.v2.bureau")}</span>
          <h1 className="v2-hub-title">Localization Tool</h1>
          <p className="v2-hub-subtitle">{t("onb.welcome.subtitle")}</p>
        </div>
        <div className="dp-card w-[860px] max-w-full flex flex-col">
          {/* Step indicator */}
          <header className="px-6 py-5 border-b border-[var(--border-soft)]">
            <div className="flex items-center justify-center gap-2 mb-3">
              <StepDot active={step === "welcome"} done={step !== "welcome"} label="1" />
              <span className="h-px w-12 bg-[var(--border-soft)]" />
              <StepDot active={step === "tools"} done={false} label="2" />
            </div>
            <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-[var(--text-faint)] text-center mb-1">
              {step === "welcome" ? t("onb.step.welcome") : t("onb.step.tools")}
            </p>
            <h1 className="text-[22px] font-bold text-[var(--text-strong)] tracking-tight text-center">
              {step === "welcome" ? t("onb.welcome.title") : t("onb.tools.title")}
            </h1>
            <p className="text-[13px] text-[var(--text-muted)] text-center mt-2">
              {step === "welcome" ? t("onb.welcome.subtitle") : t("onb.tools.subtitle")}
            </p>
          </header>

          {step === "welcome" && (
            <div className="p-6 space-y-4">
              <p className="text-[13px] text-[var(--text-muted)] leading-relaxed">
                {t("onb.welcome.intro")}
              </p>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                <GameCard
                  title="Deadly Premonition"
                  subtitle="Director's Cut"
                  desc={t("onb.welcome.dp1.desc")}
                  badge="DP1"
                />
                <GameCard
                  title="Deadly Premonition 2"
                  subtitle="A Blessing in Disguise"
                  desc={t("onb.welcome.dp2.desc")}
                  badge="DP2"
                />
                <GameCard
                  title="The Good Life"
                  subtitle="Swery65"
                  desc={t("onb.welcome.tgl.desc")}
                  badge="TGL"
                />
              </div>
              <div className="rounded-md border border-[var(--border-soft)] bg-[var(--bg)] px-4 py-3">
                <p className="text-[12px] text-[var(--text-muted)] leading-relaxed">
                  {t("onb.welcome.pathsNote")}
                </p>
              </div>
            </div>
          )}

          {step === "tools" && (
            <div className="p-6 space-y-5">
              <p className="text-[12.5px] text-[var(--text-muted)] leading-relaxed">
                {t("onb.tools.intro")}
              </p>

              {/* Tools dir picker */}
              <section>
                <h2 className="text-[12px] font-semibold uppercase tracking-wider text-[var(--text-muted)] mb-1.5">
                  {t("onb.tools.dirLabel")}
                </h2>
                <div className="flex gap-2">
                  <input className="dp-input flex-1 font-mono text-[12px]" value={toolsDir} onChange={(e) => setToolsDir(e.target.value)} disabled={running} />
                  <button className="dp-btn" onClick={pickToolsDir} disabled={running}>{t("onb.btn.pickFolder")}</button>
                </div>
              </section>

              {/* Tool checkboxes */}
              <section className="space-y-2">
                <ToolRow
                  name="UABEA Next"
                  desc={t("onb.tool.uabea.desc")}
                  checked={downloadUabea}
                  onToggle={setDownloadUabea}
                  configured={status.validity.uabeaPath}
                  configuredPath={status.settings.uabeaPath}
                  onPickCustom={pickUabea}
                  disabled={running}
                />
                <ToolRow
                  name="PowerShell 7 (portable)"
                  desc={t("onb.tool.pwsh.desc")}
                  checked={downloadPwsh}
                  onToggle={setDownloadPwsh}
                  configured={status.validity.pwshPath}
                  configuredPath={status.settings.pwshPath}
                  onPickCustom={pickPwsh}
                  disabled={running}
                />
              </section>

              {/* Progress */}
              {(running || progress) && (
                <section className="p-3 rounded-md border border-[var(--border-soft)] bg-[var(--bg)]">
                  <div className="flex items-center justify-between mb-1.5">
                    <span className="text-[12px] font-semibold text-[var(--text-strong)]">
                      {progressText || t("onb.progress.ready")}
                    </span>
                    {progress?.total ? (
                      <span className="text-[11px] tabular-nums text-[var(--text-muted)]">
                        {humanBytes(progress.downloaded)} / {humanBytes(progress.total)}
                        {pct != null && ` · ${pct}%`}
                      </span>
                    ) : pct != null ? (
                      <span className="text-[11px] tabular-nums text-[var(--text-muted)]">{pct}%</span>
                    ) : null}
                  </div>
                  <div className="h-1.5 rounded-full bg-[var(--bg-elevated)] overflow-hidden">
                    <div
                      className="h-full bg-[var(--accent)] transition-all"
                      style={{ width: pct != null ? `${pct}%` : "0%" }}
                    />
                  </div>
                  {logLines.length > 0 && (
                    <pre className="mt-2 max-h-[140px] overflow-y-auto text-[10.5px] font-mono text-[var(--text-faint)] leading-snug">
                      {logLines.join("\n")}
                    </pre>
                  )}
                </section>
              )}

              {error && (
                <div className="p-3 rounded-md border border-[var(--danger)]/40 bg-[var(--danger)]/10 text-[12px] text-[var(--danger)] whitespace-pre-wrap">
                  {error}
                  <p className="mt-2 text-[11px] opacity-80">{t("onb.error.retryHint")}</p>
                </div>
              )}

              {allValid && !running && (
                <div className="p-3 rounded-md border border-[var(--success)]/40 bg-[var(--success)]/10 text-[12px] text-[var(--success)]">
                  ✓ {t("onb.tools.allReady")}
                </div>
              )}
            </div>
          )}

          {/* Footer with navigation */}
          <footer className="px-6 py-4 border-t border-[var(--border-soft)] flex items-center justify-between gap-2">
            {step === "welcome" ? (
              <>
                <span className="text-[11px] text-[var(--text-faint)]">{t("onb.welcome.requireToolsHint")}</span>
                <button
                  className="dp-btn dp-btn--primary"
                  onClick={() => setStep("tools")}
                >
                  {t("onb.btn.next")} →
                </button>
              </>
            ) : (
              <>
                <button className="dp-btn dp-btn--ghost" onClick={() => setStep("welcome")} disabled={running}>
                  ← {t("onb.btn.back")}
                </button>
                <div className="flex gap-2">
                  {!allValid && (
                    <button
                      className="dp-btn dp-btn--primary"
                      onClick={runDownload}
                      disabled={running || (!downloadUabea && !downloadPwsh) || !toolsDir.trim()}
                    >
                      {running ? t("onb.btn.running") : nothingToDo ? t("onb.btn.run") : t("onb.btn.runDownload")}
                    </button>
                  )}
                  <button
                    className="dp-btn dp-btn--success"
                    onClick={finish}
                    disabled={!allValid || running}
                    title={!allValid ? t("onb.btn.finish.disabledHint") : undefined}
                  >
                    {t("onb.btn.finish")} ✓
                  </button>
                </div>
              </>
            )}
          </footer>
        </div>
      </div>
    </div>
  );
}

function StepDot({ active, done, label }: { active: boolean; done: boolean; label: string }) {
  return (
    <span
      className={
        "inline-flex items-center justify-center w-7 h-7 rounded-full text-[11px] font-bold border " +
        (done
          ? "bg-[var(--success)] border-[var(--success)] text-white"
          : active
          ? "bg-[var(--accent)] border-[var(--accent)] text-white"
          : "bg-[var(--bg)] border-[var(--border-soft)] text-[var(--text-faint)]")
      }
    >
      {done ? "✓" : label}
    </span>
  );
}

function GameCard({ title, subtitle, desc, badge }: { title: string; subtitle: string; desc: string; badge: string }) {
  return (
    <div className="rounded-md border border-[var(--border-soft)] bg-[var(--bg)] p-3">
      <div className="flex items-center gap-2 mb-1">
        <span className="dp-pill dp-pill--info text-[10px]">{badge}</span>
        <h3 className="text-[13px] font-bold text-[var(--text-strong)] truncate">{title}</h3>
      </div>
      <p className="text-[11px] text-[var(--text-faint)] mb-1.5">{subtitle}</p>
      <p className="text-[11.5px] text-[var(--text-muted)] leading-relaxed">{desc}</p>
    </div>
  );
}

interface ToolRowProps {
  name: string;
  desc: string;
  checked: boolean;
  onToggle: (v: boolean) => void;
  configured: boolean;
  configuredPath?: string;
  onPickCustom: () => void;
  disabled: boolean;
}
function ToolRow({ name, desc, checked, onToggle, configured, configuredPath, onPickCustom, disabled }: ToolRowProps) {
  const t = useT();
  return (
    <label className="flex items-start gap-2 p-2.5 rounded-md border border-[var(--border-soft)] bg-[var(--bg)] cursor-pointer">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onToggle(e.target.checked)}
        disabled={disabled || configured}
        className="mt-0.5"
      />
      <span className="flex-1 min-w-0">
        <span className="text-[13px] font-semibold text-[var(--text-strong)]">{name}</span>
        <span className="block text-[11.5px] text-[var(--text-muted)] mt-0.5">{desc}</span>
        {configured && configuredPath && (
          <span className="block text-[11px] text-[var(--success)] mt-1">
            ✓ {t("onb.tool.alreadyConfigured")} <span className="font-mono break-all">{configuredPath}</span>
          </span>
        )}
        {!checked && !configured && (
          <button onClick={onPickCustom} className="text-[11px] text-[var(--accent)] hover:underline mt-1" disabled={disabled}>
            {t("onb.tool.pickCustomGeneric")}
          </button>
        )}
      </span>
    </label>
  );
}
