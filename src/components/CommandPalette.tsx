// Універсальна command palette (Ctrl+K). Розв'язує проблему overload'у
// у хедері: один шорткат, fuzzy-search по всіх діях + файлах + контексті.
// Використовується у MISSING та HBR редакторах.
//
// Дизайн mirror'ить VS Code / Linear: затемнення → центрована панель з
// інпутом зверху + список нижче. Стрілки навігують, Enter виконує, Esc
// закриває. Тіло — flat list з categories через `# kind` хедери.

import { useEffect, useMemo, useRef, useState } from "react";

export interface CommandItem {
  id: string;
  /** Що показуємо у списку. */
  label: string;
  /** Опційно: іконка/emoji у preview-точці. */
  icon?: string;
  /** Опційно: hint (короткий контекст), показуємо праворуч. */
  hint?: string;
  /** Опційно: гаряча клавіша. */
  shortcut?: string;
  /** Опційно: категорія (групує). */
  category?: string;
  /** Опційно: keywords для fuzzy-search (крім label). */
  keywords?: string;
  /** disabled — сірий, не клікається. */
  disabled?: boolean;
  /** Що виконати. */
  run: () => void;
}

interface Props {
  open: boolean;
  onClose: () => void;
  items: CommandItem[];
}

// Простий fuzzy-match: повертає score або null. Higher = better.
// Алгоритм наївний (substring + word-start bonus), але цього вистачає для ~200 items.
function fuzzyScore(haystack: string, needle: string): number | null {
  if (!needle) return 1;
  const h = haystack.toLowerCase();
  const n = needle.toLowerCase();
  if (h === n) return 1000;
  if (h.startsWith(n)) return 500;
  const idx = h.indexOf(n);
  if (idx >= 0) {
    // Бонус, якщо match починається на word boundary (пробіл/тире/слеш).
    const prev = idx > 0 ? h[idx - 1] : " ";
    const boundary = /\s|[-/:_]/.test(prev) ? 100 : 0;
    return 200 + boundary - idx;
  }
  // Гліфовий subsequence: chars знайдено по порядку.
  let hi = 0, ni = 0;
  while (hi < h.length && ni < n.length) {
    if (h[hi] === n[ni]) ni++;
    hi++;
  }
  if (ni === n.length) return 50;
  return null;
}

export function CommandPalette({ open, onClose, items }: Props) {
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  // Reset query кожного відкриття.
  useEffect(() => {
    if (open) {
      setQ("");
      setSel(0);
      setTimeout(() => inputRef.current?.focus(), 10);
    }
  }, [open]);

  const filtered = useMemo(() => {
    if (!q.trim()) {
      return items.map((it, i) => ({ it, score: 1000 - i }));
    }
    const arr: Array<{ it: CommandItem; score: number }> = [];
    for (const it of items) {
      const text = `${it.label} ${it.keywords ?? ""} ${it.category ?? ""}`;
      const s = fuzzyScore(text, q);
      if (s != null) arr.push({ it, score: s });
    }
    arr.sort((a, b) => b.score - a.score);
    return arr.slice(0, 60);
  }, [q, items]);

  useEffect(() => {
    if (sel >= filtered.length) setSel(0);
  }, [filtered.length, sel]);

  // Глобальні keys ловимо тут (стрілки/Enter/Esc).
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); onClose(); return; }
      if (e.key === "ArrowDown") { e.preventDefault(); setSel((s) => Math.min(filtered.length - 1, s + 1)); return; }
      if (e.key === "ArrowUp") { e.preventDefault(); setSel((s) => Math.max(0, s - 1)); return; }
      if (e.key === "Enter") {
        e.preventDefault();
        const pick = filtered[sel];
        if (pick && !pick.it.disabled) {
          pick.it.run();
          onClose();
        }
        return;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, filtered, sel, onClose]);

  // Scroll selected у viewport.
  useEffect(() => {
    if (!listRef.current) return;
    const el = listRef.current.querySelector(`[data-cmd-idx="${sel}"]`) as HTMLElement | null;
    if (el) el.scrollIntoView({ block: "nearest" });
  }, [sel]);

  if (!open) return null;

  // Group by category для рендеру.
  let lastCat: string | undefined = undefined;
  return (
    <div
      className="fixed inset-0 z-[70] bg-black/60 flex items-start justify-center pt-[14vh] px-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-[620px] bg-[var(--bg-surface)] border border-[var(--border-soft)] rounded-lg shadow-2xl flex flex-col max-h-[70vh]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 px-4 py-3 border-b border-[var(--border-soft)]">
          <svg className="w-4 h-4 text-[var(--text-faint)] shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
          </svg>
          <input
            ref={inputRef}
            className="flex-1 bg-transparent outline-none text-[14px] text-[var(--text-strong)] placeholder:text-[var(--text-faint)]"
            placeholder="Введи команду, ім'я файлу або enum #…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
          <span className="text-[10px] text-[var(--text-faint)] font-mono px-1.5 py-0.5 border border-[var(--border-soft)] rounded">Esc</span>
        </div>
        <div ref={listRef} className="flex-1 overflow-y-auto py-1.5">
          {filtered.length === 0 && (
            <div className="px-4 py-6 text-center text-[12px] text-[var(--text-faint)]">
              Нічого не знайдено для «{q}»
            </div>
          )}
          {filtered.map(({ it }, i) => {
            const cat = it.category;
            const showCat = cat && cat !== lastCat;
            lastCat = cat;
            return (
              <div key={it.id}>
                {showCat && (
                  <div className="px-4 pt-2 pb-1 text-[9.5px] uppercase tracking-wider text-[var(--text-faint)]">{cat}</div>
                )}
                <button
                  data-cmd-idx={i}
                  type="button"
                  disabled={it.disabled}
                  onMouseEnter={() => setSel(i)}
                  onClick={() => {
                    if (it.disabled) return;
                    it.run();
                    onClose();
                  }}
                  className={`w-full text-left px-4 py-2 flex items-center gap-3 text-[12.5px] ${
                    sel === i
                      ? "bg-[var(--accent)]/15 text-[var(--text-strong)]"
                      : "text-[var(--text)]"
                  } ${it.disabled ? "opacity-50 cursor-not-allowed" : ""}`}
                >
                  <span className="w-5 text-center shrink-0" aria-hidden>{it.icon ?? "›"}</span>
                  <span className="flex-1 truncate">{it.label}</span>
                  {it.hint && (
                    <span className="text-[10.5px] text-[var(--text-faint)] truncate max-w-[160px]">{it.hint}</span>
                  )}
                  {it.shortcut && (
                    <span className="font-mono text-[10px] text-[var(--text-faint)] px-1.5 py-0.5 border border-[var(--border-soft)] rounded">
                      {it.shortcut}
                    </span>
                  )}
                </button>
              </div>
            );
          })}
        </div>
        <div className="px-4 py-2 border-t border-[var(--border-soft)] text-[10.5px] text-[var(--text-faint)] flex items-center gap-3">
          <span><kbd className="font-mono">↑↓</kbd> навігація</span>
          <span><kbd className="font-mono">Enter</kbd> виконати</span>
          <span className="ml-auto">{filtered.length} результатів</span>
        </div>
      </div>
    </div>
  );
}
