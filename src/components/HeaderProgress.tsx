// Компактний прогрес-індикатор для хедера MissingEditor. Замінює сухе
// число "12345 / 50000" на mini-bar з градієнтом + % + raw counts. Колір
// шкали відбиває стан: 0% — danger, 100% — success, проміжно — warning→accent.

interface Props {
  translated: number;
  total: number;
  /** Ширина bar'а у px. Default 110, гарно лягає у хедер. */
  width?: number;
  /** Опціональне тулчіп-пояснення. */
  title?: string;
}

export function HeaderProgress({ translated, total, width = 110, title }: Props) {
  const pct = total > 0 ? Math.min(100, (translated / total) * 100) : 0;
  // 2 знаки — щоб збігалося з «Огляд готовності» (89.37 % замість округленого
  // 89.4 %, інакше користувач бачить розходження і думає що є баг).
  const pctTxt = total > 0 ? pct.toFixed(2) : "0.00";
  const color = pct === 0
    ? "var(--danger)"
    : pct >= 100
      ? "var(--success)"
      : pct < 30
        ? "var(--warning,#d97706)"
        : "var(--accent)";
  return (
    <div
      className="flex items-center gap-2 text-[10.5px] tabular-nums text-[var(--text-muted)] select-none"
      title={title ?? `Перекладено ${translated.toLocaleString("uk-UA")} з ${total.toLocaleString("uk-UA")} рядків (${pctTxt}%)`}
    >
      <span className="font-mono">{translated.toLocaleString("uk-UA")}/{total.toLocaleString("uk-UA")}</span>
      <div className="relative" style={{ width }}>
        <div className="h-1.5 rounded-full bg-[var(--bg-elev)] overflow-hidden">
          <div
            className="h-full transition-all duration-300"
            style={{ width: `${pct}%`, background: color, boxShadow: `0 0 8px -2px ${color}` }}
          />
        </div>
      </div>
      <span className="font-semibold" style={{ color, minWidth: 38, textAlign: "right" }}>{pctTxt}%</span>
    </div>
  );
}
