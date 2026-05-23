// Швидка довідка по гарячих клавішах MissingEditor. Тригериться клавішею `?`
// (без модифікатора, поза input/Monaco). Дизайн повторює інші DP2-модалки —
// центрований панель, dim backdrop, escape/click-outside закриває.

import { useEffect } from "react";
import { useT } from "../../lib/i18n";

interface Shortcut {
  keys: string[];
  label: string;
}

interface ShortcutGroup {
  title: string;
  items: Shortcut[];
}

interface Props {
  open: boolean;
  onClose: () => void;
}

export function MissingShortcutsModal({ open, onClose }: Props) {
  const t = useT();
  const GROUPS: ShortcutGroup[] = [
    {
      title: t("shortcuts.cat.nav"),
      items: [
        { keys: ["Ctrl", "K"], label: t("shortcuts.it.palette") },
        { keys: ["Ctrl", "Shift", "F"], label: t("shortcuts.it.globalSearch") },
        { keys: ["?"], label: t("shortcuts.it.self") },
        { keys: ["Esc"], label: t("shortcuts.it.escape") },
      ],
    },
    {
      title: t("shortcuts.cat.row"),
      items: [
        { keys: ["Ctrl", "B"], label: t("shortcuts.it.bookmark") },
        { keys: ["Ctrl", "S"], label: t("shortcuts.it.save") },
        { keys: ["↑", "↓"], label: t("shortcuts.it.navRow") },
      ],
    },
    {
      title: t("shortcuts.cat.ctx"),
      items: [
        { keys: ["1"], label: t("shortcuts.it.draft") },
        { keys: ["2"], label: t("shortcuts.it.review") },
        { keys: ["3"], label: t("shortcuts.it.approved") },
        { keys: ["0"], label: t("shortcuts.it.clear") },
      ],
    },
  ];
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); onClose(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-6" onClick={onClose}>
      <div
        className="w-full max-w-[640px] bg-[var(--bg-surface)] border border-[var(--border-soft)] rounded-lg shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-5 py-3 border-b border-[var(--border-soft)] flex items-center gap-3">
          <span className="text-[16px]" aria-hidden>⌨️</span>
          <h2 className="text-[14px] font-semibold text-[var(--text-strong)]">{t("shortcuts.titleMissing")}</h2>
          <span className="ml-auto text-[10.5px] text-[var(--text-faint)]">{t("shortcuts.hint", { kbd: "?" })}</span>
        </div>
        <div className="p-5 grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-5">
          {GROUPS.map((g) => (
            <section key={g.title}>
              <h3 className="text-[10px] uppercase tracking-wider text-[var(--text-faint)] mb-2">{g.title}</h3>
              <ul className="space-y-1.5">
                {g.items.map((it, i) => (
                  <li key={i} className="flex items-center gap-2 text-[12px]">
                    <span className="text-[var(--text-muted)] flex-1 min-w-0 truncate">{it.label}</span>
                    <span className="flex items-center gap-1 shrink-0">
                      {it.keys.map((k, j) => (
                        <span key={j} className="flex items-center gap-1">
                          {j > 0 && <span className="text-[10px] text-[var(--text-faint)]">+</span>}
                          <Kbd>{k}</Kbd>
                        </span>
                      ))}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
        <div className="px-5 py-2.5 border-t border-[var(--border-soft)] flex items-center text-[10.5px] text-[var(--text-faint)]">
          <span>{t("shortcuts.foot")}</span>
          <span className="ml-auto">
            <button className="dp-btn dp-btn--ghost" onClick={onClose}>{t("shortcuts.close")}</button>
          </span>
        </div>
      </div>
    </div>
  );
}

function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="inline-flex items-center justify-center min-w-[22px] h-[22px] px-1.5 rounded border border-[var(--border-soft)] bg-[var(--bg)] text-[10.5px] font-mono text-[var(--text)] shadow-sm">
      {children}
    </kbd>
  );
}
