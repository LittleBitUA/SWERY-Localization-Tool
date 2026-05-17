import { useEffect, useRef, useState } from "react";
import { useT } from "../../lib/i18n";
import { alert as showAlert } from "../../lib/dialogs";
import { DP2_TEXT_FILES, dp2TextRequiredEntries } from "./required-text-files";

interface Props {
  /** Шлях до sharedassets0.assets — null якщо ще не задано (перший запуск). */
  assetsPath: string | null;
  /** Викликається коли користувач вибрав теку гри й ми зрезолвили шлях до .assets. */
  onAssetsPathPicked: (assetsPath: string) => Promise<void> | void;
  /** Викликається коли підготовка завершилась успішно. */
  onDone: (doneDir: string) => void;
  /** Користувач відмовився / помилка. Повертає на home. */
  onCancel: () => void;
  /** Для fonts/textures режимів — wizard потрібен лише щоб задати assetsPath,
   * без витягу тексту. Після pick одразу повертаємось до батьківського стейджу. */
  skipExtract?: boolean;
}

type Phase =
  | "checking"
  | "needs-extract"
  | "extracting"
  | "needs-mirror"
  | "mirroring"
  | "verifying"
  | "complete"
  | "error";

interface CheckResult {
  ok?: boolean;
  gameDir?: string;
  originalDir?: string;
  doneDir?: string;
  originalExisting?: string[];
  originalMissing?: string[];
  doneExisting?: string[];
  doneMissing?: string[];
  error?: string;
}

const REQUIRED_ENTRIES = dp2TextRequiredEntries();
const REQUIRED_PATHIDS = DP2_TEXT_FILES.map((f) => f.pathId);
const TOTAL = REQUIRED_ENTRIES.length;

export function Dp2TextPrepWizard({ assetsPath, onAssetsPathPicked, onDone, onCancel, skipExtract }: Props) {
  const t = useT();
  const [phase, setPhase] = useState<Phase>("checking");
  const [status, setStatus] = useState<CheckResult | null>(null);
  const [progressLines, setProgressLines] = useState<string[]>([]);
  const [extractedCount, setExtractedCount] = useState(0);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [pickingFolder, setPickingFolder] = useState(false);
  const startedRef = useRef(false);

  // Trigger runFlow коли отримуємо assetsPath (вперше або після pick).
  // У skipExtract-режимі (fonts/textures) — нічого не робимо тут, бо парент
  // вже перенаправить нас у відповідний редактор після onAssetsPathPicked.
  useEffect(() => {
    if (!assetsPath) return;
    if (skipExtract) return;
    if (startedRef.current) return;
    startedRef.current = true;
    runFlow();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [assetsPath, skipExtract]);

  async function pickGameFolder() {
    if (pickingFolder) return;
    setPickingFolder(true);
    try {
      const folder = await window.dp2.pickFolder({ title: t("dp2.prep.pickGame.dialogTitle") });
      if (!folder) return;
      // Резолвимо sharedassets0.assets всередині. Підтримуємо як вибір
      // самого DeadlyPremonition2_Data, так і кореневої теки гри.
      const candidates = [
        `${folder.replace(/[\\/]+$/, "")}\\sharedassets0.assets`,
        `${folder.replace(/[\\/]+$/, "")}\\DeadlyPremonition2_Data\\sharedassets0.assets`,
        `${folder.replace(/[\\/]+$/, "")}/sharedassets0.assets`,
        `${folder.replace(/[\\/]+$/, "")}/DeadlyPremonition2_Data/sharedassets0.assets`,
      ];
      let resolved: string | null = null;
      const w = window.dp2 as unknown as { textPrepStatus: (p: { assetsPath: string; requiredFiles: string[] }) => Promise<{ ok?: boolean }> };
      for (const cand of candidates) {
        try {
          const r = await w.textPrepStatus({ assetsPath: cand, requiredFiles: [] });
          if (r && r.ok) { resolved = cand; break; }
        } catch {}
      }
      if (!resolved) {
        setErrorMsg(t("dp2.prep.err.assetsNotInFolder", { folder }));
        setPhase("error");
        return;
      }
      await onAssetsPathPicked(resolved);
    } finally {
      setPickingFolder(false);
    }
  }

  // Підписка на live-прогрес з PowerShell.
  useEffect(() => {
    const w = window.dp2 as any;
    if (!w?.onTextPrepProgress) return;
    const off = w.onTextPrepProgress((line: string) => {
      setProgressLines((p) => [...p.slice(-200), line]);
      if (/^\[EXPORTED\]/.test(line)) {
        setExtractedCount((n) => n + 1);
      }
    });
    return () => { if (typeof off === "function") off(); };
  }, []);

  async function runFlow() {
    try {
      // 1) status
      setPhase("checking");
      const w = window.dp2 as any;
      const st: CheckResult = await w.textPrepStatus({
        assetsPath,
        requiredFiles: REQUIRED_ENTRIES,
      });
      setStatus(st);
      if (!st.ok) {
        setErrorMsg(t("dp2.prep.err.assetsNotFound", { path: assetsPath ?? "(empty)" }));
        setPhase("error");
        return;
      }

      // 2) extract if ORIGINAL incomplete
      if ((st.originalMissing?.length ?? 0) > 0) {
        setPhase("extracting");
        const r = await w.textPrepExtract({
          assetsPath,
          pathIds: REQUIRED_PATHIDS,
          entries: REQUIRED_ENTRIES,
        });
        if (!r.ok) {
          setErrorMsg(r.error || t("dp2.prep.err.extractFail"));
          setPhase("error");
          return;
        }
      }

      // 3) re-check status after extract
      const st2: CheckResult = await w.textPrepStatus({
        assetsPath,
        requiredFiles: REQUIRED_ENTRIES,
      });
      setStatus(st2);
      if ((st2.originalMissing?.length ?? 0) > 0) {
        setErrorMsg(t("dp2.prep.err.originalIncomplete", { n: st2.originalMissing!.length }));
        setPhase("error");
        return;
      }

      // 4) mirror to DONE if missing
      if ((st2.doneMissing?.length ?? 0) > 0) {
        setPhase("mirroring");
        const r = await w.textPrepCopyToDone({
          originalDir: st2.originalDir,
          doneDir: st2.doneDir,
          requiredFiles: REQUIRED_ENTRIES,
          overwrite: false,
        });
        if (!r.ok) {
          setErrorMsg(r.error || t("dp2.prep.err.mirrorFail"));
          setPhase("error");
          return;
        }
      }

      // 5) final verify
      setPhase("verifying");
      const st3: CheckResult = await w.textPrepStatus({
        assetsPath,
        requiredFiles: REQUIRED_ENTRIES,
      });
      setStatus(st3);
      if ((st3.doneMissing?.length ?? 0) > 0) {
        setErrorMsg(t("dp2.prep.err.doneIncomplete", { n: st3.doneMissing!.length }));
        setPhase("error");
        return;
      }

      setPhase("complete");
      // Зберігаємо doneDir для кнопки "Готово" — більше не auto-redirect,
      // користувач сам натискає, щоб бачити повний звіт.
      if (st3.doneDir) (window as unknown as { __dp2DoneDir?: string }).__dp2DoneDir = st3.doneDir;
    } catch (e: any) {
      setErrorMsg(String(e?.message ?? e));
      setPhase("error");
    }
  }

  const steps: Array<{ key: Phase | "init"; label: string; state: "pending" | "active" | "done" | "fail" }> = (() => {
    function s(target: Phase, label: string) {
      const order: Phase[] = ["checking", "extracting", "mirroring", "verifying", "complete"];
      const ti = order.indexOf(target);
      const ci = order.indexOf(phase);
      let state: "pending" | "active" | "done" | "fail";
      if (phase === "error" && target === stepWhereErrorHappened()) state = "fail";
      else if (ci > ti || phase === "complete") state = "done";
      else if (ci === ti) state = "active";
      else state = "pending";
      return { key: target, label, state } as const;
    }
    return [
      s("checking", t("dp2.prep.step.check")),
      s("extracting", t("dp2.prep.step.extract", { n: TOTAL })),
      s("mirroring", t("dp2.prep.step.mirror")),
      s("verifying", t("dp2.prep.step.verify")),
      s("complete", t("dp2.prep.step.done")),
    ];
  })();

  function stepWhereErrorHappened(): Phase {
    // Простий heuristic: куди впав, той і помилився.
    return phase;
  }

  const originalDone = (status?.originalExisting?.length ?? 0);
  const originalLeft = (status?.originalMissing?.length ?? 0);
  const doneDone = (status?.doneExisting?.length ?? 0);
  const doneLeft = (status?.doneMissing?.length ?? 0);

  // Прогрес-bar для extract: показуємо кількість EXPORTED-рядків.
  const extractProgress = phase === "extracting"
    ? Math.min(100, Math.round((extractedCount / Math.max(1, TOTAL)) * 100))
    : 0;

  function finalize() {
    const doneDir = (window as unknown as { __dp2DoneDir?: string }).__dp2DoneDir;
    if (doneDir) onDone(doneDir);
  }

  // Pre-state: треба ще вибрати теку гри. Показуємо у тій же модалці.
  if (!assetsPath) {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center p-6 bg-black/70 backdrop-blur-sm">
        <div className="dp-card w-full max-w-[680px] flex flex-col">
          <div className="px-5 py-3 border-b border-[var(--border-soft)]">
            <h2 className="text-[15px] font-semibold text-[var(--text-strong)]">{t("dp2.prep.title")}</h2>
          </div>
          <div className="p-5">
            <p className="text-[13px] text-[var(--text-muted)] mb-4 leading-relaxed">
              {t("dp2.prep.pickGame.intro")}
            </p>
            <div className="rounded-lg border border-[var(--accent)]/40 bg-[var(--accent-soft)] p-4 mb-4">
              <p className="text-[12.5px] text-[var(--text)] mb-3 leading-relaxed">
                {t("dp2.prep.pickGame.body")}
              </p>
              <p className="text-[11px] font-mono text-[var(--text-faint)] mb-3">
                …\steamapps\common\Deadly Premonition 2\DeadlyPremonition2_Data\
              </p>
              <button
                className="dp-btn dp-btn--primary"
                disabled={pickingFolder}
                onClick={pickGameFolder}
              >
                {pickingFolder ? t("dp2.prep.pickGame.picking") : t("dp2.prep.pickGame.pickBtn")}
              </button>
            </div>
            {phase === "error" && errorMsg && (
              <div className="rounded border border-[var(--danger)]/40 bg-[var(--danger)]/10 p-3 mb-4">
                <p className="text-[12.5px] text-[var(--text)] whitespace-pre-wrap leading-relaxed">{errorMsg}</p>
              </div>
            )}
          </div>
          <div className="px-5 py-3 border-t border-[var(--border-soft)] flex justify-end">
            <button className="dp-btn dp-btn--ghost" onClick={onCancel}>{t("btn.cancel")}</button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-6 bg-black/70 backdrop-blur-sm">
      <div className="dp-card w-full max-w-[820px] max-h-[88vh] flex flex-col">
        <div className="px-5 py-3 border-b border-[var(--border-soft)] flex items-center justify-between">
          <div className="min-w-0 flex-1">
            <h2 className="text-[15px] font-semibold text-[var(--text-strong)]">{t("dp2.prep.title")}</h2>
            <p className="text-[11px] text-[var(--text-faint)] font-mono truncate mt-0.5" title={assetsPath}>{assetsPath}</p>
          </div>
        </div>
        <div className="p-5 overflow-y-auto flex-1">
        <p className="text-[12.5px] text-[var(--text-muted)] mb-4 leading-relaxed">
          {t("dp2.prep.subtitle")}
        </p>

        {/* Step list */}
        <ol className="space-y-2 mb-6">
          {steps.map((s) => (
            <li key={s.key} className="flex items-start gap-3 px-4 py-2.5 rounded border border-[var(--border-soft)] bg-[var(--bg-surface)]">
              <span className={`shrink-0 mt-0.5 w-5 h-5 inline-flex items-center justify-center rounded-full text-[11px] font-bold ${
                s.state === "done" ? "bg-[var(--success)]/20 text-[var(--success)]"
                  : s.state === "active" ? "bg-[var(--accent)]/20 text-[var(--accent)]"
                  : s.state === "fail" ? "bg-[var(--danger)]/20 text-[var(--danger)]"
                  : "bg-[var(--bg-elevated)] text-[var(--text-faint)]"
              }`}>
                {s.state === "done" ? "✓" : s.state === "fail" ? "✗" : s.state === "active" ? "•" : "○"}
              </span>
              <span className={`text-[13px] flex-1 ${
                s.state === "active" ? "text-[var(--text-strong)] font-semibold" : "text-[var(--text)]"
              }`}>
                {s.label}
              </span>
              {s.state === "active" && phase === "extracting" && (
                <span className="text-[11px] font-mono tabular-nums text-[var(--text-muted)]">
                  {extractedCount}/{TOTAL}
                </span>
              )}
            </li>
          ))}
        </ol>

        {/* Live counters */}
        {status && phase !== "checking" && phase !== "error" && (
          <div className="grid grid-cols-2 gap-3 mb-6">
            <div className="rounded border border-[var(--border-soft)] bg-[var(--bg-surface)] p-3">
              <p className="text-[10px] uppercase tracking-wider text-[var(--text-faint)] mb-1">Text/Original</p>
              <p className="text-[15px] font-bold text-[var(--text-strong)]">
                {originalDone} / {TOTAL}
                {originalLeft > 0 && <span className="ml-2 text-[11px] text-[var(--text-faint)] font-normal">— {t("dp2.prep.missing", { n: originalLeft })}</span>}
              </p>
            </div>
            <div className="rounded border border-[var(--border-soft)] bg-[var(--bg-surface)] p-3">
              <p className="text-[10px] uppercase tracking-wider text-[var(--text-faint)] mb-1">Text/Done</p>
              <p className="text-[15px] font-bold text-[var(--text-strong)]">
                {doneDone} / {TOTAL}
                {doneLeft > 0 && <span className="ml-2 text-[11px] text-[var(--text-faint)] font-normal">— {t("dp2.prep.missing", { n: doneLeft })}</span>}
              </p>
            </div>
          </div>
        )}

        {/* Extract progress bar */}
        {phase === "extracting" && (
          <div className="mb-6">
            <div className="h-1.5 bg-[var(--bg-elevated)] rounded overflow-hidden">
              <div
                className="h-full bg-[var(--accent)] transition-all duration-300"
                style={{ width: `${extractProgress}%` }}
              />
            </div>
          </div>
        )}

        {/* Error block */}
        {phase === "error" && (
          <div className="rounded border border-[var(--danger)]/40 bg-[var(--danger)]/10 p-4 mb-4">
            <p className="text-[13px] font-bold text-[var(--danger)] mb-1">{t("dp2.prep.err.title")}</p>
            <p className="text-[12.5px] text-[var(--text)] whitespace-pre-wrap leading-relaxed">{errorMsg}</p>
            <div className="flex gap-2 mt-3">
              <button
                className="dp-btn dp-btn--primary"
                onClick={() => {
                  setErrorMsg(null);
                  setExtractedCount(0);
                  setProgressLines([]);
                  startedRef.current = false;
                  runFlow();
                  startedRef.current = true;
                }}
              >
                {t("dp2.prep.retry")}
              </button>
              <button className="dp-btn" onClick={onCancel}>{t("btn.cancel")}</button>
              <button
                className="dp-btn dp-btn--ghost ml-auto"
                onClick={async () => {
                  await showAlert(t("dp2.prep.err.diagTitle"), progressLines.slice(-50).join("\n") || "(no log)");
                }}
              >
                {t("dp2.prep.showLog")}
              </button>
            </div>
          </div>
        )}

        {/* Live log tail */}
        {(phase === "extracting" || phase === "mirroring") && progressLines.length > 0 && (
          <pre className="text-[10.5px] font-mono text-[var(--text-faint)] bg-[var(--bg-surface)] border border-[var(--border-soft)] rounded p-2 max-h-[160px] overflow-y-auto whitespace-pre-wrap break-all">
            {progressLines.slice(-15).join("\n")}
          </pre>
        )}

        {phase === "complete" && (
          <div className="rounded border border-[var(--success)]/40 bg-[var(--success)]/10 p-4 mb-4">
            <p className="text-[13px] font-bold text-[var(--success)] mb-1">{t("dp2.prep.completeTitle")}</p>
            <p className="text-[12.5px] text-[var(--text)] leading-relaxed">{t("dp2.prep.completeBody", { n: TOTAL })}</p>
          </div>
        )}
        </div>

        {/* Footer */}
        <div className="px-5 py-3 border-t border-[var(--border-soft)] flex items-center justify-between">
          <button className="dp-btn dp-btn--ghost" onClick={onCancel} disabled={phase === "extracting" || phase === "mirroring"}>
            {t("btn.cancel")}
          </button>
          <button
            className="dp-btn dp-btn--success"
            disabled={phase !== "complete"}
            onClick={finalize}
          >
            {t("dp2.prep.openEditor")}
          </button>
        </div>
      </div>
    </div>
  );
}
