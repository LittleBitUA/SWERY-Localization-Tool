import { useEffect, useState } from "react";
import { useT } from "../lib/i18n";
import { LangToggle } from "../components/LangToggle";
import bgImage from "./assets/dp-board.jpg";
import "./theme.css";

export type GameMode = "text" | "fonts" | "textures";
export type GameId = "dp1" | "dp2" | "tgl" | "hbr";

interface Props {
  onPickGame: (id: GameId, mode?: GameMode) => void;
  onOpenSetup: () => void;
  onOpenFolder: (path: string) => void;
  /** Останні шляхи з усіх ігор (DP1/DP2/TGL). */
  onOpenRecent?: (game: GameId, path: string) => void;
}

interface CaseDef {
  id: GameId;
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
  {
    id: "tgl",
    caseNo: "003",
    subjectKey: "home.tgl.title",
    altnameKey: "home.tgl.altname",
    regionKey: "home.v2.tgl.region",
    platform: "PC · Steam",
    format: "loc/English (binary)",
    noteKey: "home.v2.tgl.note",
  },
  {
    id: "hbr",
    caseNo: "004",
    subjectKey: "home.hbr.title",
    altnameKey: "home.hbr.altname",
    regionKey: "home.v2.hbr.region",
    platform: "PC · Steam",
    format: "—",
    noteKey: "home.v2.hbr.note",
  },
];

export function HomeV2({ onPickGame, onOpenSetup, onOpenFolder, onOpenRecent }: Props) {
  const t = useT();
  const [mounted, setMounted] = useState(false);
  const [state, setState] = useState<Record<GameId, {
    hasPath: boolean;
    progress: { done: number; total: number } | null;
  }>>({
    dp1: { hasPath: false, progress: null },
    dp2: { hasPath: false, progress: null },
    tgl: { hasPath: false, progress: null },
    hbr: { hasPath: false, progress: null },
  });
  // Уніфіковані recents: DP1 eng.json, DP2 lastFolder + recentFolders[], TGL bin.
  const [recentItems, setRecentItems] = useState<Array<{ game: GameId; path: string }>>([]);

  useEffect(() => {
    setTimeout(() => setMounted(true), 10);
    (async () => {
      try {
        const settings: any = await window.dp2.getSettings();
        setState({
          dp1: { hasPath: !!settings.dp1EngPath, progress: null },
          dp2: { hasPath: !!settings.lastFolder, progress: null },
          tgl: { hasPath: !!settings.tglBinPath, progress: null },
          hbr: { hasPath: !!settings.hbrBundlePath, progress: null },
        });
        // Уніфікований список останніх: DP1 eng.json, DP2 lastFolder
        // (+ старий recentFolders[]), TGL bin. Dedup і обмеження 8.
        const items: Array<{ game: GameId; path: string }> = [];
        const seen = new Set<string>();
        const push = (game: GameId, p?: string) => {
          if (!p) return;
          const key = `${game}::${p}`;
          if (seen.has(key)) return;
          seen.add(key);
          items.push({ game, path: p });
        };
        push("dp1", settings.dp1EngPath);
        push("dp2", settings.lastFolder);
        push("tgl", settings.tglBinPath);
        const rf: string[] = Array.isArray(settings.recentFolders) ? settings.recentFolders : [];
        for (const p of rf) push("dp2", p);
        setRecentItems(items.slice(0, 8));
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
        // HBR corpus stats — рахуємо за наявності витягнутих файлів (Done/).
        // Може не виконатись, поки користувач не пройшов prep-wizard'у вперше.
        const wHbr = window.dp2 as unknown as { hbrCorpusStats?: () => Promise<{ ok: boolean; files: number; total: number; translated: number }> };
        if (wHbr.hbrCorpusStats) {
          wHbr.hbrCorpusStats().then((r) => {
            if (!r || !r.ok) return;
            setState((prev) => ({
              ...prev,
              hbr: {
                hasPath: true,
                progress: { done: r.translated, total: r.total },
              },
            }));
          }).catch(() => {});
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
          <header className="text-center mb-6">
            <span className="v2-bureau-mark">{t("home.v2.bureau")}</span>
            <h1 className="v2-hub-title">Deadly Premonition</h1>
            <p className="v2-hub-subtitle">{t("home.v2.tagline")}</p>
          </header>

          {/* Картки-теки */}
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-x-5 gap-y-5 mb-8">
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
              const isTgl = c.id === "tgl";
              const isHbr = c.id === "hbr";
              const hasActions = isDp2 || isTgl;
              return (
                <div
                  key={c.id}
                  className={`v2-folder${hasActions ? " v2-folder--with-actions" : ""}`}
                  onClick={!hasActions ? () => onPickGame(c.id, "text") : undefined}
                  style={{ cursor: hasActions ? "default" : "pointer" }}
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

                    {/* DP2-режими: три action-pills у нижній частині картки */}
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
                        <button
                          type="button"
                          className="v2-folder__action v2-folder__action--alt"
                          onClick={(e) => { e.stopPropagation(); onPickGame(c.id, "textures"); }}
                        >
                          {t("home.v2.action.textures")}
                        </button>
                      </div>
                    )}
                    {/* TGL: Текст + Шрифти */}
                    {isTgl && (
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

          {recentItems.length > 0 && (
            <section className="mb-10">
              <h3 className="v2-recent-title">{t("home.recent")}</h3>
              <div className="space-y-1.5">
                {recentItems.map(({ game, path }) => {
                  const short = path.split(/[\\/]/).slice(-2).join("/");
                  const badge = game.toUpperCase();
                  return (
                    <button
                      key={`${game}-${path}`}
                      onClick={() => {
                        if (onOpenRecent) onOpenRecent(game, path);
                        else if (game === "dp2") onOpenFolder(path);
                      }}
                      className="v2-recent-item"
                      title={path}
                    >
                      <span className="v2-recent-item__marker">▌</span>
                      <span className="dp-pill dp-pill--info text-[10px]" style={{ marginRight: 8 }}>{badge}</span>
                      <span className="v2-recent-item__name">{short}</span>
                      <span className="v2-recent-item__path">{path}</span>
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
