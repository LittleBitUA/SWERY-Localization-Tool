// Dp2FontsEditor — робота з 4 шрифтами DP2 (sharedassets0.assets).
// Workflow: експорт TTF → заміна → repack. UI live-показує текст обраним
// шрифтом (експортований TTF реєструється через @font-face через base64-URL).

import { useEffect, useState, useCallback } from "react";
import { useT, localizeBackendError } from "../../lib/i18n";
import { showToast, dismissToast } from "../../components/Toast";
import { confirm as showConfirm, alert as showAlert } from "../../lib/dialogs";

interface Props {
  onHome: () => void;
  onOpenSettings: () => void;
}

interface DpFont {
  name: string;
  pathId: number;
  fontSize: number;
  lineSpacing: number;
  ascent: number;
  descent: number;
  purpose: string;
}

// Точкове відображення PathID → .assets файл. Користувач підтвердив фактичне
// розташування у DP2: 722-725 живуть у sharedassets0, 22522-22524 у resources.
const FONTS: (DpFont & { assetsFile: string })[] = [
  { name: "FOT-NewRodinProN-DB",     pathId: 722,   assetsFile: "sharedassets0.assets", fontSize: 16, lineSpacing: 32, ascent: 14.08, descent: -1.92, purpose: "dp2font.purpose.722" },
  { name: "FOT-NewCezannePro-DB",    pathId: 723,   assetsFile: "sharedassets0.assets", fontSize: 16, lineSpacing: 32, ascent: 14.08, descent: -1.92, purpose: "dp2font.purpose.723" },
  { name: "FOT-NewCezannePro-M",     pathId: 724,   assetsFile: "sharedassets0.assets", fontSize: 16, lineSpacing: 32, ascent: 14.08, descent: -1.92, purpose: "dp2font.purpose.724" },
  { name: "FOT-NewCinemaAStd-D",     pathId: 725,   assetsFile: "sharedassets0.assets", fontSize: 16, lineSpacing: 32, ascent: 14.08, descent: -1.92, purpose: "dp2font.purpose.725" },
  { name: "FOT-Wentworth",           pathId: 22522, assetsFile: "resources.assets",     fontSize: 16, lineSpacing: 32, ascent: 14.08, descent: -1.92, purpose: "dp2font.purpose.22522" },
  { name: "FOT-UDKakugo_LargePro-R", pathId: 22523, assetsFile: "resources.assets",     fontSize: 16, lineSpacing: 32, ascent: 14.08, descent: -1.92, purpose: "dp2font.purpose.22523" },
  { name: "FOT-MatisseProN-UB",      pathId: 22524, assetsFile: "resources.assets",     fontSize: 16, lineSpacing: 32, ascent: 14.08, descent: -1.92, purpose: "dp2font.purpose.22524" },
];

// Множина CSS-сімей, які вже зареєстровані через FontFace API у цій сесії.
const loadedFamilies = new Set<string>();

// Декодує base64 у Uint8Array (ArrayBuffer) — швидше і надійніше, ніж
// вставляти величезний base64 у CSS-data-URI.
function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function ensureFontLoaded(fontName: string, filePath: string, bust?: number): Promise<string> {
  // `bust` (timestamp) генерує нову family при заміні — інакше CSS-кеш
  // тримає старий FontFace і preview не оновлюється після Replace.
  const family = "DP2Loaded-" + fontName + (bust ? "-v" + bust : "");
  if (loadedFamilies.has(family)) return family;
  try {
    const b64 = await window.dp2.fontsReadBase64(filePath);
    if (!b64) { console.warn(`[fonts] empty base64 for ${fontName}`); return family; }
    const bytes = b64ToBytes(b64);
    // FontFace API чекає на фактичне декодування шрифту і кидає помилку,
    // якщо TTF битий — зручніше для діагностики, ніж тихий fallback з @font-face.
    const face = new FontFace(family, bytes.buffer as ArrayBuffer, { display: "swap" });
    await face.load();
    (document as any).fonts.add(face);
    loadedFamilies.add(family);
    console.log(`[fonts] loaded ${family} (${bytes.length} bytes)`);
  } catch (e) {
    console.error(`[fonts] FAILED to load ${family}:`, e);
  }
  return family;
}

export function Dp2FontsEditor({ onHome, onOpenSettings }: Props) {
  const t = useT();
  const [previewText, setPreviewText] = useState("Your text");
  const [exported, setExported] = useState<Record<number, { path: string; family: string; assetsFile?: string }>>({});
  const [busy, setBusy] = useState(false);
  // Тип поточної операції — щоб overlay показував правильний title/body
  // ("Експортую шрифти" vs "Замінюю шрифт").
  const [busyMode, setBusyMode] = useState<"export" | "replace">("export");
  const [progressLog, setProgressLog] = useState<string[]>([]);
  const [showLog, setShowLog] = useState(false);
  const [elapsedSec, setElapsedSec] = useState(0);

  // Підписка на PowerShell stdout — рядки летять у реальному часі.
  useEffect(() => {
    const off1 = window.dp2.onFontsExportProgress((line) => {
      setProgressLog((prev) => [...prev.slice(-100), line]);
    });
    const off2 = window.dp2.onFontsReplaceProgress((line) => {
      setProgressLog((prev) => [...prev.slice(-100), line]);
    });
    return () => { off1(); off2(); };
  }, []);

  // Лічильник часу під час busy-операції.
  useEffect(() => {
    if (!busy) { setElapsedSec(0); return; }
    const t0 = Date.now();
    const id = setInterval(() => setElapsedSec(Math.floor((Date.now() - t0) / 1000)), 250);
    return () => clearInterval(id);
  }, [busy]);

  // При маунті — підвантажуємо те, що вже експортовано раніше.
  const refreshList = useCallback(async () => {
    const res = await window.dp2.fontsList();
    if (!res.files.length) return;
    const bust = Date.now();
    const next: Record<number, { path: string; family: string; assetsFile?: string }> = {};
    for (const f of FONTS) {
      const safe = f.name.replace(/[\\/:\*\?"<>\|]/g, "_");
      // Точне канонічне ім'я: <name>-<assetsFile>-<pathId>.{ttf|otf}.
      // Без fuzzy-match, щоб не підхопити сміттєвий `font_<pid>-...`.
      const canonical = `${safe}-${f.assetsFile}-${f.pathId}`;
      const hit = res.files.find((x) =>
        x.name === `${canonical}.ttf` || x.name === `${canonical}.otf`
      );
      if (hit) {
        const family = await ensureFontLoaded(f.name, hit.path, bust);
        next[f.pathId] = { path: hit.path, family, assetsFile: f.assetsFile };
      }
    }
    setExported(next);
  }, []);

  useEffect(() => { refreshList(); }, [refreshList]);

  async function runExport() {
    if (busy) return;
    setBusyMode("export");
    setBusy(true);
    setProgressLog([]);
    const progressId = showToast(t("fonts.toast.exporting"), { tone: "info", durationMs: 0 });
    try {
      const res = await window.dp2.fontsExport();
      dismissToast(progressId);
      if (!res.success) {
        await showAlert(t("dialog.error"), localizeBackendError(res.error) || "fonts-export failed");
        return;
      }
      const n = (res.exported ?? []).length;
      showToast(t("fonts.toast.exported", { n, dir: res.outDir ?? "" }), {
        tone: "success", title: t("fonts.toast.exportedTitle"), durationMs: 8000,
      });
      await refreshList();
    } catch (e: any) {
      dismissToast(progressId);
      await showAlert(t("dialog.error"), String(e?.message ?? e));
    } finally {
      setBusy(false);
    }
  }

  async function runReplace(font: DpFont & { assetsFile: string }) {
    if (busy) return;
    const pick = await window.dp2.pickFile({
      title: `Замінити шрифт ${font.name}`,
      filters: [{ name: "TrueType / OpenType", extensions: ["ttf", "otf"] }],
    });
    if (!pick) return;
    const ok = await showConfirm(
      t("fonts.confirmReplaceTitle"),
      t("fonts.confirmReplaceBody", { name: font.name, file: pick }),
      { tone: "danger", okLabel: t("fonts.actions.replace") }
    );
    if (!ok) return;

    setBusyMode("replace");
    setBusy(true);
    setProgressLog([]);
    const progressId = showToast(t("fonts.toast.replacing", { name: font.name }), { tone: "info", durationMs: 0 });
    try {
      const res = await window.dp2.fontsReplace({
        pathId: font.pathId,
        newFontPath: pick,
        // Точкова заміна — assetsFile беремо з нашого hardcoded FONTS mapping
        // (а не з cache-імені, де могло бути неправильне через сміттєві файли).
        assetsFile: font.assetsFile,
        name: font.name,
      } as { pathId: number; newFontPath: string; assetsFile?: string; name?: string });
      dismissToast(progressId);
      if (!res.success) {
        await showAlert(t("dialog.error"), localizeBackendError(res.error) || "replace failed");
        return;
      }
      showToast(t("fonts.toast.replaced", { name: font.name }), {
        tone: "success", title: t("fonts.toast.replacedTitle"), durationMs: 10000,
      });
      // Перезавантажуємо TTF з вибраного нового файлу (з кеш-бастером).
      // FontFace API кешує по family-name, тому ми завжди генеруємо нову.
      const family = await ensureFontLoaded(font.name, pick, Date.now());
      setExported((prev) => ({
        ...prev,
        [font.pathId]: { ...(prev[font.pathId] || {}), path: pick, family },
      }));
    } catch (e: any) {
      dismissToast(progressId);
      await showAlert(t("dialog.error"), String(e?.message ?? e));
    } finally {
      setBusy(false);
    }
  }

  const exportedCount = Object.keys(exported).length;
  const noneExported = exportedCount === 0;

  return (
    <div className="flex-1 flex flex-col bg-[var(--bg)] min-h-0">
      <header className="h-12 px-4 border-b border-[var(--border-soft)] bg-[var(--bg-surface)] flex items-center gap-3 shrink-0">
        <button className="dp-btn dp-btn--ghost shrink-0" onClick={onHome} title={t("header.home")}>
          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M10 19l-7-7m0 0l7-7m-7 7h18" />
          </svg>
        </button>
        <span className="text-[13px] text-[var(--text-muted)]">{t("fonts.brand")}</span>
        <div className="flex-1 min-w-0" />
        {!noneExported && (
          <>
            <button
              className="dp-btn dp-btn--ghost shrink-0"
              onClick={() => {
                const any = Object.values(exported)[0];
                if (any) window.dp2.openFolder(any.path.replace(/[\\/][^\\/]+$/, ""));
              }}
              title={t("fonts.actions.openFolder")}
            >
              {t("fonts.actions.openFolder")}
            </button>
            <button
              className="dp-btn dp-btn--ghost shrink-0"
              onClick={runExport}
              disabled={busy}
              title={t("fonts.actions.reexport")}
            >
              {busy ? t("fonts.actions.exporting") : t("fonts.actions.reexport")}
            </button>
            <button
              className="dp-btn dp-btn--ghost shrink-0"
              disabled={busy}
              title={t("fonts.actions.restoreBakHint")}
              onClick={async () => {
                const ok = await showConfirm(
                  t("fonts.actions.restoreBakTitle"),
                  t("fonts.actions.restoreBakBody"),
                  { tone: "danger", okLabel: t("fonts.actions.restoreBak") }
                );
                if (!ok) return;
                setBusy(true);
                try {
                  const w = window.dp2 as unknown as { fontsRestoreBak: () => Promise<{ success: boolean; restored?: string[]; skipped?: { file: string; reason: string }[]; error?: string }> };
                  const r = await w.fontsRestoreBak();
                  if (!r.success) {
                    await showAlert(t("dialog.error"), localizeBackendError(r.error) || "?");
                  } else {
                    showToast(
                      t("fonts.toast.restored", { files: (r.restored || []).join(", ") || "—" }),
                      { tone: "success", title: t("fonts.actions.restoreBak"), durationMs: 8000 }
                    );
                  }
                } finally { setBusy(false); }
              }}
            >
              {t("fonts.actions.restoreBak")}
            </button>
          </>
        )}
        <button
          className="dp-btn dp-btn--ghost shrink-0"
          onClick={onOpenSettings}
          title={t("header.settings")}
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
            <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
          </svg>
        </button>
      </header>

      <div className="flex-1 min-h-0 overflow-y-auto p-6">
        <div className="max-w-[1100px] mx-auto">
          <div className="mb-6">
            <h1 className="text-[20px] font-bold text-[var(--text-strong)] mb-1">
              {t("fonts.title")}
            </h1>
            <p className="text-[13px] text-[var(--text-muted)] leading-relaxed">
              {t("fonts.intro")}
            </p>
          </div>

          {/* Великий CTA-банер коли ще нічого не експортовано */}
          {noneExported && !busy && (
            <div className="mb-6 border border-[var(--accent)]/40 bg-[var(--accent-soft)] rounded p-5 flex items-center gap-4">
              <div className="flex-1 min-w-0">
                <h3 className="text-[14px] font-bold text-[var(--text-strong)] mb-1">
                  {t("fonts.cta.title")}
                </h3>
                <p className="text-[12.5px] text-[var(--text-muted)] leading-relaxed">
                  {t("fonts.cta.body")}
                </p>
              </div>
              <button
                className="dp-btn dp-btn--primary shrink-0"
                onClick={runExport}
                style={{ padding: "10px 18px", fontSize: 13 }}
              >
                {t("fonts.actions.exportAll")}
              </button>
            </div>
          )}

          {/* Live-progress overlay: спінер + лічильник часу + tail з real-time stdout */}
          {busy && (
            <div className="mb-6 border border-[var(--accent)] bg-[var(--accent-soft)] rounded p-5">
              <div className="flex items-start gap-4 mb-3">
                <Spinner />
                <div className="flex-1 min-w-0">
                  <h3 className="text-[14px] font-bold text-[var(--text-strong)] mb-1 flex items-center gap-2">
                    {busyMode === "replace" ? t("fonts.progress.title.replace") : t("fonts.progress.title")}
                    <span className="text-[11px] text-[var(--text-muted)] font-mono tabular-nums">
                      · {elapsedSec}s
                    </span>
                  </h3>
                  <p className="text-[12.5px] text-[var(--text-muted)] leading-relaxed">
                    {busyMode === "replace" ? t("fonts.progress.body.replace") : t("fonts.progress.body")}
                  </p>
                </div>
              </div>
              <div className="h-1 bg-[var(--bg)] rounded overflow-hidden mb-3">
                <div className="h-full bg-[var(--accent)] animate-progress-bar" style={{ width: "30%" }} />
              </div>
              {progressLog.length > 0 && (
                <pre className="text-[10.5px] font-mono text-[var(--text-faint)] bg-[var(--bg)] border border-[var(--border-soft)] rounded p-2 max-h-[120px] overflow-y-auto whitespace-pre-wrap break-all">
                  {progressLog.slice(-12).join("\n")}
                </pre>
              )}
            </div>
          )}

          {/* Лог після завершення: окрема панель з кнопками Show / Save */}
          {!busy && progressLog.length > 0 && (
            <div className="mb-6 border border-[var(--border-soft)] rounded bg-[var(--bg-surface)] p-3">
              <div className="flex items-center gap-2 mb-2">
                <span className="text-[10px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
                  {t("fonts.log.title", { n: progressLog.length })}
                </span>
                <div className="flex-1" />
                <button className="dp-btn dp-btn--ghost" onClick={() => setShowLog((v) => !v)}>
                  {showLog ? t("fonts.log.hide") : t("fonts.log.show")}
                </button>
                <button
                  className="dp-btn"
                  onClick={async () => {
                    const ts = new Date().toISOString().replace(/[:.]/g, "-");
                    const dest = await window.dp2.pickSaveFile({
                      title: t("fonts.log.saveTitle"),
                      defaultPath: `dp2-fonts-log-${ts}.txt`,
                      filters: [{ name: "Log", extensions: ["txt", "log"] }],
                    });
                    if (!dest) return;
                    await window.dp2.writeFile(dest, progressLog.join("\n"));
                    await showAlert(t("fonts.log.savedTitle"), t("fonts.log.savedBody", { path: dest }), { tone: "success" });
                  }}
                >
                  {t("fonts.log.save")}
                </button>
                <button className="dp-btn dp-btn--ghost" onClick={() => setProgressLog([])} title={t("fonts.log.clear")}>
                  ✕
                </button>
              </div>
              {showLog && (
                <pre className="text-[10.5px] font-mono text-[var(--text-faint)] bg-[var(--bg)] border border-[var(--border-soft)] rounded p-2 max-h-[280px] overflow-y-auto whitespace-pre-wrap break-all">
                  {progressLog.join("\n")}
                </pre>
              )}
            </div>
          )}

          <div className="mb-6 border border-[var(--border-soft)] rounded bg-[var(--bg-surface)] p-4">
            <label className="text-[10px] font-semibold uppercase tracking-wider text-[var(--text-muted)] block mb-2">
              {t("fonts.previewText")}
            </label>
            <input
              className="dp-input w-full mb-3"
              value={previewText}
              onChange={(e) => setPreviewText(e.target.value)}
              placeholder={t("fonts.previewPlaceholder")}
            />
            <p className="text-[10px] text-[var(--text-faint)]">
              {t("fonts.previewHint")}
            </p>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
            {FONTS.map((font) => (
              <FontCard
                key={font.pathId}
                font={font}
                previewText={previewText}
                exported={exported[font.pathId]}
                busy={busy}
                onReplace={() => runReplace(font)}
              />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function Spinner() {
  return (
    <svg
      className="w-8 h-8 shrink-0 text-[var(--accent)]"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={3}
      style={{ animation: "dp-spin 0.9s linear infinite" }}
    >
      <circle cx="12" cy="12" r="9" opacity="0.2" />
      <path d="M21 12a9 9 0 0 0 -9 -9" strokeLinecap="round" />
    </svg>
  );
}

function FontCard({
  font, previewText, exported, busy, onReplace,
}: {
  font: DpFont;
  previewText: string;
  exported?: { path: string; family: string };
  busy: boolean;
  onReplace: () => void;
}) {
  const t = useT();
  const isLoaded = !!exported;
  const fontFamily = exported
    ? `"${exported.family}", "Inter", system-ui, sans-serif`
    : '"Inter", system-ui, sans-serif';

  return (
    <div className="border border-[var(--border-soft)] rounded bg-[var(--bg-surface)] overflow-hidden flex flex-col">
      <div className="px-4 py-3 border-b border-[var(--border-soft)] flex flex-col gap-1.5">
        <div className="flex items-start justify-between gap-2">
          <h3 className="font-mono text-[12px] text-[var(--text-strong)] break-all leading-tight">
            {font.name}
          </h3>
          <span className={`dp-pill shrink-0 ${isLoaded ? "dp-pill--success" : "dp-pill--warn"}`}>
            {isLoaded ? t("fonts.loaded") : t("fonts.notExported")}
          </span>
        </div>
        <p className="text-[10.5px] text-[var(--text-faint)] tabular-nums leading-tight">
          PathID {font.pathId} · {t(font.purpose)}
        </p>
      </div>

      <div className="p-4 bg-[var(--bg)] flex-1 flex items-center justify-center min-h-[100px]">
        <p
          className="text-center break-words"
          style={{
            fontFamily,
            fontSize: 18,
            lineHeight: font.lineSpacing / font.fontSize,
            letterSpacing: "0.06em",
            color: "var(--text-strong)",
            textShadow: "0 1px 3px rgba(0,0,0, 0.6)",
          }}
        >
          {previewText || t("fonts.previewPlaceholder")}
        </p>
      </div>

      <div className="px-4 py-2 border-t border-[var(--border-soft)] grid grid-cols-3 gap-2 text-[10px] font-mono text-[var(--text-faint)]">
        <span>size <span className="text-[var(--text-muted)]">{font.fontSize}</span></span>
        <span>line <span className="text-[var(--text-muted)]">{font.lineSpacing}</span></span>
        <span>asc/desc <span className="text-[var(--text-muted)]">{font.ascent.toFixed(2)}/{font.descent.toFixed(2)}</span></span>
      </div>

      <div className="px-3 py-2 border-t border-[var(--border-soft)] flex gap-2 flex-wrap">
        <button
          className="dp-btn dp-btn--primary flex-1"
          disabled={busy}
          onClick={onReplace}
        >
          {t("fonts.actions.replace")}
        </button>
      </div>
    </div>
  );
}
