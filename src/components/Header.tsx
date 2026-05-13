import { useState } from "react";
import { useStore } from "../lib/store";
import { SettingsModal } from "./SettingsModal";
import { LogViewer } from "./LogViewer";
import { CorpusStatsModal } from "./CorpusStatsModal";
import { GlossaryConsistencyModal } from "./GlossaryConsistencyModal";
import { useT } from "../lib/i18n";

interface HeaderProps {
  onFindReplace?: () => void;
  onGlobalSearch?: () => void;
  onOpenGlossary?: () => void;
  onToggleTm?: () => void;
  tmVisible?: boolean;
  focusMode?: boolean;
  onToggleFocus?: () => void;
  onHome?: () => void;
}

export function Header({
  onFindReplace,
  onGlobalSearch,
  onOpenGlossary,
  onToggleTm,
  tmVisible,
  focusMode,
  onToggleFocus,
  onHome,
}: HeaderProps = {}) {
  const t = useT();
  const folder = useStore((s) => s.folder);
  const dirty = useStore((s) => s.dirty);
  const saveFile = useStore((s) => s.saveFile);
  const selectedFilePath = useStore((s) => s.selectedFilePath);
  const lastAutosaveAt = useStore((s) => s.lastAutosaveAt);

  const [settingsOpen, setSettingsOpen] = useState(false);
  const [statsOpen, setStatsOpen] = useState(false);
  const [gcOpen, setGcOpen] = useState(false);
  const [logOpen, setLogOpen] = useState(false);
  const [lastLog, setLastLog] = useState("");
  const [lastLogPath, setLastLogPath] = useState<string | undefined>(undefined);
  const [buildState, setBuildState] = useState<"idle" | "building" | "done" | "error">("idle");
  const [buildMsg, setBuildMsg] = useState("");

  const folderShort = folder ? folder.split(/[\\/]/).slice(-2).join("/") : "—";

  async function saveAndBuild() {
    setBuildState("building");
    setBuildMsg("Зберігаю JSON-и...");
    try {
      if (dirty) await saveFile();
    } catch (e) {
      setBuildState("error");
      setBuildMsg("Не вдалося зберегти JSON: " + String(e));
      setTimeout(() => setBuildState("idle"), 5000);
      return;
    }
    setBuildMsg("Пакую .assets... (це може зайняти хвилину)");
    const res = await window.dp2.buildAssets();
    setLastLog(res.log || "");
    setLastLogPath(res.logPath);
    if (!res.success) {
      setBuildState("error");
      setBuildMsg(res.error || "Збірка не вдалась");
      setTimeout(() => setBuildState("idle"), 12000);
      return;
    }
    setBuildState("done");
    setBuildMsg(`Готово → ${res.outputPath}`);
    setTimeout(() => setBuildState("idle"), 12000);
  }

  return (
    <>
      <header className="flex items-center gap-3 px-4 h-12 border-b border-[var(--border-soft)] bg-[var(--bg-surface)]">
        {onHome && (
          <button
            className="dp-btn dp-btn--ghost"
            onClick={onHome}
            title={t("header.home")}
          >
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6" />
            </svg>
          </button>
        )}
        <div className="flex items-center gap-2.5">
          <span className="text-[13px] text-[var(--text-muted)]">{t("header.dp2.product")}</span>
        </div>

        {folder && (
          <div className="flex items-center gap-2 text-[12px] text-[var(--text-faint)] ml-3 min-w-0">
            <svg className="w-3.5 h-3.5 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V7z" />
            </svg>
            <span className="font-mono truncate">{folderShort}</span>
          </div>
        )}

        <div className="flex-1" />

        {buildState !== "idle" && (
          <span
            className={`text-[11px] font-mono px-2.5 py-1 rounded ${
              buildState === "error"
                ? "dp-pill--danger"
                : buildState === "done"
                ? "dp-pill--success"
                : "dp-pill"
            }`}
          >
            {buildMsg}
          </span>
        )}

        {lastLog && (
          <button
            className="dp-btn dp-btn--ghost"
            onClick={() => setLogOpen(true)}
            title={t("header.log")}
          >
            {t("header.log")}
          </button>
        )}

        <button
          className="dp-btn dp-btn--ghost"
          onClick={() => setStatsOpen(true)}
          title={t("stats.btn")}
          disabled={!folder}
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M9 19V9m4 10V5m4 14v-6M5 19h14" />
          </svg>
        </button>

        <button className="dp-btn dp-btn--ghost" onClick={() => setSettingsOpen(true)} title={t("header.settings")}>
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
            <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
          </svg>
        </button>

        {onGlobalSearch && (
          <button className="dp-btn" onClick={onGlobalSearch} title="Ctrl+Shift+F">
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
            </svg>
            {t("header.find")}
          </button>
        )}

        {onFindReplace && (
          <button className="dp-btn" onClick={onFindReplace} title="Ctrl+H">
            {t("header.replace")}
          </button>
        )}

        {onOpenGlossary && (
          <button className="dp-btn dp-btn--ghost" onClick={onOpenGlossary} title="Ctrl+G">
            {t("header.glossary")}
          </button>
        )}

        <button
          className="dp-btn dp-btn--ghost"
          onClick={() => setGcOpen(true)}
          title={t("gc.btn")}
          disabled={!folder}
        >
          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
        </button>

        {onToggleTm && (
          <button
            className={`dp-btn ${tmVisible ? "dp-btn--primary" : ""}`}
            onClick={onToggleTm}
            title="Ctrl+Shift+T"
          >
            {t("header.tm")}
          </button>
        )}

        {onToggleFocus && (
          <button
            className={`dp-btn ${focusMode ? "dp-btn--primary" : ""}`}
            onClick={onToggleFocus}
            title="Ctrl+\\"
          >
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M4 4h6v2H6v4H4V4zm10 0h6v6h-2V6h-4V4zM4 14h2v4h4v2H4v-6zm16 0h-2v4h-4v2h6v-6z" />
            </svg>
            {t("header.focus")}
          </button>
        )}

        {dirty && lastAutosaveAt && (
          <span
            className="text-[10.5px] text-[var(--text-faint)] tabular-nums whitespace-nowrap"
            title={t("autosave.savedAt", {
              time: new Date(lastAutosaveAt).toLocaleTimeString(),
            })}
          >
            ● {t("autosave.saved")}
          </span>
        )}

        <button
          className="dp-btn"
          disabled={!dirty || !selectedFilePath}
          onClick={() => saveFile()}
          title="Ctrl+S"
        >
          {dirty ? t("header.save") : t("header.saved")}
        </button>

        <button
          className="dp-btn dp-btn--success"
          disabled={!folder || buildState === "building"}
          onClick={saveAndBuild}
          title={t("header.buildAndSave")}
        >
          {t("header.buildAndSave")}
        </button>
      </header>

      <SettingsModal open={settingsOpen} onClose={() => setSettingsOpen(false)} />
      <CorpusStatsModal
        open={statsOpen}
        onClose={() => setStatsOpen(false)}
        mode="dp2"
        folder={folder}
      />
      <GlossaryConsistencyModal open={gcOpen} onClose={() => setGcOpen(false)} />
      <LogViewer
        open={logOpen}
        onClose={() => setLogOpen(false)}
        log={lastLog}
        logPath={lastLogPath}
      />
    </>
  );
}
