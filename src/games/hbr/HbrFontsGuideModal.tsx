// Покрокова інструкція для роботи з TMPUnity.exe — компактний wizard:
// один крок на екран, навігація Prev/Next + клавіші ← →. Усі тексти
// через i18n (UK + EN). Прапор `hbrFontsGuideSeen` у settings вмикається
// тільки після завершення на step 9 («Зрозуміло») або на Esc — щоб модалка
// не з'являлась повторно.

import { useEffect, useState } from "react";
import { useT } from "../../lib/i18n";

interface Props {
  open: boolean;
  onClose: () => void;
}

interface Step {
  titleKey: string;
  bodyKey?: string;
  codes?: string[];
  noteKey?: string;
}

// 5 кроків замість 9 — об'єднуємо споріднені дії в один екран. Тексти
// дублюються в i18n.ts під ключами hbr.fontsGuide.c1..c5.*.
const STEPS: Step[] = [
  { titleKey: "hbr.fontsGuide.c1.title", bodyKey: "hbr.fontsGuide.c1.body",
    codes: [
      "Documents\\SWERY-Localization-Tool\\HBR\\FontGenerator\\TMPUnity.exe",
      "Documents\\SWERY-Localization-Tool\\HBR\\Fonts\\MonoBehaviour",
    ] },
  { titleKey: "hbr.fontsGuide.c2.title", bodyKey: "hbr.fontsGuide.c2.body",
    codes: ["ІіЇїЄєҐґ"] },
  { titleKey: "hbr.fontsGuide.c3.title", bodyKey: "hbr.fontsGuide.c3.body",
    codes: ["dump"], noteKey: "hbr.fontsGuide.c3.note" },
  { titleKey: "hbr.fontsGuide.c4.title", bodyKey: "hbr.fontsGuide.c4.body",
    codes: [
      "Documents\\SWERY-Localization-Tool\\HBR\\Fonts\\MonoBehaviour",
      "Documents\\SWERY-Localization-Tool\\HBR\\Fonts\\Atlas",
    ] },
  { titleKey: "hbr.fontsGuide.c5.title", bodyKey: "hbr.fontsGuide.c5.body",
    noteKey: "hbr.fontsGuide.c5.note" },
];

export function HbrFontsGuideModal({ open, onClose }: Props) {
  const t = useT();
  const [idx, setIdx] = useState(0);

  // Скидаємо на перший крок при кожному відкритті — щоб користувач почав
  // з 1, а не з того місця, де закрив минулого разу.
  useEffect(() => { if (open) setIdx(0); }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      else if (e.key === "ArrowRight" && idx < STEPS.length - 1) setIdx(idx + 1);
      else if (e.key === "ArrowLeft" && idx > 0) setIdx(idx - 1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, idx, onClose]);

  if (!open) return null;

  const step = STEPS[idx];
  const isFirst = idx === 0;
  const isLast = idx === STEPS.length - 1;

  return (
    <div
      className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        className="dp-card w-full max-w-[560px] flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <header className="px-5 py-3 border-b border-[var(--border-soft)]">
          <div className="flex items-center justify-between gap-3 mb-1">
            <p className="text-[10px] uppercase tracking-[0.2em] text-[var(--accent)]">
              {t("hbr.fontsGuide.eyebrow")}
            </p>
            <span className="text-[11px] tabular-nums text-[var(--text-faint)]">
              {idx + 1} / {STEPS.length}
            </span>
          </div>
          <h2 className="text-[14.5px] font-semibold text-[var(--text-strong)] leading-snug">
            {t(step.titleKey)}
          </h2>
        </header>

        {/* Body */}
        <div className="px-5 py-4 flex flex-col gap-3 min-h-[180px]">
          {step.bodyKey && (
            <p className="text-[12.5px] text-[var(--text-muted)] leading-relaxed whitespace-pre-wrap">
              {t(step.bodyKey)}
            </p>
          )}
          {step.codes?.map((c, ci) => (
            <pre
              key={ci}
              className="px-2.5 py-1.5 rounded bg-[var(--bg)] border border-[var(--border-soft)] text-[11px] font-mono text-[var(--text)] whitespace-pre-wrap break-all"
            >
              {c}
            </pre>
          ))}
          {step.noteKey && (
            <p className="text-[11.5px] leading-relaxed px-3 py-2 rounded border border-[var(--warning,#d97706)]/40 bg-[var(--warning,#d97706)]/10 text-[var(--text)]">
              {t(step.noteKey)}
            </p>
          )}
        </div>

        {/* Progress dots */}
        <div className="px-5 pb-2 flex items-center justify-center gap-2">
          {STEPS.map((_, i) => (
            <button
              key={i}
              onClick={() => setIdx(i)}
              aria-label={`Step ${i + 1}`}
              className={`h-2 rounded-full transition-all cursor-pointer ${
                i === idx
                  ? "w-8 bg-[var(--accent)]"
                  : i < idx
                    ? "w-2 bg-[var(--accent)]"
                    : "w-2 bg-[var(--border)] hover:bg-[var(--text-faint)]"
              }`}
            />
          ))}
        </div>

        {/* Footer */}
        <footer className="px-5 py-3 border-t border-[var(--border-soft)] flex items-center justify-between gap-2 bg-[var(--bg)]">
          <button
            className="dp-btn dp-btn--ghost"
            onClick={() => setIdx(idx - 1)}
            disabled={isFirst}
          >
            ← {t("hbr.fontsGuide.prev")}
          </button>
          {isLast ? (
            <button className="dp-btn dp-btn--primary" onClick={onClose}>
              {t("hbr.fontsGuide.ok")}
            </button>
          ) : (
            <button className="dp-btn dp-btn--primary" onClick={() => setIdx(idx + 1)}>
              {t("hbr.fontsGuide.next")} →
            </button>
          )}
        </footer>
      </div>
    </div>
  );
}
