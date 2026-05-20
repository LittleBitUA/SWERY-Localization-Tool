import { useEffect, useState } from "react";
import { useT } from "../lib/i18n";
import type { CorpusStats } from "../lib/ipc";

interface Props {
  open: boolean;
  onClose: () => void;
  mode: "dp1" | "dp2" | "hbr" | "missing";
  /** Для DP2 — тека з JSON-дампами. Для HBR/DP1 ігнорується (вони використовують
   *  computeCustomStats — повний IPC у main процесі). */
  folder?: string | null;
  /** Готова статистика (для mode="missing" чи будь-якого зовнішнього розрахунку). */
  customStats?: CorpusStats | null;
  /** Якщо потрібно перебудувати customStats — callback, що повертає CorpusStats. */
  computeCustomStats?: () => Promise<CorpusStats | null>;
}

function fmt(n: number): string {
  return n.toLocaleString("uk-UA").replace(/ /g, " ");
}

export function CorpusStatsModal({ open, onClose, mode, folder, customStats, computeCustomStats }: Props) {
  const t = useT();
  const [loading, setLoading] = useState(false);
  const [data, setData] = useState<CorpusStats | null>(null);
  const [tick, setTick] = useState(0);

  // DP2: запит у worker. HBR: окремий main-process IPC, що читає Done/Original
  // безпосередньо (його структура _List/_Texts/Array відрізняється від DP2).
  // Перезбираємо при кожному відкритті, щоб бачити зміни після save.
  useEffect(() => {
    if (!open) return;
    // Для missing mode (або будь-якого з зовнішнім compute-callback'ом).
    if (mode === "missing" || computeCustomStats) {
      let cancelled = false;
      setLoading(true);
      const p = computeCustomStats ? computeCustomStats() : Promise.resolve(customStats ?? null);
      Promise.resolve(p)
        .then((r) => { if (!cancelled) setData(r); })
        .catch(() => { if (!cancelled) setData(null); })
        .finally(() => { if (!cancelled) setLoading(false); });
      return () => { cancelled = true; };
    }
    let cancelled = false;
    setLoading(true);
    const fetcher = mode === "hbr"
      ? window.dp2.hbrCorpusStats().then((r) => r.ok ? ({
          files: r.files ?? 0,
          totalEntries: r.totalEntries ?? 0,
          translatedEntries: r.translatedEntries ?? 0,
          percent: r.percent ?? 0,
          uaWords: r.uaWords ?? 0,
          enWords: r.enWords ?? 0,
          uaChars: r.uaChars ?? 0,
          enChars: r.enChars ?? 0,
          topFiles: r.topFiles ?? [],
        } as CorpusStats) : null)
      : (folder ? window.dp2.corpusStatsWorker({ folder }) : Promise.resolve(null));
    Promise.resolve(fetcher)
      .then((res) => { if (!cancelled) setData(res); })
      .catch(() => { if (!cancelled) setData(null); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [open, mode, folder, tick]);

  // ESC закриває
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  const subtitle = t("stats.subtitle");
  const emptyMsg = t("stats.empty");
  // HBR/missing не залежать від `folder` (IPC або client-side compute).
  const isEmpty = mode === "dp2" ? !folder : false;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-6 bg-black/70"
      onClick={onClose}
    >
      <div
        className="dp-card w-full max-w-3xl flex flex-col"
        style={{ maxHeight: "85vh" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-3 px-5 py-3 border-b border-[var(--border-soft)]">
          <div className="min-w-0 flex-1">
            <h2 className="text-[15px] font-semibold text-[var(--text-strong)]">
              {t("stats.title")}
            </h2>
            <p className="text-[12px] text-[var(--text-muted)] mt-0.5 truncate">{subtitle}</p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {(mode === "dp2" || mode === "hbr" || mode === "missing") && (
              <button
                onClick={() => setTick((x) => x + 1)}
                className="dp-btn"
                disabled={loading || (mode === "dp2" && !folder)}
                title={t("stats.refresh")}
              >
                {t("stats.refresh")}
              </button>
            )}
            <button onClick={onClose} className="dp-btn dp-btn--ghost !w-7 !p-0">
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-auto p-5">
          {isEmpty ? (
            <p className="py-10 text-center text-[13px] text-[var(--text-muted)]">{emptyMsg}</p>
          ) : loading || !data ? (
            <p className="py-10 text-center text-[13px] text-[var(--text-muted)]">{t("stats.loading")}</p>
          ) : (
            <>
              {/* Сумарний прогрес-бар */}
              <div className="mb-5">
                <div className="flex items-end justify-between mb-2">
                  <span className="text-[11px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
                    {t("stats.summary")}
                  </span>
                  <span className="text-[28px] font-bold tabular-nums leading-none text-[var(--success)]">
                    {data.percent.toFixed(2).replace(".", ",")}%
                  </span>
                </div>
                <div className="h-2 bg-[var(--bg)] rounded overflow-hidden border border-[var(--border-soft)]">
                  <div
                    className="h-full bg-[var(--success)]"
                    style={{ width: `${Math.min(100, data.percent)}%` }}
                  />
                </div>
                <div className="flex justify-between text-[11px] text-[var(--text-faint)] mt-1 tabular-nums">
                  <span>{t("stats.translated")}: <span className="text-[var(--success)] font-semibold">{fmt(data.translatedEntries)}</span></span>
                  <span>{t("stats.untranslated")}: <span className="text-[var(--text)] font-semibold">{fmt(data.totalEntries - data.translatedEntries)}</span></span>
                  <span>{t("stats.totalEntries")}: <span className="text-[var(--text)] font-semibold">{fmt(data.totalEntries)}</span></span>
                </div>
              </div>

              {/* Картки метрик */}
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-5">
                <StatCard label={t("stats.files")} value={fmt(data.files)} />
                <StatCard label={t("stats.totalEntries")} value={fmt(data.totalEntries)} />
                <StatCard label={t("stats.uaWords")} value={fmt(data.uaWords)} tone="success" />
                <StatCard label={t("stats.enWords")} value={fmt(data.enWords)} tone="muted" />
                <StatCard label={t("stats.uaChars")} value={fmt(data.uaChars)} tone="success" />
                <StatCard label={t("stats.enChars")} value={fmt(data.enChars)} tone="muted" />
                <StatCard label={t("stats.translated")} value={fmt(data.translatedEntries)} tone="success" />
                <StatCard label={t("stats.untranslated")} value={fmt(data.totalEntries - data.translatedEntries)} tone="muted" />
              </div>

              {/* Топ файлів — приховуємо для DP1 (там один файл, нецікаво) */}
              {data.topFiles.length > 0 && (
                <div>
                  <h3 className="text-[11px] font-semibold uppercase tracking-wider text-[var(--text-muted)] mb-2">
                    {t("stats.topFiles")}
                  </h3>
                  <div className="border border-[var(--border-soft)] rounded overflow-hidden">
                    <table className="w-full text-[12px]">
                      <thead className="bg-[var(--bg)] text-[10px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
                        <tr>
                          <th className="text-left px-3 py-1.5">{t("stats.col.file")}</th>
                          <th className="text-right px-3 py-1.5">{t("stats.col.translated")}</th>
                          <th className="text-right px-3 py-1.5">{t("stats.col.total")}</th>
                          <th className="text-right px-3 py-1.5 w-[120px]">{t("stats.col.percent")}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {data.topFiles.map((f) => (
                          <tr key={f.filePath} className="border-t border-[var(--border-soft)]">
                            <td className="px-3 py-1.5 font-mono text-[11px] text-[var(--text-muted)] truncate max-w-[300px]" title={f.filePath}>
                              {f.fileName}
                            </td>
                            <td className="px-3 py-1.5 text-right tabular-nums text-[var(--success)]">{fmt(f.translated)}</td>
                            <td className="px-3 py-1.5 text-right tabular-nums">{fmt(f.total)}</td>
                            <td className="px-3 py-1.5 text-right tabular-nums">
                              <div className="flex items-center gap-2 justify-end">
                                <div className="h-1.5 bg-[var(--bg)] rounded overflow-hidden border border-[var(--border-soft)] flex-1 max-w-[60px]">
                                  <div className="h-full bg-[var(--success)]" style={{ width: `${Math.min(100, f.percent)}%` }} />
                                </div>
                                <span className="text-[var(--text-muted)] min-w-[44px] text-right">
                                  {f.percent.toFixed(1).replace(".", ",")}%
                                </span>
                              </div>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function StatCard({ label, value, tone }: { label: string; value: string; tone?: "success" | "muted" }) {
  const valueColor = tone === "success" ? "text-[var(--success)]"
    : tone === "muted" ? "text-[var(--text-muted)]"
    : "text-[var(--text-strong)]";
  return (
    <div className="border border-[var(--border-soft)] rounded p-3 bg-[var(--bg)]">
      <p className="text-[10px] uppercase tracking-wider text-[var(--text-faint)] mb-1">{label}</p>
      <p className={`text-[18px] font-bold tabular-nums leading-none ${valueColor}`}>{value}</p>
    </div>
  );
}
