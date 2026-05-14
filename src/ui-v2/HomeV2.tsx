import { useEffect, useState } from "react";
import { useT } from "../lib/i18n";
import { LangToggle } from "../components/LangToggle";
import bgImage from "./assets/dp-board.jpg";
import "./theme.css";

export type GameMode = "text" | "fonts";

interface Props {
  onPickGame: (id: "dp1" | "dp2", mode?: GameMode) => void;
  onOpenSetup: () => void;
  recentFolders: string[];
  onOpenFolder: (path: string) => void;
}

interface CaseDef {
  id: "dp1" | "dp2";
  caseNo: string;
  subjectKey: string;
  altnameKey: string;
  regionKey: string;
  platform: string;
  format: string;
  noteKey: string;
}

const CASES: CaseDef[] = [
  {
    id: "dp1",
    caseNo: "001",
    subjectKey: "home.dp1.title",
    altnameKey: "home.dp1.altname",
    regionKey: "home.v2.dp1.region",
    platform: "PC · Steam",
    format: ".mes / DPMsgTool",
    noteKey: "home.v2.dp1.note",
  },
  {
    id: "dp2",
    caseNo: "002",
    subjectKey: "home.dp2.title",
    altnameKey: "home.dp2.altname",
    regionKey: "home.v2.dp2.region",
    platform: "PC · Steam",
    format: "sharedassets / .assets",
    noteKey: "home.v2.dp2.note",
  },
];

export function HomeV2({ onPickGame, onOpenSetup, recentFolders, onOpenFolder }: Props) {
  const t = useT();
  const [mounted, setMounted] = useState(false);
  const [state, setState] = useState<Record<"dp1" | "dp2", {
    hasPath: boolean;
    progress: { done: number; total: number } | null;
  }>>({
    dp1: { hasPath: false, progress: null },
    dp2: { hasPath: false, progress: null },
  });

  useEffect(() => {
    setTimeout(() => setMounted(true), 10);
    (async () => {
      try {
        const settings: any = await window.dp2.getSettings();
        setState({
          dp1: { hasPath: !!settings.dp1EngPath, progress: null },
          dp2: { hasPath: !!settings.lastFolder, progress: null },
        });
        if (settings.lastFolder) {
          window.dp2.corpusStatsWorker({ folder: settings.lastFolder })
            .then((stats) => {
              setState((prev) => ({
                ...prev,
                dp2: {
                  hasPath: true,
                  progress: { done: stats.translatedEntries, total: stats.totalEntries },
                },
              }));
            })
            .catch(() => {});
        }
      } catch {}
    })();
  }, []);

  return (
    <div
      className={`dp-v2 flex-1 v2-board-wrapper overflow-y-auto relative ${mounted ? "opacity-100" : "opacity-0"} transition-opacity duration-500`}
    >
      {/* Фон: DP2 boxart — Le Carré з кривавим небом, розмитий і затемнений */}
      <div
        className="v2-board-bg-image"
        style={{ backgroundImage: `url(${bgImage})` }}
        aria-hidden
      />
      <div className="v2-board-overlay" aria-hidden />

      <div className="absolute top-3 right-4 z-10">
        <LangToggle />
      </div>

      <div className="relative z-[1] min-h-full flex flex-col items-center justify-center px-6 py-14">
        <div className="max-w-[1080px] w-full">
          {/* Header — Federal Bureau of Localization */}
          <header className="text-center mb-14">
            <span className="v2-bureau-mark">{t("home.v2.bureau")}</span>
            <h1 className="v2-hub-title">Deadly Premonition</h1>
            <p className="v2-hub-subtitle">{t("home.v2.tagline")}</p>
          </header>

          {/* Картки-теки */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-x-10 gap-y-8 mb-14">
            {CASES.map((c) => {
              const s = state[c.id];
              const pct = s.progress && s.progress.total > 0
                ? Math.round((s.progress.done / s.progress.total) * 100)
                : null;
              const status = !s.hasPath ? "pending" : (pct === 100 ? "closed" : "open");

              const stampLabel = status === "pending"
                ? t("home.v2.stamp.pending")
                : status === "closed"
                ? t("home.v2.stamp.closed")
                : t("home.v2.stamp.active");

              const statusLine = status === "pending"
                ? t("home.v2.status.pending")
                : status === "closed"
                ? t("home.v2.status.closed")
                : t("home.v2.status.open");

              const isDp2 = c.id === "dp2";
              return (
                <div
                  key={c.id}
                  className="v2-folder"
                  // DP1 — клік по всій картці відкриває редактор. DP2 — лише
                  // через окремі action-кнопки внизу (Текст / Шрифти).
                  onClick={!isDp2 ? () => onPickGame(c.id, "text") : undefined}
                  style={{ cursor: isDp2 ? "default" : "pointer" }}
                >
                  <span className="v2-folder__tab">{t("home.v2.case", { n: c.caseNo })}</span>

                  <div className="v2-folder__paper">
                    <div className="v2-folder__case">
                      {t("home.v2.subjectDossier")} · {t(c.regionKey)}
                    </div>
                    <div className="v2-folder__subject">{t(c.subjectKey)}</div>
                    <div className="v2-folder__altname">— {t(c.altnameKey)} —</div>

                    <div className="v2-folder__field">
                      <span className="v2-folder__field-label">{t("home.v2.field.platform")}</span>
                      <span className="v2-folder__field-value">{c.platform}</span>
                    </div>
                    <div className="v2-folder__field">
                      <span className="v2-folder__field-label">{t("home.v2.field.format")}</span>
                      <span className="v2-folder__field-value">{c.format}</span>
                    </div>
                    <div className="v2-folder__field">
                      <span className="v2-folder__field-label">{t("home.v2.field.status")}</span>
                      <span className="v2-folder__field-value">{statusLine}</span>
                    </div>
                    <div className="v2-folder__field">
                      <span className="v2-folder__field-label">{t("home.v2.field.progress")}</span>
                      <span className="v2-folder__field-value">
                        {pct !== null && s.progress
                          ? `${s.progress.done.toLocaleString("uk-UA")} / ${s.progress.total.toLocaleString("uk-UA")} · ${pct}%`
                          : "—"}
                      </span>
                    </div>

                    {pct !== null && (
                      <div className="v2-progress">
                        <div className="v2-progress__cells">
                          {Array.from({ length: 20 }).map((_, i) => (
                            <div
                              key={i}
                              className={`v2-progress__cell ${i < Math.round(pct / 5) ? "is-filled" : ""}`}
                            />
                          ))}
                        </div>
                      </div>
                    )}

                    <div className="v2-margin-note">{t(c.noteKey)}</div>

                    <div className={`v2-stamp ${status === "closed" ? "v2-stamp--green" : ""}`}>
                      {stampLabel}
                    </div>

                    {/* DP2-режими: два action-pills у нижній частині картки */}
                    {isDp2 && (
                      <div className="v2-folder__actions">
                        <button
                          type="button"
                          className="v2-folder__action"
                          onClick={(e) => { e.stopPropagation(); onPickGame(c.id, "text"); }}
                        >
                          {t("home.v2.action.text")}
                        </button>
                        <button
                          type="button"
                          className="v2-folder__action v2-folder__action--alt"
                          onClick={(e) => { e.stopPropagation(); onPickGame(c.id, "fonts"); }}
                        >
                          {t("home.v2.action.fonts")}
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>

          {recentFolders.length > 0 && (
            <section className="mb-10">
              <h3 className="v2-recent-title">{t("home.recent")}</h3>
              <div className="space-y-1.5">
                {recentFolders.slice(0, 5).map((p) => {
                  const short = p.split(/[\\/]/).slice(-2).join("/");
                  return (
                    <button key={p} onClick={() => onOpenFolder(p)} className="v2-recent-item" title={p}>
                      <span className="v2-recent-item__marker">▌</span>
                      <span className="v2-recent-item__name">{short}</span>
                      <span className="v2-recent-item__path">{p}</span>
                    </button>
                  );
                })}
              </div>
            </section>
          )}

          <footer className="v2-footer">
            <span>{t("home.setup.prompt")} </span>
            <button onClick={onOpenSetup}>{t("home.setup.button")}</button>
          </footer>
        </div>
      </div>
    </div>
  );
}
