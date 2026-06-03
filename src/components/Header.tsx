import { useState } from "react";
import { useStore } from "../lib/store";
// SettingsModal: тільки Display-таб (шляхи — у onboarding). Тримаємо щоб
// користувач міг перемикати wrap-mode таблиці й мову UI.
import { SettingsModal } from "./SettingsModal";
import { LogViewer } from "./LogViewer";
import { CorpusStatsModal } from "./CorpusStatsModal";
import { Dp2OthersModal } from "../games/dp2/Dp2OthersModal";
import { GlossaryConsistencyModal } from "./GlossaryConsistencyModal";
import { NameConsistencyModal } from "./NameConsistencyModal";
import { useT } from "../lib/i18n";
import { confirm as showConfirm, alert as showAlert } from "../lib/dialogs";
import { showToast, dismissToast } from "./Toast";
import { SaveStatusBadge } from "./SaveStatusBadge";
import { LangToggle } from "./LangToggle";

interface HeaderProps {
  onFindReplace?: () => void;
  onGlobalSearch?: () => void;
  onBatchReplace?: () => void;
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
  onBatchReplace,
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
  const lastSaveError = useStore((s) => s.lastSaveError);
  const previewTmExact = useStore((s) => s.previewTmExact);
  const applyTmExact = useStore((s) => s.applyTmExact);

  const [settingsOpen, setSettingsOpen] = useState(false);
  const [statsOpen, setStatsOpen] = useState(false);
  const [othersOpen, setOthersOpen] = useState(false);
  const [gcOpen, setGcOpen] = useState(false);
  const [ncOpen, setNcOpen] = useState(false);
  const [tmApplying, setTmApplying] = useState(false);
  const [logOpen, setLogOpen] = useState(false);
  const [lastLog, setLastLog] = useState("");
  const [lastLogPath, setLastLogPath] = useState<string | undefined>(undefined);
  const [buildState, setBuildState] = useState<"idle" | "building">("idle");

  const folderShort = folder ? folder.split(/[\\/]/).slice(-2).join("/") : "—";

  /** "Драбинка усього" — застосовує smart-break до кожного перекладеного
   *  рядка у всіх файлах. Спершу dry-run (скільки змінить), confirm, apply. */
  async function smartBreakAll() {
    if (!folder) return;
    try {
      const dry = await window.dp2.smartBreakAllWorker({ folder, opts: { dryRun: true } });
      if (dry.totalChanges === 0) {
        await showAlert(t("breakAll.noneTitle"), t("breakAll.noneBody"));
        return;
      }
      const ok = await showConfirm(
        t("breakAll.confirmTitle"),
        t("breakAll.confirmBody", {
          changes: dry.totalChanges,
          files: dry.files.length,
        }),
        { tone: "danger", okLabel: t("breakAll.applyBtn") }
      );
      if (!ok) return;
      const res = await window.dp2.smartBreakAllWorker({ folder, opts: { dryRun: false } });
      // Перевантажити поточний файл якщо був серед змінених
      if (selectedFilePath && res.files.some((f) => f.path === selectedFilePath)) {
        const reload = useStore.getState().loadFile;
        await reload(selectedFilePath);
      }
      await showAlert(
        t("breakAll.doneTitle"),
        t("breakAll.doneBody", { changes: res.totalChanges, files: res.files.length }),
        { tone: "success" }
      );
    } catch (e: any) {
      await showAlert(t("dialog.error"), String(e?.message ?? e));
    }
  }

  /** TM auto-fill 1:1: вантажить TM з обох ігор, шукає exact-збіги для поточного
   *  файла, показує підтвердження зі скільки → застосовує. Жодних substring. */
  async function tmAutofill() {
    if (!folder || !selectedFilePath) return;
    setTmApplying(true);
    try {
      const tm = await window.dp2.buildTmWorker({
        dp2Folder: folder,
      });
      const { matches } = previewTmExact(tm);
      if (matches.length === 0) {
        await showAlert(t("tmFill.noneTitle"), t("tmFill.noneBody"));
        return;
      }
      // Показуємо до 5 прикладів у тілі підтвердження.
      const examples = matches.slice(0, 5)
        .map((m) => `• ${m.src.slice(0, 60)}${m.src.length > 60 ? "…" : ""} → ${m.tgt.slice(0, 60)}${m.tgt.length > 60 ? "…" : ""}`)
        .join("\n");
      const ok = await showConfirm(
        t("tmFill.confirmTitle"),
        t("tmFill.confirmBody", { n: matches.length }) + "\n\n" + examples
          + (matches.length > 5 ? "\n\n…" : ""),
        { tone: "default", okLabel: t("tmFill.applyBtn") }
      );
      if (!ok) return;
      const applied = applyTmExact(tm);
      await showAlert(t("tmFill.doneTitle"), t("tmFill.doneBody", { n: applied }), { tone: "success" });
    } catch (e: any) {
      await showAlert(t("dialog.error"), String(e?.message ?? e));
    } finally {
      setTmApplying(false);
    }
  }

  async function saveAndBuild() {
    setBuildState("building");
    // Прогрес-повідомлення йдуть як toast у правому нижньому куті.
    let progressId = showToast(t("build.toast.savingJson"), { tone: "info", durationMs: 0 });
    try {
      if (dirty) await saveFile();
    } catch (e) {
      dismissToast(progressId);
      setBuildState("idle");
      showToast(t("build.toast.saveFailed", { err: String(e) }), {
        tone: "error", title: t("dialog.error"), durationMs: 8000,
      });
      return;
    }
    dismissToast(progressId);
    progressId = showToast(t("build.toast.packing"), { tone: "info", durationMs: 0 });
    const res = await window.dp2.buildAssets();
    dismissToast(progressId);
    setLastLog(res.log || "");
    setLastLogPath(res.logPath);
    setBuildState("idle");
    if (!res.success) {
      showToast(res.error || t("build.toast.buildFailed"), {
        tone: "error", title: t("build.toast.buildFailedTitle"), durationMs: 12000,
      });
      return;
    }
    // Фаза 2 — UILabel («Інші рядки»). Не валить успіх корпусу, але якщо вона
    // зафейлилась — варто попередити, бо це окремий .assets-файл.
    const others = res.others;
    let extraMsg = "";
    if (others) {
      if (others.skipped) {
        // тихо — нічого не було пакувати
      } else if (!others.ok) {
        extraMsg = `\n⚠️ UILabel-пакування зафейлилось: ${others.error ?? "?"}${others.logPath ? `\nЛог: ${others.logPath}` : ""}`;
      } else if (others.summary?.imported) {
        extraMsg = `\n+ UILabel: ${others.summary.imported} рядків у sharedassets1.assets`;
      }
    }
    showToast(t("build.toast.done", { path: res.outputPath ?? "" }) + extraMsg, {
      tone: others && !others.ok && !others.skipped ? "warning" : "success",
      title: t("build.toast.doneTitle"),
      durationMs: 14000,
    });
  }

  return (
    <>
      <header className="flex items-stretch px-3 py-1.5 min-h-12 border-b border-[var(--border-soft)] bg-[var(--bg-surface)] gap-2">
        {/* LEFT + MIDDLE — гнучке, може wrap-итись внутрішньо */}
        <div className="flex flex-wrap items-center gap-2 flex-1 min-w-0">
        {onHome && (
          <button
            className="dp-btn dp-btn--ghost shrink-0"
            onClick={onHome}
            title={t("header.home")}
          >
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6" />
            </svg>
          </button>
        )}
        <div className="hidden 2xl:flex items-center gap-2.5 shrink-0">
          <span className="text-[13px] text-[var(--text-muted)]">{t("header.dp2.product")}</span>
        </div>

        {folder && (
          <div className="hidden md:flex items-center gap-2 text-[12px] text-[var(--text-faint)] ml-1 min-w-0 max-w-[240px]">
            <svg className="w-3.5 h-3.5 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V7z" />
            </svg>
            <span className="font-mono truncate">{folderShort}</span>
          </div>
        )}

        <div className="flex-1 min-w-0" />

        {/* Build status тепер показується як toast у правому нижньому куті — див. showToast у saveAndBuild() */}

        {lastLog && (
          <button
            className="dp-btn dp-btn--ghost shrink-0"
            onClick={() => setLogOpen(true)}
            title={t("header.log")}
          >
            {t("header.log")}
          </button>
        )}

        <button
          className="dp-btn dp-btn--ghost shrink-0"
          onClick={() => setOthersOpen(true)}
          title="Переклад інших рядків — додатковий staging-корпус (DP2/Others)"
          disabled={!folder}
        >
          📥 <span className="hidden 2xl:inline ml-1">Інші рядки</span>
        </button>

        <button
          className="dp-btn dp-btn--ghost shrink-0"
          onClick={() => setStatsOpen(true)}
          title={t("stats.btn")}
          disabled={!folder}
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M9 19V9m4 10V5m4 14v-6M5 19h14" />
          </svg>
        </button>

        <LangToggle compact />

        <button className="dp-btn dp-btn--ghost shrink-0" onClick={() => setSettingsOpen(true)} title={t("header.settings")}>
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
            <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
          </svg>
        </button>

        {onGlobalSearch && (
          <button className="dp-btn shrink-0" onClick={onGlobalSearch} title={t("header.find") + " · Ctrl+Shift+F"}>
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
            </svg>
            <span className="hidden xl:inline">{t("header.find")}</span>
          </button>
        )}

        {onFindReplace && (
          <button className="dp-btn shrink-0" onClick={onFindReplace} title={t("header.replace") + " · Ctrl+H"}>
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
            </svg>
            <span className="hidden xl:inline">{t("header.replace")}</span>
          </button>
        )}

        {onBatchReplace && (
          <button
            className="dp-btn dp-btn--ghost shrink-0"
            onClick={onBatchReplace}
            title={t("br.btn")}
            disabled={!folder}
          >
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
            </svg>
          </button>
        )}

        {onOpenGlossary && (
          <button
            className="dp-btn dp-btn--ghost shrink-0"
            onClick={onOpenGlossary}
            title={t("header.glossary") + " · Ctrl+G"}
          >
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253" />
            </svg>
            <span className="hidden xl:inline">{t("header.glossary")}</span>
          </button>
        )}

        <button
          className="dp-btn dp-btn--ghost shrink-0"
          onClick={() => setGcOpen(true)}
          title={t("gc.btn")}
          disabled={!folder}
        >
          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
        </button>

        <button
          className="dp-btn dp-btn--ghost shrink-0"
          onClick={() => setNcOpen(true)}
          title={t("nc.btn")}
          disabled={!folder}
        >
          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
          </svg>
        </button>

        <button
          className="dp-btn dp-btn--ghost shrink-0"
          onClick={tmAutofill}
          title={t("tmFill.btn")}
          disabled={!folder || !selectedFilePath || tmApplying}
        >
          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M13 10V3L4 14h7v7l9-11h-7z" />
          </svg>
        </button>

        <button
          className="dp-btn dp-btn--ghost shrink-0"
          onClick={smartBreakAll}
          title={t("breakAll.btn")}
          disabled={!folder}
        >
          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M3 12h13M3 6h17M3 18h9" />
          </svg>
        </button>

        {onToggleTm && (
          <button
            className={`dp-btn shrink-0 ${tmVisible ? "dp-btn--primary" : ""}`}
            onClick={onToggleTm}
            title="Ctrl+Shift+T"
          >
            {t("header.tm")}
          </button>
        )}

        {onToggleFocus && (
          <button
            className={`dp-btn shrink-0 ${focusMode ? "dp-btn--primary" : ""}`}
            onClick={onToggleFocus}
            title="Ctrl+\\"
          >
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M4 4h6v2H6v4H4V4zm10 0h6v6h-2V6h-4V4zM4 14h2v4h4v2H4v-6zm16 0h-2v4h-4v2h6v-6z" />
            </svg>
            {t("header.focus")}
          </button>
        )}
        </div>{/* end left/middle wrapping group */}

        {/* RIGHT — Save & Build НІКОЛИ не переїжджають: окремий контейнер
            із shrink-0, який не входить у wrap-логіку лівого боку. Лог-кнопка
            та autosave-індикатор також тут, щоб не порушувати позицію Save. */}
        <div className="flex items-center gap-2 shrink-0">
        {selectedFilePath && (
          <SaveStatusBadge
            dirty={dirty}
            lastAutosaveAt={lastAutosaveAt}
            saveError={lastSaveError}
            fileName={selectedFilePath.split(/[\\/]/).pop()}
          />
        )}

        <button
          className="dp-btn shrink-0"
          disabled={!dirty || !selectedFilePath}
          onClick={() => saveFile()}
          title="Ctrl+S"
        >
          {dirty ? t("header.save") : t("header.saved")}
        </button>

        <button
          className="dp-btn dp-btn--success shrink-0"
          disabled={!folder || buildState === "building"}
          onClick={saveAndBuild}
          title={t("header.buildAndSave")}
        >
          {t("header.buildAndSave")}
        </button>
        </div>{/* end right pinned group */}
      </header>

      <SettingsModal open={settingsOpen} onClose={() => setSettingsOpen(false)} />
      <Dp2OthersModal open={othersOpen} onClose={() => setOthersOpen(false)} />
      <CorpusStatsModal
        open={statsOpen}
        onClose={() => setStatsOpen(false)}
        mode="dp2"
        folder={folder}
      />
      <GlossaryConsistencyModal open={gcOpen} onClose={() => setGcOpen(false)} />
      <NameConsistencyModal open={ncOpen} onClose={() => setNcOpen(false)} />
      <LogViewer
        open={logOpen}
        onClose={() => setLogOpen(false)}
        log={lastLog}
        logPath={lastLogPath}
      />
    </>
  );
}
