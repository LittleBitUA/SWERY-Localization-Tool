import { useEffect, useState } from "react";
import type { SetupProgress, SetupStatus } from "../lib/ipc";
import { useT } from "../lib/i18n";
import { LangToggle } from "./LangToggle";

interface OnboardingScreenProps {
  status: SetupStatus;
  onComplete: () => void;
  onSkip?: () => void;
}

function humanBytes(n?: number): string {
  if (!n || n <= 0) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export function OnboardingScreen({ status, onComplete, onSkip }: OnboardingScreenProps) {
  const t = useT();
  const [toolsDir, setToolsDir] = useState(status.settings.toolsDir || status.defaults.toolsDir);
  const [assetsPath, setAssetsPath] = useState(status.settings.assetsPath);
  const [lastFolder, setLastFolder] = useState(status.settings.lastFolder);
  const [downloadUabea, setDownloadUabea] = useState(!status.validity.uabeaPath);
  const [downloadPwsh, setDownloadPwsh] = useState(!status.validity.pwshPath);

  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<SetupProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [logLines, setLogLines] = useState<string[]>([]);

  // Підписка на прогрес-події.
  useEffect(() => {
    const off = window.dp2.onSetupProgress((p) => {
      setProgress(p);
      const line = `[${p.phase}${p.tool ? ":" + p.tool : ""}] ${p.message}`;
      setLogLines((prev) => [...prev.slice(-40), line]);
    });
    return off;
  }, []);

  // Якщо assetsPath порожній — пробуємо запропонувати реальний з defaults.
  useEffect(() => {
    if (assetsPath) return;
    const tryPaths = status.defaults.suggestedAssets || [];
    // Беремо перший варіант як підказку, файлову перевірку зробимо при run.
    if (tryPaths.length > 0) setAssetsPath(tryPaths[0]);
  }, []);

  async function pickAssets() {
    const f = await window.dp2.pickFile({
      title: "Виберіть sharedassets0.assets гри",
      filters: [{ name: "Unity assets", extensions: ["assets"] }],
    });
    if (f) setAssetsPath(f);
  }

  async function pickFolder() {
    const f = await window.dp2.pickFolder();
    if (f) setLastFolder(f);
  }

  async function pickToolsDir() {
    const f = await window.dp2.pickFolder();
    if (f) setToolsDir(f);
  }

  async function pickUabea() {
    const f = await window.dp2.pickFile({
      title: "Виберіть UABEANext.exe",
      filters: [{ name: "Executables", extensions: ["exe"] }],
    });
    if (f) {
      await window.dp2.saveSettings({ uabeaPath: f });
      setDownloadUabea(false);
    }
  }

  async function pickPwsh() {
    const f = await window.dp2.pickFile({
      title: "Виберіть pwsh.exe (PowerShell 7)",
      filters: [{ name: "Executables", extensions: ["exe"] }],
    });
    if (f) {
      await window.dp2.saveSettings({ pwshPath: f });
      setDownloadPwsh(false);
    }
  }

  async function run() {
    setError(null);
    setRunning(true);
    setLogLines([]);
    try {
      const res = await window.dp2.setupRun({
        toolsDir,
        assetsPath: assetsPath || undefined,
        lastFolder: lastFolder || undefined,
        downloadUabea,
        downloadPwsh,
      });
      if (res.error) {
        setError(res.error);
        return;
      }
      onComplete();
    } catch (e: any) {
      setError(String(e?.message ?? e));
    } finally {
      setRunning(false);
    }
  }

  const pct =
    progress?.percent != null
      ? Math.max(0, Math.min(100, progress.percent))
      : progress?.phase === "done"
      ? 100
      : null;

  return (
    <div className="flex-1 flex flex-col bg-[var(--bg)] overflow-y-auto relative">
      <div className="absolute top-3 right-4 z-10">
        <LangToggle />
      </div>
      <div className="flex-1 flex items-center justify-center px-6 py-10">
        <div className="dp-card w-[820px] max-w-full flex flex-col">
          <header className="px-6 py-5 border-b border-[var(--border-soft)] text-center">
            <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-[var(--text-faint)] mb-2">
              {t("onb.tagline")}
            </p>
            <h1 className="text-[22px] font-bold text-[var(--text-strong)] tracking-tight">
              {t("onb.title")}
            </h1>
            <p className="text-[13px] text-[var(--text-muted)] mt-2">
              {t("onb.subtitle")}
            </p>
          </header>

          <div className="p-6 space-y-5">
            <section>
              <div className="flex items-baseline gap-2 mb-1.5">
                <span className="dp-pill dp-pill--info">1</span>
                <h2 className="text-[14px] font-semibold text-[var(--text-strong)]">{t("onb.step1.title")}</h2>
              </div>
              <p className="text-[12px] text-[var(--text-muted)] mb-2">{t("onb.step1.hint")}</p>
              <div className="flex gap-2">
                <input className="dp-input flex-1" value={toolsDir} onChange={(e) => setToolsDir(e.target.value)} />
                <button className="dp-btn" onClick={pickToolsDir} disabled={running}>{t("onb.btn.pickFolder")}</button>
              </div>
            </section>

            <section>
              <div className="flex items-baseline gap-2 mb-1.5">
                <span className="dp-pill dp-pill--info">2</span>
                <h2 className="text-[14px] font-semibold text-[var(--text-strong)]">{t("onb.step2.title")}</h2>
              </div>
              <p className="text-[12px] text-[var(--text-muted)] mb-2">{t("onb.step2.hint")}</p>
              <div className="flex gap-2">
                <input className="dp-input flex-1 font-mono text-[12px]" value={assetsPath} onChange={(e) => setAssetsPath(e.target.value)} placeholder="…\sharedassets0.assets" />
                <button className="dp-btn" onClick={pickAssets} disabled={running}>{t("onb.btn.pickFile")}</button>
              </div>
            </section>

            <section>
              <div className="flex items-baseline gap-2 mb-1.5">
                <span className="dp-pill dp-pill--info">3</span>
                <h2 className="text-[14px] font-semibold text-[var(--text-strong)]">{t("onb.step3.title")}</h2>
              </div>
              <p className="text-[12px] text-[var(--text-muted)] mb-2">{t("onb.step3.hint")}</p>
              <div className="flex gap-2">
                <input className="dp-input flex-1 font-mono text-[12px]" value={lastFolder} onChange={(e) => setLastFolder(e.target.value)} placeholder="…\Localization\DP2\TEXT" />
                <button className="dp-btn" onClick={pickFolder} disabled={running}>{t("onb.btn.pickFolder")}</button>
              </div>
            </section>

            <section>
              <div className="flex items-baseline gap-2 mb-1.5">
                <span className="dp-pill dp-pill--info">4</span>
                <h2 className="text-[14px] font-semibold text-[var(--text-strong)]">{t("onb.step4.title")}</h2>
              </div>
              <div className="space-y-2">
                <label className="flex items-start gap-2 p-2.5 rounded-md border border-[var(--border-soft)] bg-[var(--bg)] cursor-pointer">
                  <input
                    type="checkbox"
                    checked={downloadUabea}
                    onChange={(e) => setDownloadUabea(e.target.checked)}
                    disabled={running}
                    className="mt-0.5"
                  />
                  <span className="flex-1">
                    <span className="text-[13px] font-semibold text-[var(--text-strong)]">UABEA Next</span>
                    <span className="block text-[11.5px] text-[var(--text-muted)] mt-0.5">{t("onb.tool.uabea.desc")}</span>
                    {status.validity.uabeaPath && (
                      <span className="block text-[11px] text-[var(--success)] mt-1">
                        {t("onb.tool.alreadyConfigured")} <span className="font-mono">{status.settings.uabeaPath}</span>
                      </span>
                    )}
                    {!downloadUabea && !status.validity.uabeaPath && (
                      <button onClick={pickUabea} className="text-[11px] text-[var(--accent)] hover:underline mt-1" disabled={running}>
                        {t("onb.tool.pickCustom", { file: "UABEANext.exe" })}
                      </button>
                    )}
                  </span>
                </label>

                <label className="flex items-start gap-2 p-2.5 rounded-md border border-[var(--border-soft)] bg-[var(--bg)] cursor-pointer">
                  <input
                    type="checkbox"
                    checked={downloadPwsh}
                    onChange={(e) => setDownloadPwsh(e.target.checked)}
                    disabled={running}
                    className="mt-0.5"
                  />
                  <span className="flex-1">
                    <span className="text-[13px] font-semibold text-[var(--text-strong)]">PowerShell 7 (portable)</span>
                    <span className="block text-[11.5px] text-[var(--text-muted)] mt-0.5">{t("onb.tool.pwsh.desc")}</span>
                    {status.validity.pwshPath && (
                      <span className="block text-[11px] text-[var(--success)] mt-1">
                        {t("onb.tool.alreadyConfigured")} <span className="font-mono">{status.settings.pwshPath}</span>
                      </span>
                    )}
                    {!downloadPwsh && !status.validity.pwshPath && (
                      <button onClick={pickPwsh} className="text-[11px] text-[var(--accent)] hover:underline mt-1" disabled={running}>
                        {t("onb.tool.pickCustom", { file: "pwsh.exe" })}
                      </button>
                    )}
                  </span>
                </label>
              </div>
            </section>

            {/* Progress */}
            {(running || progress) && (
              <section className="mt-2 p-3 rounded-md border border-[var(--border-soft)] bg-[var(--bg)]">
                <div className="flex items-center justify-between mb-1.5">
                  <span className="text-[12px] font-semibold text-[var(--text-strong)]">
                    {progress?.message || t("onb.progress.ready")}
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
                  <pre className="mt-2 max-h-[120px] overflow-y-auto text-[10.5px] font-mono text-[var(--text-faint)] leading-snug">
                    {logLines.join("\n")}
                  </pre>
                )}
              </section>
            )}

            {error && (
              <div className="p-3 rounded-md border border-[var(--danger)]/40 bg-[var(--danger)]/10 text-[12px] text-[var(--danger)] whitespace-pre-wrap">
                {error}
              </div>
            )}
          </div>

          <footer className="px-6 py-4 border-t border-[var(--border-soft)] flex items-center justify-between">
            {onSkip ? (
              <button className="dp-btn dp-btn--ghost" onClick={onSkip} disabled={running}>
                {t("onb.btn.skip")}
              </button>
            ) : (
              <span />
            )}
            <button
              className="dp-btn dp-btn--primary"
              onClick={run}
              disabled={running || !toolsDir.trim()}
            >
              {running ? t("onb.btn.running") : t("onb.btn.run")}
            </button>
          </footer>
        </div>
      </div>
    </div>
  );
}
