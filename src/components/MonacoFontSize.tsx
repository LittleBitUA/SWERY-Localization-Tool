// Спільний font-size для всіх Monaco-редакторів (DP2/DP1/HBR/MISSING/TGL).
// Зберігається у localStorage, синхронізується між вкладками через storage
// event (useLocalStorage). Range 11-22 — більше — текст лізе за межі ширини
// колонок, менше — нечитабельно.

import { useLocalStorage } from "../lib/useLocalStorage";
import { useT } from "../lib/i18n";

export const MONACO_FONT_DEFAULT = 13;
export const MONACO_FONT_MIN = 11;
export const MONACO_FONT_MAX = 22;

export function useMonacoFontSize() {
  return useLocalStorage<number>("dp2.ui.monacoFontSize", MONACO_FONT_DEFAULT);
}

interface ControlProps {
  /** Опційний клас для контейнера. */
  className?: string;
}

/** Маленький inline-контрол [-] [size] [+] для toolbar-а. */
export function MonacoFontSizeControl({ className = "" }: ControlProps) {
  const t = useT();
  const [size, setSize] = useMonacoFontSize();
  const clamp = (n: number) => Math.max(MONACO_FONT_MIN, Math.min(MONACO_FONT_MAX, n));
  return (
    <span className={`inline-flex items-center gap-0.5 ${className}`} title={t("components.monacoFontSize.tooltip")}>
      <button
        className="dp-btn dp-btn--ghost !p-0.5 !w-5 !h-5 text-[10px] leading-none"
        onClick={() => setSize((s) => clamp(s - 1))}
        disabled={size <= MONACO_FONT_MIN}
        title={t("components.monacoFontSize.decrease")}
      >−</button>
      <span className="text-[10px] tabular-nums text-[var(--text-muted)] min-w-[18px] text-center">
        {size}
      </span>
      <button
        className="dp-btn dp-btn--ghost !p-0.5 !w-5 !h-5 text-[10px] leading-none"
        onClick={() => setSize((s) => clamp(s + 1))}
        disabled={size >= MONACO_FONT_MAX}
        title={t("components.monacoFontSize.increase")}
      >+</button>
    </span>
  );
}
