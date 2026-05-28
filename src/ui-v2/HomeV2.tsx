import { useEffect, useState } from "react";
import { useT } from "../lib/i18n";
import { LangToggle } from "../components/LangToggle";
import { AppSettingsModal } from "../components/AppSettingsModal";
import { flattenTgl, isTglTranslated, type TglRecord } from "../games/tgl/parser";
import bgImage from "./assets/dp-board.jpg";
import "./theme.css";

export type GameMode = "text" | "fonts" | "textures";
export type GameId = "dp1" | "dp2" | "tgl" | "hbr" | "missing";

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
    format: "Unity · Bundle",
    noteKey: "home.v2.hbr.note",
  },
  {
    id: "missing",
    caseNo: "005",
    subjectKey: "home.missing.title",
    altnameKey: "home.missing.altname",
    regionKey: "home.v2.missing.region",
    platform: "PC · Steam",
    format: "Unity · resources.assets (MSG.*)",
    noteKey: "home.v2.missing.note",
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
    missing: { hasPath: false, progress: null },
  });
  // Уніфіковані recents: DP1 eng.json, DP2 lastFolder + recentFolders[], TGL bin.
  const [recentItems, setRecentItems] = useState<Array<{ game: GameId; path: string }>>([]);
  const [appSettingsOpen, setAppSettingsOpen] = useState(false);
  // 5 останніх релізів з GitHub. Cache у settings TTL 6h.
  const [releases, setReleases] = useState<Array<{
    tag: string; name: string; htmlUrl: string; publishedAt: string; prerelease: boolean;
  }> | null>(null);
  const [releasesStatus, setReleasesStatus] = useState<"loading" | "ready" | "empty" | "error">("loading");
  const [releasesError, setReleasesError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    window.dp2.fetchReleases().then((r) => {
      if (cancelled) return;
      if (!r.ok) {
        setReleasesStatus("error");
        setReleasesError(r.error ?? null);
        return;
      }
      const items = r.items ?? [];
      setReleases(items);
      setReleasesStatus(items.length === 0 ? "empty" : "ready");
    }).catch((e) => {
      if (cancelled) return;
      setReleasesStatus("error");
      setReleasesError(String(e?.message ?? e));
    });
    return () => { cancelled = true; };
  }, []);

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
          missing: { hasPath: !!settings.missingRoot, progress: null },
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
        // Якщо користувач натиснув «Очистити» — не показуємо рядки,
        // навіть якщо у settings щось лишилося. Прапор зберігається у
        // settings і переживає рестарт.
        if (!settings.recentItemsDismissed) {
          push("dp1", settings.dp1EngPath);
          push("dp2", settings.lastFolder);
          push("tgl", settings.tglBinPath);
          const rf: string[] = Array.isArray(settings.recentFolders) ? settings.recentFolders : [];
          for (const p of rf) push("dp2", p);
        }
        setRecentItems(items.slice(0, 8));
        if (settings.lastFolder) {
          window.dp2.corpusStatsWorker({ folder: settings.lastFolder })
            .then((stats) => {
              // На home показуємо «готовність редагування» — кількість рядків,
              // які явно затверджені через ПКМ → Затвердити (status="approved").
              // Це показує що "готово до пакування у гру", а не "просто щось
              // друкнуто". Якщо status.json порожній або approved=0 — fallback
              // на translatedEntries, щоб новий проєкт не показував 0% даремно.
              const approved = stats.approvedEntries;
              const done = typeof approved === "number" && approved > 0
                ? approved
                : stats.translatedEntries;
              setState((prev) => ({
                ...prev,
                dp2: {
                  hasPath: true,
                  progress: { done, total: stats.totalEntries },
                },
              }));
            })
            .catch(() => {});
        }
        // HBR corpus stats — рахуємо за наявності витягнутих файлів (Done/).
        // Може не виконатись, поки користувач не пройшов prep-wizard'у вперше.
        // IPC повертає structure: { ok, files, totalEntries, translatedEntries,
        // percent, uaWords, enWords, … } — той самий формат, що у DP2 stats.
        if (window.dp2.hbrCorpusStats) {
          window.dp2.hbrCorpusStats().then((r) => {
            if (!r || !r.ok) return;
            const total = r.totalEntries ?? 0;
            const done = r.translatedEntries ?? 0;
            setState((prev) => ({
              ...prev,
              hbr: {
                hasPath: true,
                progress: { done, total },
              },
            }));
          }).catch(() => {});
        }
        // DP1 corpus stats — Done/mes_all.json + Original (порівняння). IPC
        // returns translatedEntries + totalEntries (виключно visible).
        // Викликаємо безумовно, бо доцільніше показати "0/N" ніж "—".
        const dp1Api = window.dp2 as unknown as { dp1TextCorpusStats?: () => Promise<{ ok?: boolean; totalEntries?: number; translatedEntries?: number }> };
        if (dp1Api.dp1TextCorpusStats) {
          dp1Api.dp1TextCorpusStats().then((r) => {
            if (!r || !r.ok) return;
            const total = r.totalEntries ?? 0;
            const done = r.translatedEntries ?? 0;
            if (total === 0) return;
            setState((prev) => ({
              ...prev,
              dp1: { hasPath: true, progress: { done, total } },
            }));
          }).catch(() => {});
        }
        // MISSING corpus stats — швидкий шлях через main process (читає
        // Original + Done .dat і рахує translated за HAS_CYR predicate).
        const missingApi = window.dp2 as unknown as { missingCorpusStatsQuick?: () => Promise<{ ok?: boolean; total?: number; translated?: number; hasData?: boolean }> };
        if (missingApi.missingCorpusStatsQuick) {
          missingApi.missingCorpusStatsQuick().then((r) => {
            if (!r || !r.ok || !r.hasData) return;
            const total = r.total ?? 0;
            const done = r.translated ?? 0;
            setState((prev) => ({
              ...prev,
              missing: { hasPath: true, progress: { done, total } },
            }));
          }).catch(() => {});
        }

        // TGL corpus stats — підвантажуємо .bin (з .bak для originals) і
        // рахуємо translated через той самий predicate, що TglEditor.
        if (settings.tglBinPath) {
          window.dp2.tglLoad(settings.tglBinPath)
            .then((r: { ok?: boolean; records?: TglRecord[]; ua?: string[] }) => {
              if (!r || !r.ok || !r.records || !r.ua) return;
              const entries = flattenTgl(r.records, r.ua);
              const total = entries.length;
              let done = 0;
              for (const e of entries) if (isTglTranslated(e)) done++;
              setState((prev) => ({
                ...prev,
                tgl: { hasPath: true, progress: { done, total } },
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

      <div className="absolute top-3 right-4 z-10 flex items-center gap-2">
        <button
          className="dp-btn dp-btn--ghost !p-1.5"
          onClick={() => setAppSettingsOpen(true)}
          title={t("home.appSettings")}
          aria-label={t("home.appSettings")}
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
            <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
          </svg>
        </button>
        <LangToggle />
      </div>
      <AppSettingsModal open={appSettingsOpen} onClose={() => setAppSettingsOpen(false)} />

      <div className="relative z-[1] min-h-full flex flex-col items-center justify-center px-6 py-14">
        <div className="max-w-[1080px] w-full">
          {/* Header — Federal Bureau of Localization */}
          <header className="text-center mb-6">
            <span className="v2-bureau-mark">{t("home.v2.bureau")}</span>
            <h1 className="v2-hub-title">SWERY Localization Tool</h1>
            <p className="v2-hub-subtitle">{t("home.v2.tagline")}</p>
          </header>

          {/* Картки-теки */}
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-5 gap-x-5 gap-y-5 mb-8">
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

              const isDp1 = c.id === "dp1";
              const isDp2 = c.id === "dp2";
              const isTgl = c.id === "tgl";
              const isHbr = c.id === "hbr";
              const isMissing = c.id === "missing";
              const hasActions = isDp1 || isDp2 || isTgl || isHbr || isMissing;
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

                    {/* DP1: Текст + Шрифти + Текстури (XPC2 archive). */}
                    {isDp1 && (
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
                          className="v2-folder__action"
                          onClick={(e) => { e.stopPropagation(); onPickGame(c.id, "fonts"); }}
                        >
                          {t("home.v2.action.fonts")}
                        </button>
                        <button
                          type="button"
                          className="v2-folder__action"
                          onClick={(e) => { e.stopPropagation(); onPickGame(c.id, "textures"); }}
                        >
                          {t("home.v2.action.textures")}
                        </button>
                      </div>
                    )}
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
                          className="v2-folder__action"
                          onClick={(e) => { e.stopPropagation(); onPickGame(c.id, "fonts"); }}
                        >
                          {t("home.v2.action.fonts")}
                        </button>
                        <button
                          type="button"
                          className="v2-folder__action"
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
                          className="v2-folder__action"
                          onClick={(e) => { e.stopPropagation(); onPickGame(c.id, "fonts"); }}
                        >
                          {t("home.v2.action.fonts")}
                        </button>
                      </div>
                    )}
                    {/* HBR: Текст + Шрифти + Текстури */}
                    {isHbr && (
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
                          className="v2-folder__action"
                          onClick={(e) => { e.stopPropagation(); onPickGame(c.id, "fonts"); }}
                        >
                          {t("home.v2.action.fonts")}
                        </button>
                        <button
                          type="button"
                          className="v2-folder__action"
                          onClick={(e) => { e.stopPropagation(); onPickGame(c.id, "textures"); }}
                        >
                          {t("home.v2.action.textures")}
                        </button>
                      </div>
                    )}
                    {/* MISSING: Текст + Шрифти + Текстури */}
                    {isMissing && (
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
                          className="v2-folder__action"
                          onClick={(e) => { e.stopPropagation(); onPickGame(c.id, "fonts"); }}
                        >
                          {t("home.v2.action.fonts")}
                        </button>
                        <button
                          type="button"
                          className="v2-folder__action"
                          onClick={(e) => { e.stopPropagation(); onPickGame(c.id, "textures"); }}
                        >
                          {t("home.v2.action.textures")}
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
              <div className="flex items-center justify-between gap-3 mb-2">
                <h3 className="v2-recent-title m-0">{t("home.recent")}</h3>
                <button
                  type="button"
                  className="text-[11px] text-[var(--text-faint)] hover:text-[var(--text)] underline underline-offset-2 cursor-pointer bg-transparent border-0 p-0"
                  onClick={async () => {
                    // Просто ховаємо секцію на домівці. Шляхи у settings
                    // лишаємо як були — щоб ігри відкривались звичним кліком
                    // по картах. Прапор `recentItemsDismissed` зберігається,
                    // тож після рестарту секція теж лишається схована.
                    await window.dp2.saveSettings({ recentItemsDismissed: true } as Record<string, unknown>);
                    setRecentItems([]);
                  }}
                  title={t("home.recent.clearHint")}
                >
                  {t("home.recent.clear")}
                </button>
              </div>
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

          <section className="mb-10">
            <h3 className="v2-recent-title m-0 mb-2">{t("home.whatsNew")}</h3>
            {releasesStatus === "loading" && (
              <p className="text-[11px] italic" style={{ color: "var(--v2-paper)" }}>
                {t("home.whatsNew.loading")}
              </p>
            )}
            {releasesStatus === "empty" && (
              <p className="text-[11px] italic" style={{ color: "var(--v2-paper)" }}>
                {t("home.whatsNew.empty")}
              </p>
            )}
            {releasesStatus === "error" && (
              <p
                className="text-[11px] italic"
                style={{ color: "var(--v2-paper)" }}
                title={releasesError ?? undefined}
              >
                {t("home.whatsNew.error")}
              </p>
            )}
            {releasesStatus === "ready" && releases && (
              <ul className="v2-releases">
                {releases.map((r) => (
                  <li key={r.tag} className="v2-releases__item">
                    <button
                      className="v2-releases__btn"
                      onClick={() => window.dp2.openExternal(r.htmlUrl)}
                      title={r.htmlUrl}
                    >
                      <span className="v2-releases__tag">v{r.tag}</span>
                      <span className="v2-releases__name">{r.name || r.tag}</span>
                      <span className="v2-releases__date">
                        {new Date(r.publishedAt).toLocaleDateString()}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <footer className="v2-footer">
            <span>{t("home.setup.prompt")} </span>
            <button onClick={onOpenSetup}>{t("home.setup.button")}</button>
          </footer>
        </div>
      </div>
    </div>
  );
}
