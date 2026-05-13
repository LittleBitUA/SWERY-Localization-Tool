import { useEffect, useState } from "react";
import { useT, getLang, setLang, type Lang } from "../lib/i18n";
import { useLocalStorage } from "../lib/useLocalStorage";
import { WrapToggle, type WrapMode } from "./WrapToggle";

interface Props {
  open: boolean;
  onClose: () => void;
}

type Tab = "paths" | "display";

export function SettingsModal({ open, onClose }: Props) {
  const t = useT();
  const [tab, setTab] = useState<Tab>("paths");

  // Paths
  const [uabeaPath, setUabeaPath] = useState("");
  const [assetsPath, setAssetsPath] = useState("");
  const [pwshPath, setPwshPath] = useState("");
  const [saving, setSaving] = useState(false);

  // Display
  const [wrapMode, setWrapMode] = useLocalStorage<WrapMode>("dp2.ui.tableWrap", "default");
  const [lang, setLangState] = useState<Lang>(getLang());

  useEffect(() => {
    if (!open) return;
    window.dp2.getSettings().then((s: any) => {
      setUabeaPath(s.uabeaPath ?? "");
      setAssetsPath(s.assetsPath ?? "");
      setPwshPath(s.pwshPath ?? "");
    });
    setLangState(getLang());
  }, [open]);

  if (!open) return null;

  async function pickUabea() {
    const p = await window.dp2.pickFile({
      title: "UABEANext4.Desktop.exe",
      filters: [{ name: "Executable", extensions: ["exe"] }],
    });
    if (p) setUabeaPath(p);
  }
  async function pickAssets() {
    const p = await window.dp2.pickFile({
      title: ".assets (sharedassets0.assets)",
      filters: [{ name: "Unity assets", extensions: ["assets"] }],
    });
    if (p) setAssetsPath(p);
  }
  async function pickPwsh() {
    const p = await window.dp2.pickFile({
      title: "pwsh.exe",
      filters: [{ name: "Executable", extensions: ["exe"] }],
    });
    if (p) setPwshPath(p);
  }

  async function save() {
    setSaving(true);
    await window.dp2.saveSettings({ uabeaPath, assetsPath, pwshPath });
    setSaving(false);
    onClose();
  }

  function changeLang(l: Lang) {
    setLang(l);
    setLangState(l);
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-6 bg-black/60" onClick={onClose}>
      <div className="dp-card w-full max-w-xl flex flex-col" onClick={(e) => e.stopPropagation()}>
        <div className="px-5 py-3 border-b border-[var(--border-soft)] flex items-center justify-between">
          <h2 className="text-[15px] font-semibold text-[var(--text-strong)]">{t("set.title")}</h2>
          <button onClick={onClose} className="dp-btn dp-btn--ghost !w-7 !p-0">
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Tabs */}
        <div className="px-5 pt-3 border-b border-[var(--border-soft)] flex gap-1">
          <button
            className={`px-3 py-1.5 text-[12px] font-semibold border-b-2 -mb-px transition-colors ${
              tab === "paths"
                ? "text-[var(--text-strong)] border-[var(--accent)]"
                : "text-[var(--text-muted)] border-transparent hover:text-[var(--text)]"
            }`}
            onClick={() => setTab("paths")}
          >
            {t("set.tab.paths")}
          </button>
          <button
            className={`px-3 py-1.5 text-[12px] font-semibold border-b-2 -mb-px transition-colors ${
              tab === "display"
                ? "text-[var(--text-strong)] border-[var(--accent)]"
                : "text-[var(--text-muted)] border-transparent hover:text-[var(--text)]"
            }`}
            onClick={() => setTab("display")}
          >
            {t("set.tab.display")}
          </button>
        </div>

        {/* Content */}
        <div className="p-5 space-y-4 max-h-[60vh] overflow-y-auto">
          {tab === "paths" && (
            <>
              <div>
                <label className="text-[11px] font-semibold uppercase tracking-wider text-[var(--text-muted)] block mb-1.5">
                  {t("set.uabea.label")}
                </label>
                <div className="flex gap-2">
                  <input
                    className="dp-input flex-1"
                    value={uabeaPath}
                    onChange={(e) => setUabeaPath(e.target.value)}
                    placeholder="E:\Localization\DP2\UABEA\UABEANext4.Desktop.exe"
                  />
                  <button onClick={pickUabea} className="dp-btn">{t("set.browse")}</button>
                </div>
                <p className="text-[11px] text-[var(--text-faint)] mt-1.5 leading-relaxed">{t("set.uabea.hint")}</p>
              </div>

              <div>
                <label className="text-[11px] font-semibold uppercase tracking-wider text-[var(--text-muted)] block mb-1.5">
                  {t("set.assets.label")}
                </label>
                <div className="flex gap-2">
                  <input
                    className="dp-input flex-1"
                    value={assetsPath}
                    onChange={(e) => setAssetsPath(e.target.value)}
                    placeholder="E:\SteamLibrary\...\DeadlyPremonition2_Data\sharedassets0.assets"
                  />
                  <button onClick={pickAssets} className="dp-btn">{t("set.browse")}</button>
                </div>
                <p className="text-[11px] text-[var(--text-faint)] mt-1.5 leading-relaxed">{t("set.assets.hint")}</p>
              </div>

              <div>
                <label className="text-[11px] font-semibold uppercase tracking-wider text-[var(--text-muted)] block mb-1.5">
                  {t("set.pwsh.label")}
                </label>
                <div className="flex gap-2">
                  <input
                    className="dp-input flex-1"
                    value={pwshPath}
                    onChange={(e) => setPwshPath(e.target.value)}
                    placeholder="C:\Program Files\PowerShell\7\pwsh.exe"
                  />
                  <button onClick={pickPwsh} className="dp-btn">{t("set.browse")}</button>
                </div>
                <p className="text-[11px] text-[var(--text-faint)] mt-1.5 leading-relaxed">{t("set.pwsh.hint")}</p>
              </div>
            </>
          )}

          {tab === "display" && (
            <>
              <div>
                <label className="text-[11px] font-semibold uppercase tracking-wider text-[var(--text-muted)] block mb-1.5">
                  {t("set.display.lang")}
                </label>
                <div className="inline-flex rounded-md border border-[var(--border-soft)] overflow-hidden">
                  <button
                    className={`px-4 py-1.5 text-[12px] font-semibold uppercase ${
                      lang === "uk"
                        ? "bg-[var(--accent)] text-white"
                        : "text-[var(--text-muted)] hover:bg-[var(--row-hover)]"
                    }`}
                    onClick={() => changeLang("uk")}
                  >
                    UK · Українська
                  </button>
                  <button
                    className={`px-4 py-1.5 text-[12px] font-semibold uppercase ${
                      lang === "en"
                        ? "bg-[var(--accent)] text-white"
                        : "text-[var(--text-muted)] hover:bg-[var(--row-hover)]"
                    }`}
                    onClick={() => changeLang("en")}
                  >
                    EN · English
                  </button>
                </div>
                <p className="text-[11px] text-[var(--text-faint)] mt-1.5 leading-relaxed">
                  {t("set.display.langHint")}
                </p>
              </div>

              <div className="pt-2 border-t border-[var(--border-soft)]">
                <label className="text-[11px] font-semibold uppercase tracking-wider text-[var(--text-muted)] block mb-1.5">
                  {t("set.display.wrap")}
                </label>
                <WrapToggle value={wrapMode} onChange={setWrapMode} />
                <p className="text-[11px] text-[var(--text-faint)] mt-1.5 leading-relaxed">
                  {t("set.display.wrapHint")}
                </p>
              </div>
            </>
          )}
        </div>

        <div className="px-5 py-3 border-t border-[var(--border-soft)] flex items-center justify-end gap-2">
          <button onClick={onClose} className="dp-btn">{t("btn.cancel")}</button>
          <button onClick={save} className="dp-btn dp-btn--primary" disabled={saving || tab !== "paths"}>
            {saving ? t("set.saving") : t("btn.save")}
          </button>
        </div>
      </div>
    </div>
  );
}
