import { useEffect, useState } from "react";
import { useT } from "../lib/i18n";

interface Props {
  open: boolean;
  onClose: () => void;
}

export function SettingsModal({ open, onClose }: Props) {
  const t = useT();
  const [uabeaPath, setUabeaPath] = useState("");
  const [assetsPath, setAssetsPath] = useState("");
  const [pwshPath, setPwshPath] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    window.dp2.getSettings().then((s: any) => {
      setUabeaPath(s.uabeaPath ?? "");
      setAssetsPath(s.assetsPath ?? "");
      setPwshPath(s.pwshPath ?? "");
    });
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
      title: ".assets файл (sharedassets0.assets)",
      filters: [{ name: "Unity assets", extensions: ["assets"] }],
    });
    if (p) setAssetsPath(p);
  }

  async function pickPwsh() {
    const p = await window.dp2.pickFile({
      title: "pwsh.exe (PowerShell 7+)",
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

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-6 bg-black/60" onClick={onClose}>
      <div className="dp-card w-full max-w-xl p-5" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-[16px] font-semibold text-[var(--text-strong)]">{t("set.title")}</h2>
          <button onClick={onClose} className="dp-btn dp-btn--ghost !w-7 !p-0">
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="space-y-4">
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
        </div>

        <div className="mt-5 pt-4 border-t border-[var(--border-soft)] flex items-center justify-end gap-2">
          <button onClick={onClose} className="dp-btn">{t("btn.cancel")}</button>
          <button onClick={save} className="dp-btn dp-btn--primary" disabled={saving}>
            {saving ? t("set.saving") : t("btn.save")}
          </button>
        </div>
      </div>
    </div>
  );
}
