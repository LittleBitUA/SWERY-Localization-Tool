import { useEffect, useState } from "react";
import { useT } from "../../lib/i18n";

interface Dp1Settings {
  dp1ToolPath?: string;
  dp1GameDir?: string;
  dp1EngPath?: string;
}

interface Dp1SettingsModalProps {
  open: boolean;
  onClose: () => void;
}

export function Dp1SettingsModal({ open, onClose }: Dp1SettingsModalProps) {
  const t = useT();
  const [s, setS] = useState<Dp1Settings>({});

  useEffect(() => {
    if (!open) return;
    window.dp2.getSettings().then((x) => setS(x as any));
  }, [open]);

  if (!open) return null;

  async function pickTool() {
    const f = await window.dp2.pickFile({
      title: t("dp1.pickDpmsg.title"),
      filters: [{ name: "Executables", extensions: ["exe"] }],
    });
    if (f) setS((p) => ({ ...p, dp1ToolPath: f }));
  }

  async function pickGameDir() {
    const f = await window.dp2.pickFolder();
    if (f) setS((p) => ({ ...p, dp1GameDir: f }));
  }

  async function save() {
    await window.dp2.saveSettings(s as any);
    onClose();
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onClose}>
      <div className="dp-card w-[640px] max-w-full" onClick={(e) => e.stopPropagation()}>
        <header className="px-5 py-3 border-b border-[var(--border-soft)] flex items-center justify-between">
          <h2 className="text-[15px] font-semibold text-[var(--text-strong)]">{t("dp1.set.title")}</h2>
        </header>
        <div className="p-5 space-y-4">
          <section>
            <label className="text-[11px] font-semibold uppercase tracking-wider text-[var(--text-muted)] block mb-1.5">
              {t("dp1.set.toolLabel")}
            </label>
            <p className="text-[11.5px] text-[var(--text-faint)] mb-2">{t("dp1.set.toolHint")}</p>
            <div className="flex gap-2">
              <input
                className="dp-input flex-1 font-mono text-[12px]"
                value={s.dp1ToolPath ?? ""}
                onChange={(e) => setS((p) => ({ ...p, dp1ToolPath: e.target.value }))}
                placeholder="…\DPMsgTool.exe"
              />
              <button className="dp-btn" onClick={pickTool}>{t("onb.btn.pickFile")}</button>
            </div>
          </section>

          <section>
            <label className="text-[11px] font-semibold uppercase tracking-wider text-[var(--text-muted)] block mb-1.5">
              {t("dp1.set.gameLabel")}
            </label>
            <p className="text-[11.5px] text-[var(--text-faint)] mb-2">{t("dp1.set.gameHint")}</p>
            <div className="flex gap-2">
              <input
                className="dp-input flex-1 font-mono text-[12px]"
                value={s.dp1GameDir ?? ""}
                onChange={(e) => setS((p) => ({ ...p, dp1GameDir: e.target.value }))}
                placeholder="…\Deadly Premonition The Director's Cut\updata_eu\_us\message\output"
              />
              <button className="dp-btn" onClick={pickGameDir}>{t("onb.btn.pickFolder")}</button>
            </div>
          </section>

          <section>
            <label className="text-[11px] font-semibold uppercase tracking-wider text-[var(--text-muted)] block mb-1.5">
              {t("dp1.set.engLabel")}
            </label>
            <p className="text-[11.5px] text-[var(--text-faint)] mb-2">{t("dp1.set.engHint")}</p>
            <div className="flex gap-2">
              <input
                className="dp-input flex-1 font-mono text-[12px]"
                value={s.dp1EngPath ?? ""}
                onChange={(e) => setS((p) => ({ ...p, dp1EngPath: e.target.value }))}
                placeholder="…\eng.json"
              />
              <button
                className="dp-btn"
                onClick={async () => {
                  const f = await window.dp2.pickFile({
                    title: t("dp1.empty.pickBtn"),
                    filters: [{ name: "JSON", extensions: ["json"] }],
                  });
                  if (f) setS((p) => ({ ...p, dp1EngPath: f }));
                }}
              >
                {t("onb.btn.pickFile")}
              </button>
            </div>
          </section>
        </div>
        <footer className="px-5 py-3 border-t border-[var(--border-soft)] flex items-center justify-end gap-2">
          <button className="dp-btn" onClick={onClose}>{t("btn.cancel")}</button>
          <button className="dp-btn dp-btn--primary" onClick={save}>{t("btn.save")}</button>
        </footer>
      </div>
    </div>
  );
}
