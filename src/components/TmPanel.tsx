import { useEffect, useMemo, useState } from "react";
import { useStore } from "../lib/store";
import { buildTm, findMatches, type TmMatch } from "../lib/tm";
import { findGlossaryHits, type GlossaryEntry } from "../lib/glossary";
import { useT } from "../lib/i18n";

interface TmPanelProps {
  glossary: GlossaryEntry[];
  onOpenGlossary: () => void;
  /** Опційні prop'и — щоб панель працювала і для DP1, не лише DP2. */
  query?: string;
  excludeTgt?: string;
  onApply?: (tgt: string) => void;
  dp2Folder?: string | null;
  dp1EngPath?: string | null;
  /** Тригер ре-білду TM (наприклад saveTick з відповідного store). */
  refreshKey?: number;
}

export function TmPanel({
  glossary,
  onOpenGlossary,
  query: queryProp,
  excludeTgt: excludeTgtProp,
  onApply: onApplyProp,
  dp2Folder: dp2FolderProp,
  dp1EngPath: dp1EngPathProp,
  refreshKey,
}: TmPanelProps) {
  const t = useT();
  const dp2StoreFolder = useStore((s) => s.folder);
  const entries = useStore((s) => s.entries);
  const activeIndex = useStore((s) => s.activeIndex);
  const updateActive = useStore((s) => s.updateActive);
  const saveTick = useStore((s) => s.saveTick);

  const [tm, setTm] = useState<Awaited<ReturnType<typeof buildTm>> | null>(null);
  const [loading, setLoading] = useState(false);

  // Якщо пропси не передано — користуємось DP2-store (legacy mode).
  const useStoreFallback = queryProp === undefined;
  const dp2Folder = dp2FolderProp !== undefined ? dp2FolderProp : (useStoreFallback ? dp2StoreFolder : null);

  // dp1EngPath — або з пропсу, або з settings.
  const [dp1Settings, setDp1Settings] = useState<string | null>(null);
  useEffect(() => {
    if (dp1EngPathProp !== undefined) return;
    window.dp2.getSettings().then((s) => {
      const p = (s as any).dp1EngPath as string | undefined;
      setDp1Settings(p && p.trim() ? p : null);
    });
  }, [dp1EngPathProp]);
  const dp1EngPath = dp1EngPathProp !== undefined ? dp1EngPathProp : dp1Settings;

  const trigger = refreshKey ?? saveTick;
  useEffect(() => {
    if (!dp2Folder && !dp1EngPath) {
      setTm([]);
      return;
    }
    setLoading(true);
    buildTm(dp2Folder, dp1EngPath)
      .then(setTm)
      .finally(() => setLoading(false));
  }, [dp2Folder, dp1EngPath, trigger]);

  // Активний запис для DP2 fallback.
  const dp2Active = useStoreFallback && activeIndex !== null ? entries[activeIndex] : null;
  const query = queryProp !== undefined
    ? queryProp
    : (dp2Active ? (dp2Active.originalEn ?? dp2Active.en) : "");
  const excludeTgt = excludeTgtProp !== undefined
    ? excludeTgtProp
    : (dp2Active?.en ?? "");

  const matches: TmMatch[] = useMemo(() => {
    if (!tm || !query) return [];
    return findMatches(tm, query, excludeTgt, 6);
  }, [tm, query, excludeTgt]);

  const glossaryHits = useMemo(() => {
    const text = query || "";
    return findGlossaryHits(text, glossary);
  }, [query, glossary]);

  function applyTranslation(tgt: string) {
    if (onApplyProp) { onApplyProp(tgt); return; }
    if (dp2Active) updateActive(dp2Active.charaName ?? "", tgt);
  }

  if (!dp2Folder && !dp1EngPath) return null;

  return (
    <aside className="h-full shrink-0 border-l border-[var(--border-soft)] bg-[var(--bg-surface)] flex flex-col">
      <div className="px-3 h-9 flex items-center justify-between border-b border-[var(--border-soft)]">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
          {t("tm.title")}
        </span>
        <button
          className="dp-btn dp-btn--ghost text-[10px]"
          onClick={onOpenGlossary}
          title={t("tm.glossaryBtn")}
        >
          {t("tm.glossaryBtn")}
        </button>
      </div>

      <div className="flex-1 overflow-y-auto">
        {/* Glossary hits */}
        {glossaryHits.length > 0 && (
          <div className="px-3 py-2 border-b border-[var(--border-soft)]">
            <p className="text-[10px] uppercase tracking-wider text-[var(--text-faint)] mb-1.5">
              {t("tm.terms")}
            </p>
            <ul className="space-y-1">
              {glossaryHits.map((g, i) => (
                <li key={i} className="text-[12px] flex items-baseline gap-2">
                  <span className="font-mono text-[var(--text-muted)] truncate" title={g.src}>
                    {g.src}
                  </span>
                  <span className="text-[var(--text-faint)]">→</span>
                  <span className="text-[var(--text)] font-semibold truncate" title={g.tgt}>
                    {g.tgt}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* TM matches */}
        <div className="px-3 py-2">
          <div className="flex items-center justify-between mb-1.5">
            <p className="text-[10px] uppercase tracking-wider text-[var(--text-faint)]">
              {t("tm.matches")}
            </p>
            {tm && (
              <span className="text-[10px] text-[var(--text-faint)] tabular-nums">
                {tm.length}
              </span>
            )}
          </div>

          {loading && (
            <p className="text-[12px] text-[var(--text-faint)] italic">{t("tm.loading")}</p>
          )}

          {!loading && !query && (
            <p className="text-[12px] text-[var(--text-faint)] italic">{t("tm.empty.pick")}</p>
          )}

          {!loading && query && matches.length === 0 && (
            <p className="text-[12px] text-[var(--text-faint)] italic">{t("tm.empty.none")}</p>
          )}

          {!loading && matches.map((m, i) => {
            const isExact = m.score >= 0.999;
            return (
              <div
                key={i}
                className="mb-2 border border-[var(--border-soft)] rounded-md p-2 bg-[var(--bg)]"
              >
                <div className="flex items-center justify-between mb-1 gap-1">
                  <div className="flex items-center gap-1">
                    <span
                      className={`dp-pill ${
                        isExact ? "dp-pill--success" : "dp-pill--info"
                      }`}
                    >
                      {isExact ? "100%" : `${Math.round(m.score * 100)}%`}
                    </span>
                    <span className="dp-pill" title={m.entry.source === "dp1" ? "Deadly Premonition" : "Deadly Premonition 2"}>
                      {m.entry.source.toUpperCase()}
                    </span>
                  </div>
                  <span className="text-[10px] font-mono text-[var(--text-faint)] truncate" title={m.entry.fileName}>
                    {m.entry.fileName}
                  </span>
                </div>
                <p className="text-[11px] text-[var(--text-muted)] leading-snug mb-1 line-clamp-2">
                  {m.entry.src}
                </p>
                <p className="text-[12px] text-[var(--text)] leading-snug mb-1.5 line-clamp-3">
                  {m.entry.tgt}
                </p>
                <button
                  className="dp-btn dp-btn--ghost text-[10px] w-full"
                  onClick={() => applyTranslation(m.entry.tgt)}
                  title={t("btn.apply")}
                >
                  {t("btn.apply")}
                </button>
              </div>
            );
          })}
        </div>
      </div>
    </aside>
  );
}
