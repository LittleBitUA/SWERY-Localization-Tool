// Модалка яка показує diff між OLD-bundle (з .bak) і NEW-bundle після
// patch-migrate. Допомагає перекладачу зрозуміти, що змінив розробник у
// тексті: які рядки додали, які видалили, які переписали.
//
// Архітектура виклику:
//   - Parent тримає стан "open" + arr Diff'ів (entries по файлах).
//   - Diff'и формуються у hbr/migrate-diff.ts (нижче в HbrEditor).
//   - Цей компонент — pure presentation: рендерить список з підсвіткою.

import { useEffect, useMemo, useState } from "react";
import { HighlightedText } from "../../components/HighlightedText";
import { useT } from "../../lib/i18n";

export interface MigrateDiffEntry {
  /** "added" — рядок є тільки у новому bundle, не було перекладу.
   *  "removed" — був, але зник з нового.
   *  "modified" — original змінився; старий переклад може не пасувати. */
  kind: "added" | "removed" | "modified";
  file: string;
  textId: string;
  variantIdx: number;
  oldOriginal?: string;
  newOriginal?: string;
  oldTranslation?: string;
}

interface Props {
  open: boolean;
  onClose: () => void;
  entries: MigrateDiffEntry[];
  oldBundle?: string;
  newBundle?: string;
}

type FilterKind = "all" | "added" | "removed" | "modified";

export function HbrMigrateDiffModal({ open, onClose, entries, oldBundle, newBundle }: Props) {
  const t = useT();
  const [filter, setFilter] = useState<FilterKind>("all");

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.preventDefault(); onClose(); } };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  const counts = useMemo(() => ({
    all: entries.length,
    added: entries.filter((e) => e.kind === "added").length,
    removed: entries.filter((e) => e.kind === "removed").length,
    modified: entries.filter((e) => e.kind === "modified").length,
  }), [entries]);

  const filtered = useMemo(() => {
    if (filter === "all") return entries;
    return entries.filter((e) => e.kind === filter);
  }, [entries, filter]);

  // Групуємо по файлу для зручності читання.
  const grouped = useMemo(() => {
    const m = new Map<string, MigrateDiffEntry[]>();
    for (const e of filtered) {
      if (!m.has(e.file)) m.set(e.file, []);
      m.get(e.file)!.push(e);
    }
    return Array.from(m.entries()).sort((a, b) => a[0].localeCompare(b[0]));
  }, [filtered]);

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-6" onClick={onClose}>
      <div
        className="w-full max-w-[920px] max-h-[88vh] bg-[var(--bg-surface)] border border-[var(--border-soft)] rounded-lg shadow-2xl overflow-hidden flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-5 py-3 border-b border-[var(--border-soft)] flex items-start gap-3">
          <span className="text-[18px]" aria-hidden>🧬</span>
          <div className="flex-1 min-w-0">
            <h2 className="text-[14px] font-semibold text-[var(--text-strong)]">{t("hbr.migrateDiff.title")}</h2>
            {(oldBundle || newBundle) && (
              <p className="text-[10.5px] text-[var(--text-faint)] font-mono truncate">
                {oldBundle ?? "?"} → {newBundle ?? "?"}
              </p>
            )}
          </div>
          <button className="dp-btn dp-btn--ghost" onClick={onClose}>✕</button>
        </div>

        <div className="px-5 py-2.5 border-b border-[var(--border-soft)] flex items-center gap-2 flex-wrap text-[11px]">
          <FilterBtn active={filter === "all"} onClick={() => setFilter("all")} tone="default">
            {t("hbr.migrateDiff.all")} <span className="text-[var(--text-faint)] ml-1">{counts.all}</span>
          </FilterBtn>
          <FilterBtn active={filter === "modified"} onClick={() => setFilter("modified")} tone="warning">
            ↻ {t("hbr.migrateDiff.modified")} <span className="ml-1 opacity-80">{counts.modified}</span>
          </FilterBtn>
          <FilterBtn active={filter === "added"} onClick={() => setFilter("added")} tone="success">
            + {t("hbr.migrateDiff.added")} <span className="ml-1 opacity-80">{counts.added}</span>
          </FilterBtn>
          <FilterBtn active={filter === "removed"} onClick={() => setFilter("removed")} tone="danger">
            − {t("hbr.migrateDiff.removed")} <span className="ml-1 opacity-80">{counts.removed}</span>
          </FilterBtn>
        </div>

        <div className="flex-1 overflow-y-auto">
          {grouped.length === 0 ? (
            <div className="px-5 py-10 text-center text-[12px] text-[var(--text-muted)]">
              {t("hbr.migrateDiff.empty")}
            </div>
          ) : (
            grouped.map(([fileName, list]) => (
              <section key={fileName} className="border-b border-[var(--border-soft)]">
                <div className="sticky top-0 z-10 bg-[var(--bg-surface)] px-5 py-1.5 text-[10.5px] font-mono text-[var(--text-faint)] border-b border-[var(--border-soft)]">
                  {fileName} <span className="text-[var(--text)]">·</span> {t("hbr.migrateDiff.changesN", { n: list.length })}
                </div>
                <ul className="divide-y divide-[var(--border-soft)]">
                  {list.map((e, i) => <DiffRow key={i} entry={e} />)}
                </ul>
              </section>
            ))
          )}
        </div>

        <div className="px-5 py-2.5 border-t border-[var(--border-soft)] flex items-center text-[10.5px] text-[var(--text-faint)]">
          <span>{t("hbr.migrateDiff.footerHint")}</span>
          <span className="ml-auto"><button className="dp-btn" onClick={onClose}>{t("hbr.migrateDiff.close")}</button></span>
        </div>
      </div>
    </div>
  );
}

function FilterBtn({ active, onClick, tone, children }: { active: boolean; onClick: () => void; tone: "default"|"success"|"danger"|"warning"; children: React.ReactNode }) {
  const toneCls: Record<typeof tone, string> = {
    default: active ? "bg-[var(--accent)]/15 border-[var(--accent)]/40 text-[var(--accent)]" : "border-transparent text-[var(--text-muted)]",
    success: active ? "bg-[var(--success)]/15 border-[var(--success)]/40 text-[var(--success)]" : "border-transparent text-[var(--text-muted)]",
    danger: active ? "bg-[var(--danger)]/15 border-[var(--danger)]/40 text-[var(--danger)]" : "border-transparent text-[var(--text-muted)]",
    warning: active ? "bg-[var(--warning,#d97706)]/15 border-[var(--warning,#d97706)]/40 text-[var(--warning,#d97706)]" : "border-transparent text-[var(--text-muted)]",
  };
  return (
    <button onClick={onClick} className={`px-2.5 py-1 rounded border transition-colors hover:bg-[var(--row-hover)] ${toneCls[tone]}`}>
      {children}
    </button>
  );
}

function DiffRow({ entry }: { entry: MigrateDiffEntry }) {
  const t = useT();
  const kindLabel: Record<MigrateDiffEntry["kind"], { icon: string; text: string; color: string }> = {
    added: { icon: "+", text: t("hbr.migrateDiff.added"), color: "var(--success)" },
    removed: { icon: "−", text: t("hbr.migrateDiff.removed"), color: "var(--danger)" },
    modified: { icon: "↻", text: t("hbr.migrateDiff.modified"), color: "var(--warning,#d97706)" },
  };
  const k = kindLabel[entry.kind];
  return (
    <li className="px-5 py-3 hover:bg-[var(--row-hover)]/40">
      <div className="flex items-baseline gap-2 mb-1.5">
        <span
          className="inline-flex items-center justify-center w-5 h-5 rounded text-[12px] font-bold shrink-0"
          style={{ color: k.color, background: `${k.color}1A`, border: `1px solid ${k.color}40` }}
          title={k.text}
        >{k.icon}</span>
        <span className="font-mono text-[10.5px] text-[var(--text-muted)]">{entry.textId}</span>
        <span className="font-mono text-[10px] text-[var(--text-faint)]">[v{entry.variantIdx}]</span>
        <span className="text-[10.5px]" style={{ color: k.color }}>{k.text}</span>
      </div>
      {entry.kind === "modified" && (
        <div className="grid grid-cols-2 gap-3 ml-7 text-[11.5px]">
          <div className="bg-[var(--danger)]/5 border border-[var(--danger)]/20 rounded px-2 py-1.5">
            <p className="text-[9px] uppercase tracking-wider text-[var(--text-faint)] mb-0.5">{t("hbr.migrateDiff.oldOriginal")}</p>
            <HighlightedText text={entry.oldOriginal ?? ""} className="text-[var(--text)] whitespace-pre-wrap break-words" />
          </div>
          <div className="bg-[var(--success)]/5 border border-[var(--success)]/20 rounded px-2 py-1.5">
            <p className="text-[9px] uppercase tracking-wider text-[var(--text-faint)] mb-0.5">{t("hbr.migrateDiff.newOriginal")}</p>
            <HighlightedText text={entry.newOriginal ?? ""} className="text-[var(--text)] whitespace-pre-wrap break-words" />
          </div>
        </div>
      )}
      {entry.kind === "added" && (
        <div className="ml-7 text-[11.5px] bg-[var(--success)]/5 border border-[var(--success)]/20 rounded px-2 py-1.5">
          <p className="text-[9px] uppercase tracking-wider text-[var(--text-faint)] mb-0.5">{t("hbr.migrateDiff.newOriginal")}</p>
          <HighlightedText text={entry.newOriginal ?? ""} className="text-[var(--text)] whitespace-pre-wrap break-words" />
        </div>
      )}
      {entry.kind === "removed" && (
        <div className="ml-7 text-[11.5px] bg-[var(--danger)]/5 border border-[var(--danger)]/20 rounded px-2 py-1.5">
          <p className="text-[9px] uppercase tracking-wider text-[var(--text-faint)] mb-0.5">{t("hbr.migrateDiff.removedRow")}</p>
          <HighlightedText text={entry.oldOriginal ?? ""} className="text-[var(--text)] whitespace-pre-wrap break-words" />
        </div>
      )}
      {entry.oldTranslation && (
        <div className="ml-7 mt-2 text-[11px] bg-[var(--bg)] border border-[var(--border-soft)] rounded px-2 py-1.5">
          <p className="text-[9px] uppercase tracking-wider text-[var(--text-faint)] mb-0.5">{t("hbr.migrateDiff.oldTranslation")}</p>
          <HighlightedText text={entry.oldTranslation} className="text-[var(--text-muted)] whitespace-pre-wrap break-words" />
        </div>
      )}
    </li>
  );
}
