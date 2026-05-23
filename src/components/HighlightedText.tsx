// Простий syntax-highlighter для MISSING-діалогів у клітинках таблиці.
// Підсвічує:
//   - HTML-теги: <color=red>, </color>, <b>, <noparse>
//   - placeholder'и: {0}, {playerName}, %s, %d
//   - escape: \n, \t, \r
//   - voice-refs: V_EM_001 і подібне
//   - choice-tags типу [B], [Y]
// Все рендериться через <span>'и з кольорами з CSS-vars. Не редагує текст,
// лише обгортає у токени для візуалу.

import { Fragment, type ReactNode } from "react";

interface Token {
  text: string;
  kind?: "tag" | "placeholder" | "escape" | "voice" | "choice";
}

// Регулярки — порядок не важливий, бо ми йдемо по всіх match'ах і сортуємо
// по позиції. Перекриття пріоритизуємо за довшим токеном.
const PATTERNS: Array<[RegExp, Token["kind"]]> = [
  [/<\/?[A-Za-z][^<>]*>/g, "tag"],                      // <color=red>, </color>, <b>
  [/\{[A-Za-z_0-9]+\}/g, "placeholder"],                // {playerName}, {0}
  [/%[sdifxX%]/g, "placeholder"],                       // %s, %d
  [/\\[ntrbf"\\]/g, "escape"],                          // \n, \t, ...
  [/V_[A-Z]{2}_\d{3}/g, "voice"],                       // V_EM_001
  [/\[[A-Z]\]/g, "choice"],                             // [B], [Y]
];

interface Range { start: number; end: number; kind: NonNullable<Token["kind"]> }

function tokenize(text: string): Token[] {
  if (!text) return [];
  const ranges: Range[] = [];
  for (const [re, kind] of PATTERNS) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) != null) {
      ranges.push({ start: m.index, end: m.index + m[0].length, kind: kind! });
      if (m[0].length === 0) re.lastIndex++;
    }
  }
  if (ranges.length === 0) return [{ text }];
  // Сортуємо по старту; для overlap'ів лишаємо довший токен.
  ranges.sort((a, b) => (a.start - b.start) || (b.end - a.end));
  const merged: Range[] = [];
  for (const r of ranges) {
    const last = merged[merged.length - 1];
    if (last && r.start < last.end) continue;
    merged.push(r);
  }
  const out: Token[] = [];
  let cursor = 0;
  for (const r of merged) {
    if (r.start > cursor) out.push({ text: text.slice(cursor, r.start) });
    out.push({ text: text.slice(r.start, r.end), kind: r.kind });
    cursor = r.end;
  }
  if (cursor < text.length) out.push({ text: text.slice(cursor) });
  return out;
}

const KIND_STYLE: Record<NonNullable<Token["kind"]>, string> = {
  tag: "text-[var(--accent)] bg-[var(--accent)]/10 rounded px-0.5",
  placeholder: "text-[var(--warning,#d97706)] bg-[var(--warning,#d97706)]/10 rounded px-0.5 font-semibold",
  escape: "text-[var(--text-faint)] bg-[var(--bg-elev)] rounded px-0.5",
  voice: "text-[var(--success)] bg-[var(--success)]/10 rounded px-0.5",
  choice: "text-[var(--accent)] bg-[var(--accent)]/15 rounded px-0.5 font-semibold",
};

interface Props {
  text: string;
  /** Якщо порожньо — рендерить placeholder "—". */
  placeholder?: ReactNode;
  /** Додатковий CSS-клас на root. */
  className?: string;
}

export function HighlightedText({ text, placeholder, className }: Props) {
  if (!text) return <>{placeholder ?? <span className="italic text-[var(--text-faint)]">—</span>}</>;
  const tokens = tokenize(text);
  return (
    <span className={className ?? ""}>
      {tokens.map((t, i) => t.kind
        ? <span key={i} className={KIND_STYLE[t.kind]} title={`${t.kind}: ${t.text}`}>{t.text}</span>
        : <Fragment key={i}>{t.text}</Fragment>)}
    </span>
  );
}
