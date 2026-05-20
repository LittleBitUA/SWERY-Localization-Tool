// Універсальний статус-бар знизу редактора. Показує що зараз цікавить
// перекладача: позицію, лічильники, % перекладеного. Замінює розкидані
// inline-лічильники типу "shown: 42" у фільтрах.
//
// Дизайн mirror'ить DP2 SentenceTable footer — стіл і висота однакова, щоб
// перемикання між editorами не "стрибало" по UI.

import type { ReactNode } from "react";

export interface FooterStat {
  label: string;
  value: string | number;
  /** Опціонально: фарбування value, дефолт — звичайний text. */
  tone?: "default" | "success" | "accent" | "warning" | "danger" | "muted";
}

interface Props {
  stats: FooterStat[];
  /** Опціональна назва файла/проекту праворуч. */
  fileName?: string | null;
  /** Опціональний додатковий контент у кінці (badge, кнопка). */
  trailing?: ReactNode;
}

const TONE_CLASS: Record<NonNullable<FooterStat["tone"]>, string> = {
  default: "text-[var(--text)]",
  success: "text-[var(--success)]",
  accent: "text-[var(--accent)]",
  warning: "text-[var(--warning,#d97706)]",
  danger: "text-[var(--danger)]",
  muted: "text-[var(--text-muted)]",
};

export function EditorFooter({ stats, fileName, trailing }: Props) {
  return (
    <div className="h-7 px-3 border-t border-[var(--border-soft)] flex items-center gap-x-4 text-[11px] text-[var(--text-faint)] tabular-nums whitespace-nowrap overflow-x-auto shrink-0">
      {stats.map((s, i) => (
        <span key={i}>
          {s.label}: <span className={`font-semibold ${TONE_CLASS[s.tone ?? "default"]}`}>{
            typeof s.value === "number" ? s.value.toLocaleString() : s.value
          }</span>
        </span>
      ))}
      {fileName && (
        <span className="ml-auto">
          · <span className="font-mono">{fileName}</span>
        </span>
      )}
      {trailing}
    </div>
  );
}
