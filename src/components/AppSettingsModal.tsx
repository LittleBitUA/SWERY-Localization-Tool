// App-wide налаштування (Home screen). Не плутати з DP2 SettingsModal у
// Header — там тільки DP2-specific опції таблиці. Тут: мова, шлях до Hotel
// Barcelona (його тулзи мають окремий цикл — корінь треба з head'у),
// перевірка оновлень + симуляція банера для dev.

import { useEffect, useState } from "react";
import { useT, getLang, setLang, type Lang } from "../lib/i18n";

interface Props {
  open: boolean;
  onClose: () => void;
}

export function AppSettingsModal({ open, onClose }: Props) {
  const t = useT();
  const [lang, setLangState] = useState<Lang>(getLang());
  // Корінні теки 4 ігор. main.cjs сам шукає всередині потрібні ассети.
  const [dp2Root, setDp2Root] = useState("");
  const [tglRoot, setTglRoot] = useState("");
  const [dp1Root, setDp1Root] = useState("");
  const [hbrRoot, setHbrRoot] = useState("");
  const [detectStatus, setDetectStatus] = useState<Record<string, string>>({});
  // Autosave (crash-recovery)
  const [autosaveDir, setAutosaveDir] = useState("");
  const [autosaveIntervalMin, setAutosaveIntervalMin] = useState<number>(1);
  const [appVer, setAppVer] = useState<string>("?");
  const [updateBusy, setUpdateBusy] = useState(false);
  const [updateResult, setUpdateResult] = useState<{
    current: string; latest?: string; available?: boolean; error?: string; htmlUrl?: string;
  } | null>(null);

  useEffect(() => {
    if (!open) return;
    setLangState(getLang());
    window.dp2.getSettings().then((s) => {
      const ss = s as { dp2Root?: string; tglRoot?: string; dp1Root?: string; hbrRoot?: string; autosaveDir?: string; autosaveIntervalMin?: number };
      setDp2Root(ss.dp2Root ?? "");
      setTglRoot(ss.tglRoot ?? "");
      setDp1Root(ss.dp1Root ?? "");
      setHbrRoot(ss.hbrRoot ?? "");
      setAutosaveDir(ss.autosaveDir ?? "");
      setAutosaveIntervalMin(typeof ss.autosaveIntervalMin === "number" ? ss.autosaveIntervalMin : 1);
    });
    window.dp2.appVersion().then(setAppVer).catch(() => {});
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  function changeLang(l: Lang) {
    setLang(l); setLangState(l);
  }

  // Generic-pick/detect для будь-якої гри: settingsKey — поле у settings.json
  // (dp2Root/tglRoot/dp1Root/hbrRoot), folderName — назва теки common/<X>,
  // setter — React-state для UI.
  async function pickGameRoot(settingsKey: string, setter: (v: string) => void) {
    const p = await window.dp2.pickFolder({ title: t("set.games.pickBtn") });
    if (p) {
      setter(p);
      await window.dp2.saveSettings({ [settingsKey]: p } as Record<string, unknown>);
    }
  }
  async function autoDetectGameRoot(settingsKey: string, folderName: string, setter: (v: string) => void) {
    setDetectStatus((m) => ({ ...m, [settingsKey]: t("set.hbr.detecting") }));
    const r = await window.dp2.steamFindGame(folderName);
    if (r.ok && r.path) {
      setter(r.path);
      await window.dp2.saveSettings({ [settingsKey]: r.path } as Record<string, unknown>);
      setDetectStatus((m) => ({ ...m, [settingsKey]: t("set.games.detected") }));
    } else {
      setDetectStatus((m) => ({ ...m, [settingsKey]: r.error || t("set.games.notFound") }));
    }
  }

  async function checkUpdate() {
    setUpdateBusy(true);
    try {
      const r = await window.dp2.checkUpdate({ force: true });
      setUpdateResult({
        current: r.current ?? appVer,
        latest: r.latest, available: r.available,
        error: r.ok ? undefined : r.error, htmlUrl: r.htmlUrl,
      });
    } finally { setUpdateBusy(false); }
  }

  async function simulateBanner() {
    await window.dp2.saveSettings({
      lastUpdateCheck: Date.now(),
      lastUpdateCache: {
        ok: true, available: true,
        current: appVer, latest: "99.99.0",
        htmlUrl: "https://github.com/LittleBitUA/Deadly-Premonition-Localization-Tool/releases",
        publishedAt: new Date().toISOString(),
        name: "Mock v99.99.0", body: "",
      },
      dismissedUpdateVersion: "",
    } as Record<string, unknown>);
    window.location.reload();
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-6 bg-black/60" onClick={onClose}>
      <div className="dp-card w-full max-w-xl flex flex-col" onClick={(e) => e.stopPropagation()}>
        <header className="px-5 py-3 border-b border-[var(--border-soft)] flex items-center justify-between">
          <div>
            <h2 className="text-[15px] font-semibold text-[var(--text-strong)]">{t("appset.title")}</h2>
            <p className="text-[11.5px] text-[var(--text-muted)] mt-0.5">{t("appset.subtitle")}</p>
          </div>
          <button onClick={onClose} className="dp-btn dp-btn--ghost !w-7 !p-0" title={t("btn.close")}>
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </header>

        <div className="p-5 space-y-5 max-h-[65vh] overflow-y-auto">

          {/* Language */}
          <section>
            <label className="text-[11px] font-semibold uppercase tracking-wider text-[var(--text-muted)] block mb-1.5">
              {t("set.display.lang")}
            </label>
            <div className="inline-flex rounded-md bg-[var(--bg-elevated)] p-0.5 gap-0.5 ring-1 ring-[var(--border-soft)]">
              <button
                className={`px-4 py-1.5 text-[12px] font-semibold uppercase rounded transition-colors ${
                  lang === "uk" ? "bg-[var(--accent)] text-white" : "text-[var(--text-muted)] hover:text-[var(--text)]"
                }`}
                onClick={() => changeLang("uk")}
              >UK · Українська</button>
              <button
                className={`px-4 py-1.5 text-[12px] font-semibold uppercase rounded transition-colors ${
                  lang === "en" ? "bg-[var(--accent)] text-white" : "text-[var(--text-muted)] hover:text-[var(--text)]"
                }`}
                onClick={() => changeLang("en")}
              >EN · English</button>
            </div>
            <p className="text-[11px] text-[var(--text-faint)] mt-1.5 leading-relaxed">{t("set.display.langHint")}</p>
          </section>

          {/* Game roots (DP2/TGL/DP1/HBR). Кожен рядок: input + auto-detect + pick. */}
          <section className="pt-3 border-t border-[var(--border-soft)]">
            <label className="text-[11px] font-semibold uppercase tracking-wider text-[var(--text-muted)] block mb-1.5">
              {t("set.games.title")}
            </label>
            <p className="text-[11px] text-[var(--text-faint)] mb-2 leading-relaxed">{t("set.games.hint")}</p>
            <div className="flex flex-col gap-3">
              {([
                { key: "dp2Root", folder: "Deadly Premonition 2",                  label: t("set.games.dp2"), value: dp2Root, setter: setDp2Root, placeholder: "…\\steamapps\\common\\Deadly Premonition 2" },
                { key: "tglRoot", folder: "The Good Life",                         label: t("set.games.tgl"), value: tglRoot, setter: setTglRoot, placeholder: "…\\steamapps\\common\\The Good Life" },
                { key: "dp1Root", folder: "Deadly Premonition The Director's Cut", label: t("set.games.dp1"), value: dp1Root, setter: setDp1Root, placeholder: "…\\steamapps\\common\\Deadly Premonition The Director's Cut" },
                { key: "hbrRoot", folder: "HOTEL BARCELONA",                       label: t("set.games.hbr"), value: hbrRoot, setter: setHbrRoot, placeholder: "…\\steamapps\\common\\HOTEL BARCELONA" },
              ] as const).map((g) => (
                <div key={g.key}>
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-[11.5px] font-semibold text-[var(--text-strong)]">{g.label}</span>
                    {detectStatus[g.key] && (
                      <span className="text-[10.5px] text-[var(--text-faint)] truncate ml-2" title={detectStatus[g.key]}>
                        {detectStatus[g.key]}
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-2">
                    <input
                      className="dp-input flex-1 min-w-0 font-mono text-[11px]"
                      value={g.value}
                      placeholder={g.placeholder}
                      readOnly
                      onClick={() => pickGameRoot(g.key, g.setter)}
                    />
                    <button
                      className="dp-btn shrink-0 !text-[11px]"
                      onClick={() => autoDetectGameRoot(g.key, g.folder, g.setter)}
                      title={t("set.games.autoBtnHint")}
                    >
                      {t("set.games.autoBtn")}
                    </button>
                    <button
                      className="dp-btn shrink-0 !text-[11px]"
                      onClick={() => pickGameRoot(g.key, g.setter)}
                    >
                      {t("set.games.pickBtn")}
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </section>

          {/* Autosave (crash-recovery) */}
          <section className="pt-3 border-t border-[var(--border-soft)]">
            <label className="text-[11px] font-semibold uppercase tracking-wider text-[var(--text-muted)] block mb-1.5">
              {t("set.autosave.label")}
            </label>
            <p className="text-[11px] text-[var(--text-faint)] mb-2 leading-relaxed">
              {t("set.autosave.hint")}
            </p>
            <div className="flex flex-col gap-3">
              <div>
                <span className="text-[11px] text-[var(--text-muted)] block mb-1">{t("set.autosave.dirLabel")}</span>
                <div className="flex items-center gap-2">
                  <input
                    className="dp-input flex-1 min-w-0 font-mono text-[11px]"
                    value={autosaveDir}
                    placeholder={t("set.autosave.dirPlaceholder")}
                    readOnly
                    onClick={async () => {
                      const p = await window.dp2.pickFolder({ title: t("set.autosave.pickTitle") });
                      if (p) {
                        setAutosaveDir(p);
                        await window.dp2.saveSettings({ autosaveDir: p } as Record<string, unknown>);
                      }
                    }}
                  />
                  <button
                    className="dp-btn shrink-0 !text-[11px]"
                    onClick={async () => {
                      const p = await window.dp2.pickFolder({ title: t("set.autosave.pickTitle") });
                      if (p) {
                        setAutosaveDir(p);
                        await window.dp2.saveSettings({ autosaveDir: p } as Record<string, unknown>);
                      }
                    }}
                  >
                    {t("set.autosave.pickBtn")}
                  </button>
                  <button
                    className="dp-btn dp-btn--ghost shrink-0 !text-[11px]"
                    disabled={!autosaveDir}
                    onClick={async () => {
                      setAutosaveDir("");
                      await window.dp2.saveSettings({ autosaveDir: "" } as Record<string, unknown>);
                    }}
                    title={t("set.autosave.clearHint")}
                  >
                    {t("set.autosave.clearBtn")}
                  </button>
                </div>
              </div>
              <div>
                <span className="text-[11px] text-[var(--text-muted)] block mb-1">{t("set.autosave.intervalLabel")}</span>
                <div className="flex items-center gap-2">
                  <input
                    type="number"
                    min={0.25}
                    max={60}
                    step={0.25}
                    className="dp-input w-28 tabular-nums"
                    value={autosaveIntervalMin}
                    onChange={(e) => {
                      const v = parseFloat(e.target.value);
                      if (!isFinite(v)) return;
                      const clamped = Math.max(0.25, Math.min(60, v));
                      setAutosaveIntervalMin(clamped);
                    }}
                    onBlur={async () => {
                      await window.dp2.saveSettings({ autosaveIntervalMin } as Record<string, unknown>);
                    }}
                  />
                  <span className="text-[11px] text-[var(--text-muted)]">{t("set.autosave.intervalUnit")}</span>
                </div>
              </div>
            </div>
          </section>

          {/* Updates */}
          <section className="pt-3 border-t border-[var(--border-soft)]">
            <label className="text-[11px] font-semibold uppercase tracking-wider text-[var(--text-muted)] block mb-2">
              {t("set.update.label")}
            </label>
            <div className="rounded-lg border border-[var(--border-soft)] bg-[var(--bg)] p-4 flex flex-col gap-3">
              <div className="flex items-center gap-3 flex-wrap">
                {/* Status indicator + version */}
                <div className="flex items-center gap-2.5 flex-1 min-w-0">
                  <span
                    className={`flex h-9 w-9 items-center justify-center rounded-full border ${
                      updateResult?.available
                        ? "bg-[var(--accent)]/15 border-[var(--accent)]/50 text-[var(--accent)]"
                        : updateResult && !updateResult.error
                          ? "bg-[var(--success)]/15 border-[var(--success)]/50 text-[var(--success)]"
                          : "bg-[var(--bg-elevated)] border-[var(--border-soft)] text-[var(--text-muted)]"
                    }`}
                  >
                    {updateResult?.available ? (
                      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m0 0l-6-6m6 6l6-6" />
                      </svg>
                    ) : updateResult && !updateResult.error ? (
                      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                      </svg>
                    ) : (
                      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M12 8v4l3 2m6-2a9 9 0 11-18 0 9 9 0 0118 0z" />
                      </svg>
                    )}
                  </span>
                  <div className="flex flex-col min-w-0">
                    <span className="text-[13px] font-semibold text-[var(--text-strong)] tabular-nums">
                      v{appVer}
                    </span>
                    <span className="text-[11px] text-[var(--text-muted)] truncate">
                      {updateResult?.error
                        ? <span className="text-[var(--danger)]" title={updateResult.error}>{t("set.update.errLabel")}</span>
                        : updateResult
                          ? (updateResult.available
                              ? t("set.update.found", { latest: updateResult.latest ?? "?", current: updateResult.current })
                              : t("set.update.uptodate", { current: updateResult.current }))
                          : t("set.update.hint")}
                    </span>
                  </div>
                </div>

                {/* Actions */}
                <div className="flex items-center gap-2 shrink-0">
                  {updateResult && !updateResult.error && updateResult.available && updateResult.htmlUrl && (
                    <button
                      className="dp-btn dp-btn--primary"
                      onClick={() => window.dp2.openExternal(updateResult.htmlUrl!)}
                    >
                      {t("set.update.openRelease", { ver: updateResult.latest ?? "?" })}
                    </button>
                  )}
                  <button className="dp-btn" onClick={checkUpdate} disabled={updateBusy}>
                    {updateBusy ? t("set.update.checking") : t("set.update.checkBtn")}
                  </button>
                </div>
              </div>

              {/* Dev row — приховано-стримана, у нижній лінії */}
              <div className="flex items-center justify-between pt-2 border-t border-[var(--border-soft)]">
                <span className="text-[10px] uppercase tracking-wider text-[var(--text-faint)]">
                  {t("set.update.devLabel")}
                </span>
                <button
                  type="button"
                  className="text-[11px] text-[var(--text-muted)] hover:text-[var(--text)] underline underline-offset-2"
                  onClick={simulateBanner}
                  title={t("set.update.simulateHint")}
                >
                  {t("set.update.simulate")}
                </button>
              </div>
            </div>
          </section>

        </div>

        <footer className="px-5 py-3 border-t border-[var(--border-soft)] flex justify-end">
          <button className="dp-btn dp-btn--primary" onClick={onClose}>{t("btn.done")}</button>
        </footer>
      </div>
    </div>
  );
}
