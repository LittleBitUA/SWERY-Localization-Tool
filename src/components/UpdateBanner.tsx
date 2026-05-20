// Тонкий банер зверху додатка, якщо на GitHub'і є новіший release.
// Кешування — у main-process (settings.lastUpdateCache + ts, TTL 6h). Тут
// лише UI. «Приховати цю версію» зберігається на диск, тож банер не
// повертатиметься, поки не вийде ще новіший реліз.
//
// Кнопка «Оновити» запускає повний auto-update flow (download .exe →
// swap-batch → restart), як у DP1 Launcher.

import { useEffect, useState } from "react";
import { useT } from "../lib/i18n";

interface UpdateInfo {
  current: string;
  latest: string;
  htmlUrl: string;
  name?: string;
}

interface ProgressState {
  type: "locating" | "downloading" | "extracting" | "installing" | "error";
  downloaded?: number;
  total?: number;
  speed?: number;
  error?: string;
}

function humanBytes(n?: number): string {
  if (!n || n <= 0) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export function UpdateBanner() {
  const t = useT();
  const [info, setInfo] = useState<UpdateInfo | null>(null);
  const [hidden, setHidden] = useState(false);
  const [progress, setProgress] = useState<ProgressState | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await window.dp2.checkUpdate();
        if (cancelled || !r.ok || !r.available || !r.latest || !r.htmlUrl) return;
        const s = await window.dp2.getSettings();
        if (s.dismissedUpdateVersion === r.latest) return;
        setInfo({
          current: r.current ?? "?",
          latest: r.latest,
          htmlUrl: r.htmlUrl,
          name: r.name,
        });
      } catch { /* offline / API rate-limit — мовчимо */ }
    })();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    const off = window.dp2.onUpdateProgress?.((p) => setProgress(p));
    return () => { if (typeof off === "function") off(); };
  }, []);

  if (!info || hidden) return null;

  const busy = progress !== null && progress.type !== "error";
  const pct = progress?.downloaded && progress.total
    ? Math.min(100, Math.round((progress.downloaded / progress.total) * 100))
    : null;

  return (
    <div
      className="update-banner fixed top-4 left-1/2 -translate-x-1/2 z-40 max-w-[min(420px,calc(100vw-32px))] w-auto overflow-hidden animate-[updateBannerIn_240ms_ease-out]"
      style={{
        // Glassmorphism: темна напівпрозорість + сильний blur зробить
        // ефект "матового скла" над вмістом, незалежно від теми позаду.
        background: "rgba(20, 22, 28, 0.55)",
        backdropFilter: "blur(28px) saturate(140%)",
        // Сам backdropFilter ховається у Safari без -webkit-префікса,
        // та у Chromium >=76 теж приймає префікс — дублюємо.
        WebkitBackdropFilter: "blur(28px) saturate(140%)",
        borderRadius: 18,
        // Подвійна рамка: зовнішня м'яка біла + внутрішній highlight зверху
        // для 3D lift-у (як на скріншоті macOS Big Sur нотифікацій).
        border: "1px solid rgba(255, 255, 255, 0.18)",
        boxShadow:
          "0 12px 40px rgba(0, 0, 0, 0.55), " +
          "inset 0 1px 0 rgba(255, 255, 255, 0.12), " +
          "inset 0 -1px 0 rgba(255, 255, 255, 0.04)",
      }}
    >
      <div className="flex items-start gap-3 px-4 py-3">
        <div
          className="w-9 h-9 rounded-xl flex items-center justify-center shrink-0"
          style={{
            background: "rgba(255, 255, 255, 0.1)",
            border: "1px solid rgba(255, 255, 255, 0.15)",
          }}
        >
          <svg className="w-4 h-4 text-[var(--accent)]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
          </svg>
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-[13px] font-semibold leading-tight" style={{ color: "rgba(255,255,255,0.95)" }}>
            {t("update.title")}
          </p>
          <p className="text-[11.5px] mt-0.5 leading-snug truncate" style={{ color: "rgba(255,255,255,0.65)" }} title={info.name}>
            v{info.latest} · {t("update.bannerLine", { current: info.current })}
          </p>
        </div>
        {!busy && (
          <button
            className="update-banner__icon-btn"
            onClick={async () => {
              await window.dp2.dismissUpdateVersion(info.latest);
              setHidden(true);
            }}
            title={t("update.dismissHint")}
            aria-label={t("update.dismissHint")}
          >
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        )}
        {progress?.type === "error" && (
          <button
            className="update-banner__icon-btn"
            onClick={() => setProgress(null)}
            aria-label={t("btn.close")}
          >
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        )}
      </div>

      {busy && (
        <div className="px-4 pb-3 flex flex-col gap-1.5">
          <div
            className="h-1.5 rounded-full overflow-hidden"
            style={{ background: "rgba(255, 255, 255, 0.1)" }}
          >
            <div
              className="h-full bg-[var(--accent)] transition-[width] duration-300"
              style={{ width: pct != null ? `${pct}%` : "20%" }}
            />
          </div>
          <span className="text-[10.5px] tabular-nums" style={{ color: "rgba(255,255,255,0.7)" }}>
            {progress?.type === "locating" && t("update.progress.locating")}
            {progress?.type === "downloading" && (
              <>
                {humanBytes(progress.downloaded)} / {humanBytes(progress.total)}
                {pct != null && ` · ${pct}%`}
                {progress.speed != null && progress.speed > 0 && ` · ${humanBytes(progress.speed)}/s`}
              </>
            )}
            {progress?.type === "extracting" && t("update.progress.extracting")}
            {progress?.type === "installing" && t("update.progress.installing")}
          </span>
        </div>
      )}

      {progress?.type === "error" && (
        <p className="px-4 pb-3 text-[11px] whitespace-pre-wrap break-words" style={{ color: "#ff8a8a" }}>
          {progress.error}
        </p>
      )}

      {!busy && (
        <div className="px-3 pb-3 flex items-center gap-2">
          <button
            className="update-banner__btn update-banner__btn--primary flex-1"
            onClick={async () => {
              setProgress({ type: "locating" });
              const r = await window.dp2.applyUpdate();
              if (!r.ok) setProgress({ type: "error", error: r.error });
            }}
            title={t("update.applyHint")}
          >
            {t("update.apply")}
          </button>
          <button
            className="update-banner__btn"
            onClick={() => window.dp2.openExternal(info.htmlUrl)}
            title={t("update.openReleaseHint")}
          >
            {t("update.openRelease")}
          </button>
        </div>
      )}

      <style>{`
        @keyframes updateBannerIn {
          from { opacity: 0; transform: translate(-50%, -8px); }
          to   { opacity: 1; transform: translate(-50%, 0); }
        }
        .update-banner__icon-btn {
          width: 24px; height: 24px; border-radius: 8px;
          display: inline-flex; align-items: center; justify-content: center;
          color: rgba(255,255,255,0.55);
          background: transparent;
          border: 1px solid transparent;
          transition: background 120ms, color 120ms, border-color 120ms;
          flex-shrink: 0;
        }
        .update-banner__icon-btn:hover {
          background: rgba(255,255,255,0.1);
          color: rgba(255,255,255,0.9);
          border-color: rgba(255,255,255,0.1);
        }
        .update-banner__btn {
          flex-shrink: 0;
          height: 32px;
          padding: 0 14px;
          border-radius: 10px;
          font-size: 12px;
          font-weight: 600;
          color: rgba(255,255,255,0.9);
          background: rgba(255,255,255,0.1);
          border: 1px solid rgba(255,255,255,0.15);
          backdrop-filter: blur(8px);
          -webkit-backdrop-filter: blur(8px);
          transition: background 120ms, border-color 120ms;
          cursor: pointer;
        }
        .update-banner__btn:hover {
          background: rgba(255,255,255,0.16);
          border-color: rgba(255,255,255,0.25);
        }
        .update-banner__btn--primary {
          background: rgba(255,255,255,0.18);
          border-color: rgba(255,255,255,0.28);
        }
        .update-banner__btn--primary:hover {
          background: rgba(255,255,255,0.26);
          border-color: rgba(255,255,255,0.38);
        }
      `}</style>
    </div>
  );
}
