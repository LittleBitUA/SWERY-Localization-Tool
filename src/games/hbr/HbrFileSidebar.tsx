// Розширений file-list для HbrEditor.
// На відміну від MISSING-sidebar, тут sidebar має ДВА режими:
//   1. file-tree mode (default): пошук за іменем файлу + sort + tabs.
//   2. global-hits mode: коли користувач робив global text search,
//      sidebar показує hits з jumpToHit. Цей режим керується ззовні.
//
// + Resizable width: drag-resize правої грані. Стан у localStorage.

import { useEffect, useMemo, useRef, useState } from "react";
import { useT } from "../../lib/i18n";
import { useLocalStorage } from "../../lib/useLocalStorage";

export interface SidebarFile {
  file: string;
  donePath: string;
  origPath: string;
  size: number;
}

interface Stats { total: number; translated: number }

interface Props {
  files: SidebarFile[];
  activeKey: string | null;
  fileStats: Record<string, Stats>;
  /** Бонус-translated по кожному файлу (наприклад markedTranslated через ПКМ). */
  extraTranslated?: Map<string, number>;
  /** Global text search input. Контролюється з parent (бо результат рендериться нижче). */
  globalQuery: string;
  onGlobalQueryChange: (q: string) => void;
  onGlobalSearch: () => void;
  globalSearching: boolean;
  /** Global search hits (якщо null — sidebar показує file-list). */
  globalHits: Array<{ file: SidebarFile; textId: string; variantIdx: number; snippet: string }> | null;
  onClearGlobal: () => void;
  onJumpToHit: (h: { file: SidebarFile; textId: string; variantIdx: number }) => void;
  /** Pick file (clicked у file-list). */
  onPick: (f: SidebarFile) => void;
  /** ПКМ по файлу — bubbled з-зовні (для glossary, mark-all, etc.). */
  onFileContextMenu?: (e: React.MouseEvent, f: SidebarFile) => void;
}

type SortKey = "name" | "percent" | "size";
type TabKey = "all" | "incomplete" | "complete";

export function HbrFileSidebar({
  files, activeKey, fileStats, extraTranslated,
  globalQuery, onGlobalQueryChange, onGlobalSearch, globalSearching, globalHits, onClearGlobal, onJumpToHit,
  onPick, onFileContextMenu,
}: Props) {
  const t = useT();
  const [nameQuery, setNameQuery] = useLocalStorage<string>("hbr.sidebar.q", "");
  const [tab, setTab] = useLocalStorage<TabKey>("hbr.sidebar.tab", "all");
  const [sort, setSort] = useLocalStorage<SortKey>("hbr.sidebar.sort", "name");
  // Resizable width. Default 300, мін 220, макс 520.
  const [width, setWidth] = useLocalStorage<number>("hbr.sidebar.w", 300);
  const dragRef = useRef<{ startX: number; startW: number } | null>(null);
  const sideRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!dragRef.current) return;
      const dx = e.clientX - dragRef.current.startX;
      const next = Math.max(220, Math.min(520, dragRef.current.startW + dx));
      setWidth(next);
    };
    const onUp = () => { dragRef.current = null; document.body.style.cursor = ""; document.body.style.userSelect = ""; };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => { window.removeEventListener("mousemove", onMove); window.removeEventListener("mouseup", onUp); };
  }, [setWidth]);

  const getStats = (f: SidebarFile): Stats | undefined => {
    const base = fileStats[f.file];
    if (!base) return undefined;
    const extra = extraTranslated?.get(f.file) ?? 0;
    return { total: base.total, translated: base.translated + extra };
  };

  const filtered = useMemo(() => {
    const q = nameQuery.trim().toLowerCase();
    const list = files.filter((f) => {
      if (q && !f.file.toLowerCase().includes(q)) return false;
      const st = getStats(f);
      if (tab === "incomplete" && st && st.total > 0 && st.translated >= st.total) return false;
      if (tab === "complete" && (!st || st.total === 0 || st.translated < st.total)) return false;
      return true;
    });
    list.sort((a, b) => {
      if (sort === "percent") {
        const sa = getStats(a), sb = getStats(b);
        const ap = sa && sa.total > 0 ? sa.translated / sa.total : 0;
        const bp = sb && sb.total > 0 ? sb.translated / sb.total : 0;
        if (bp !== ap) return bp - ap;
      }
      if (sort === "size") {
        if (b.size !== a.size) return b.size - a.size;
      }
      return a.file.localeCompare(b.file);
    });
    return list;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [files, nameQuery, tab, sort, fileStats, extraTranslated]);

  const counts = useMemo(() => {
    let complete = 0, incomplete = 0;
    for (const f of files) {
      const st = getStats(f);
      if (st && st.total > 0 && st.translated >= st.total) complete++;
      else incomplete++;
    }
    return { all: files.length, complete, incomplete };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [files, fileStats, extraTranslated]);

  return (
    <aside
      ref={sideRef}
      className="shrink-0 border-r border-[var(--border-soft)] flex flex-col min-h-0 relative"
      style={{ width }}
    >
      {/* Global text-search (raw bundle). */}
      <div className="px-2.5 py-2 border-b border-[var(--border-soft)] flex flex-col gap-1.5">
        <div className="flex items-center gap-1">
          <input
            className="dp-input flex-1 text-[11px] h-7"
            placeholder={t("hbr.globalSearch.placeholder")}
            value={globalQuery}
            onChange={(e) => onGlobalQueryChange(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") onGlobalSearch(); }}
          />
          <button
            className="dp-btn h-7 px-2"
            onClick={onGlobalSearch}
            disabled={globalSearching || !globalQuery.trim()}
            title={t("hbr.globalSearch.searchHint")}
          >
            {globalSearching ? "…" : "🔍"}
          </button>
          {globalHits !== null && (
            <button className="dp-btn dp-btn--ghost h-7 px-2" onClick={onClearGlobal} title={t("hbr.globalSearch.clear")}>✕</button>
          )}
        </div>
        {globalHits !== null && (
          <p className="text-[10px] text-[var(--text-faint)] tabular-nums">
            {t("hbr.globalSearch.foundN", { n: globalHits.length })}
          </p>
        )}
      </div>

      {/* File-tree controls (тільки коли НЕ показуємо global hits). */}
      {globalHits === null && (
        <div className="px-2.5 py-2 border-b border-[var(--border-soft)] flex flex-col gap-1.5">
          <div className="flex items-center gap-1.5">
            <input
              className="dp-input flex-1 text-[11px] h-7"
              placeholder={t("hbr.sidebar.searchPlaceholder")}
              value={nameQuery}
              onChange={(e) => setNameQuery(e.target.value)}
            />
            {nameQuery && (
              <button className="text-[var(--text-faint)] hover:text-[var(--text)] text-[14px] px-1" onClick={() => setNameQuery("")} title={t("hbr.sidebar.clear")}>×</button>
            )}
          </div>
          <div className="flex gap-1 text-[10px]">
            <TabBtn active={tab === "all"} onClick={() => setTab("all")}>{t("hbr.sidebar.tabAll")} <span className="text-[var(--text-faint)]">{counts.all}</span></TabBtn>
            <TabBtn active={tab === "incomplete"} onClick={() => setTab("incomplete")}>{t("hbr.sidebar.tabIncomplete")} <span className="text-[var(--text-faint)]">{counts.incomplete}</span></TabBtn>
            <TabBtn active={tab === "complete"} onClick={() => setTab("complete")}>{t("hbr.sidebar.tabComplete")} <span className="text-[var(--text-faint)]">{counts.complete}</span></TabBtn>
          </div>
          <div className="flex items-center gap-1.5 text-[10px] text-[var(--text-faint)]">
            <span>{t("hbr.sidebar.sortLabel")}</span>
            <select
              className="bg-transparent text-[var(--text)] outline-none cursor-pointer"
              value={sort}
              onChange={(e) => setSort(e.target.value as SortKey)}
            >
              <option value="name">{t("hbr.sidebar.sortName")}</option>
              <option value="percent">{t("hbr.sidebar.sortPercent")}</option>
              <option value="size">{t("hbr.sidebar.sortSize")}</option>
            </select>
            <span className="ml-auto text-[var(--text-faint)] tabular-nums">{filtered.length}/{files.length}</span>
          </div>
        </div>
      )}

      {/* Body: hits OR file-list */}
      <div className="flex-1 overflow-y-auto">
        {globalHits !== null ? (
          globalHits.length === 0 ? (
            <p className="px-3 py-3 text-[11.5px] text-[var(--text-muted)] text-center">{t("hbr.globalSearch.empty")}</p>
          ) : (
            globalHits.map((h, i) => (
              <button
                key={i}
                onClick={() => onJumpToHit(h)}
                className="w-full text-left px-3 py-2 border-b border-[var(--border-soft)] hover:bg-[var(--row-hover)]"
              >
                <p className="text-[10px] font-mono text-[var(--text-faint)] truncate" title={h.file.file}>{h.file.file}</p>
                <p className="text-[10.5px] font-mono text-[var(--text-muted)] truncate">
                  {h.textId} <span className="text-[var(--text-faint)]">[v{h.variantIdx}]</span>
                </p>
                <p className="text-[11.5px] text-[var(--text)] mt-0.5 line-clamp-2 break-words">{h.snippet}</p>
              </button>
            ))
          )
        ) : (
          <>
            {filtered.length === 0 && (
              <div className="px-3 py-4 text-center text-[11px] text-[var(--text-faint)] italic">{t("hbr.sidebar.empty")}</div>
            )}
            {filtered.map((f) => {
              const st = getStats(f);
              const pct = st && st.total > 0 ? Math.round((st.translated / st.total) * 100) : 0;
              const isActive = activeKey === f.donePath;
              const borderColor = !st || pct === 0
                ? "border-l-[var(--danger)]"
                : pct >= 100
                  ? "border-l-[var(--success)]"
                  : "border-l-[var(--warning,#d97706)]";
              const barColor = pct === 0
                ? "bg-[var(--danger)]"
                : pct >= 100
                  ? "bg-[var(--success)]"
                  : "bg-[var(--warning,#d97706)]";
              return (
                <button
                  key={f.donePath}
                  onClick={() => onPick(f)}
                  onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); onFileContextMenu?.(e, f); }}
                  className={`w-full text-left px-3 py-2 border-b border-[var(--border-soft)] border-l-2 ${borderColor} hover:bg-[var(--row-hover)] ${isActive ? "bg-[var(--row-active)]" : ""}`}
                >
                  <p className="text-[11.5px] font-mono text-[var(--text)] truncate" title={f.file}>{f.file}</p>
                  {st && (
                    <div className="flex items-center gap-2 mt-1">
                      <div className="flex-1 h-1 bg-[var(--bg-elevated)] rounded overflow-hidden">
                        <div className={`h-full transition-all ${barColor}`} style={{ width: `${pct}%` }} />
                      </div>
                      <span className="text-[10px] font-mono tabular-nums text-[var(--text-faint)] shrink-0">
                        {st.translated}/{st.total} · {pct}%
                      </span>
                    </div>
                  )}
                </button>
              );
            })}
          </>
        )}
      </div>

      {/* Drag-resize handle на правому краю. */}
      <div
        className="absolute top-0 right-0 w-1 h-full cursor-col-resize bg-transparent hover:bg-[var(--accent)]/30 transition-colors"
        onMouseDown={(e) => {
          dragRef.current = { startX: e.clientX, startW: width };
          document.body.style.cursor = "col-resize";
          document.body.style.userSelect = "none";
        }}
        title={t("hbr.sidebar.resizeHint")}
      />
    </aside>
  );
}

function TabBtn({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={`flex-1 px-1.5 py-1 rounded text-[10px] border transition-colors ${
        active
          ? "bg-[var(--accent)]/15 border-[var(--accent)]/40 text-[var(--accent)]"
          : "border-transparent text-[var(--text-muted)] hover:bg-[var(--row-hover)]"
      }`}
    >
      {children}
    </button>
  );
}
