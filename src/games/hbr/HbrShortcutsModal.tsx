// Cheatsheet для HBR-редактора. Тригер: клавіша `?` (без модифікатора, поза
// input/Monaco). Дизайн ідентичний MissingShortcutsModal, але інший набір
// hot-keys (HBR не має MsgEnum-status'ів і box-sizes, натомість має
// Find & Replace, Glossary, Pack-menu).

import { useEffect } from "react";
import { useT } from "../../lib/i18n";

interface Shortcut { keys: string[]; label: string; }
interface ShortcutGroup { title: string; items: Shortcut[]; }

interface Props { open: boolean; onClose: () => void; }

export function HbrShortcutsModal({ open, onClose }: Props) {
  const t = useT();
  const GROUPS: ShortcutGroup[] = [
    {
      title: t("hbr.shortcuts.groupNav"),
      items: [
        { keys: ["Ctrl", "K"], label: t("hbr.shortcuts.cmdPalette") },
        { keys: ["Ctrl", "F"], label: t("hbr.shortcuts.findReplace") },
        { keys: ["?"], label: t("hbr.shortcuts.thisHelp") },
        { keys: ["Esc"], label: t("hbr.shortcuts.closeModal") },
      ],
    },
    {
      title: t("hbr.shortcuts.groupFile"),
      items: [
        { keys: ["Ctrl", "S"], label: t("hbr.shortcuts.save") },
        { keys: ["Ctrl", "B"], label: t("hbr.shortcuts.bookmark") },
        { keys: ["↑", "↓"], label: t("hbr.shortcuts.prevNext") },
      ],
    },
    {
      title: t("hbr.shortcuts.groupCtx"),
      items: [
        { keys: ["1"], label: t("hbr.shortcuts.draft") },
        { keys: ["2"], label: t("hbr.shortcuts.review") },
        { keys: ["3"], label: t("hbr.shortcuts.approved") },
        { keys: ["0"], label: t("hbr.shortcuts.clearState") },
      ],
    },
  ];
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.preventDefault(); onClose(); } };
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
          <h2 className="text-[14px] font-semibold text-[var(--text-strong)]">{t("hbr.shortcuts.title")}</h2>
          <span className="ml-auto text-[10.5px] text-[var(--text-faint)]">{t("hbr.shortcuts.pressPre")} <Kbd>?</Kbd> {t("hbr.shortcuts.pressPost")}</span>
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
          <span>{t("hbr.shortcuts.footerHint")}</span>
          <span className="ml-auto"><button className="dp-btn dp-btn--ghost" onClick={onClose}>{t("hbr.shortcuts.close")}</button></span>
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
