// Розширений file-list для MissingEditor.
// Замість простого map() з 50+ файлів додаємо:
//   - search input (фільтрує по m_Name)
//   - tabs: усі / незавершені / завершені
//   - sort: ім'я / %перекладено / розмір
// Стан зберігається у localStorage, щоб переходи зберігали налаштування.

import { useMemo } from "react";
import { useLocalStorage } from "../../lib/useLocalStorage";

export interface SidebarFile {
  name: string;
  file: string;
  scriptLen: number;
}

interface Stats { total: number; translated: number }

interface Props {
  files: SidebarFile[];
  activeKey: string | null;
  fileStats: Record<string, Stats>;
  onPick: (f: SidebarFile) => void;
}

type SortKey = "name" | "percent" | "size";
type TabKey = "all" | "incomplete" | "complete";

export function MissingFileSidebar({ files, activeKey, fileStats, onPick }: Props) {
  const [query, setQuery] = useLocalStorage<string>("missing.sidebar.q", "");
  const [tab, setTab] = useLocalStorage<TabKey>("missing.sidebar.tab", "all");
  const [sort, setSort] = useLocalStorage<SortKey>("missing.sidebar.sort", "name");

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = files.filter((f) => {
      if (q && !f.name.toLowerCase().includes(q)) return false;
      const st = fileStats[f.file];
      const pct = st && st.total > 0 ? st.translated / st.total : 0;
      if (tab === "incomplete" && st && pct >= 1) return false;
      if (tab === "complete" && (!st || pct < 1)) return false;
      return true;
    });
    list.sort((a, b) => {
      if (sort === "percent") {
        const ap = fileStats[a.file] && fileStats[a.file].total > 0 ? fileStats[a.file].translated / fileStats[a.file].total : 0;
        const bp = fileStats[b.file] && fileStats[b.file].total > 0 ? fileStats[b.file].translated / fileStats[b.file].total : 0;
        if (bp !== ap) return bp - ap;
      }
      if (sort === "size") {
        if (b.scriptLen !== a.scriptLen) return b.scriptLen - a.scriptLen;
      }
      return a.name.localeCompare(b.name);
    });
    return list;
  }, [files, query, tab, sort, fileStats]);

  // Aggregated counts for tabs.
  const counts = useMemo(() => {
    let complete = 0, incomplete = 0;
    for (const f of files) {
      const st = fileStats[f.file];
      if (st && st.total > 0 && st.translated >= st.total) complete++;
      else incomplete++;
    }
    return { all: files.length, complete, incomplete };
  }, [files, fileStats]);

  return (
    <aside className="w-[280px] shrink-0 border-r border-[var(--border-soft)] flex flex-col min-h-0">
      <div className="px-2.5 py-2 border-b border-[var(--border-soft)] flex flex-col gap-1.5">
        <div className="flex items-center gap-1.5">
          <input
            className="dp-input flex-1 text-[11px] h-7"
            placeholder="Пошук файлів…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          {query && (
            <button
              className="text-[var(--text-faint)] hover:text-[var(--text)] text-[14px] px-1"
              onClick={() => setQuery("")}
              title="Очистити пошук"
            >×</button>
          )}
        </div>
        <div className="flex gap-1 text-[10px]">
          <TabBtn active={tab === "all"} onClick={() => setTab("all")}>Усі <span className="text-[var(--text-faint)]">{counts.all}</span></TabBtn>
          <TabBtn active={tab === "incomplete"} onClick={() => setTab("incomplete")}>Незавершені <span className="text-[var(--text-faint)]">{counts.incomplete}</span></TabBtn>
          <TabBtn active={tab === "complete"} onClick={() => setTab("complete")}>Готові <span className="text-[var(--text-faint)]">{counts.complete}</span></TabBtn>
        </div>
        <div className="flex items-center gap-1.5 text-[10px] text-[var(--text-faint)]">
          <span>Сорт:</span>
          <select
            className="bg-transparent text-[var(--text)] outline-none cursor-pointer"
            value={sort}
            onChange={(e) => setSort(e.target.value as SortKey)}
          >
            <option value="name">за ім'ям</option>
            <option value="percent">за %</option>
            <option value="size">за розміром</option>
          </select>
          <span className="ml-auto text-[var(--text-faint)] tabular-nums">{filtered.length}/{files.length}</span>
        </div>
      </div>
      <div className="flex-1 overflow-auto">
        {filtered.length === 0 && (
          <div className="px-3 py-4 text-center text-[11px] text-[var(--text-faint)] italic">
            Нічого не знайдено
          </div>
        )}
        {filtered.map((f) => {
          const st = fileStats[f.file];
          const pct = st && st.total > 0 ? Math.round((st.translated / st.total) * 100) : 0;
          const isActive = activeKey === f.file;
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
              key={f.file}
              onClick={() => onPick(f)}
              className={`w-full text-left px-3 py-2 border-b border-[var(--border-soft)] border-l-2 ${borderColor} hover:bg-[var(--row-hover)] ${isActive ? "bg-[var(--row-active)]" : ""}`}
            >
              <p className="text-[11.5px] font-mono text-[var(--text)] truncate" title={f.name}>{f.name}</p>
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
      </div>
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
