// DP1 Glyph Audit — сканує всі записи у поточному eng.json і шукає UA-символи,
// яких немає у мапі CYRILLIC_REPLACEMENTS. Такі символи у грі рендеряться
// як пусто/сміття — це production-баг локалізатора.

import { useMemo } from "react";
import { useT } from "../../lib/i18n";
import { useDp1Store } from "./store";
import { findUnsupportedChars, type UnsupportedChar } from "./cyrillicMap";

interface Props {
  open: boolean;
  onClose: () => void;
}

interface BadEntry {
  positional: number;
  recordIndex: number;
  id: string;
  ua: string;
  bad: UnsupportedChar[];
}

function highlightBad(text: string, bad: UnsupportedChar[]): React.ReactNode[] {
  if (bad.length === 0) return [text];
  const out: React.ReactNode[] = [];
  let cursor = 0;
  bad.forEach(({ index, ch }, k) => {
    if (index > cursor) out.push(text.slice(cursor, index));
    out.push(
      <mark key={k} className="bg-[var(--danger)]/40 text-[var(--text-strong)] rounded px-0.5">
        {ch}
      </mark>
    );
    cursor = index + ch.length;
  });
  if (cursor < text.length) out.push(text.slice(cursor));
  return out;
}

export function Dp1GlyphAuditModal({ open, onClose }: Props) {
  const t = useT();
  const entries = useDp1Store((s) => s.entries);
  const setActive = useDp1Store((s) => s.setActive);

  const badEntries = useMemo<BadEntry[]>(() => {
    if (!open) return [];
    const out: BadEntry[] = [];
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      if (e.empty || !e.ua) continue;
      const bad = findUnsupportedChars(e.ua);
      if (bad.length > 0) {
        out.push({ positional: i, recordIndex: e.index, id: e.id, ua: e.ua, bad });
      }
    }
    return out;
  }, [open, entries]);

  // Зведення по символах: яких саме не вистачає і скільки разів.
  const charCounts = useMemo(() => {
    const m = new Map<string, { count: number; codepoint: number }>();
    for (const be of badEntries) {
      for (const b of be.bad) {
        const cur = m.get(b.ch);
        if (cur) cur.count++;
        else m.set(b.ch, { count: 1, codepoint: b.codepoint });
      }
    }
    return Array.from(m.entries())
      .map(([ch, v]) => ({ ch, ...v }))
      .sort((a, b) => b.count - a.count);
  }, [badEntries]);

  if (!open) return null;

  function jump(b: BadEntry) {
    setActive(b.positional);
    onClose();
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-6 bg-black/70"
      onClick={onClose}
    >
      <div
        className="dp-card w-full max-w-3xl flex flex-col"
        style={{ maxHeight: "85vh" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-3 px-5 py-3 border-b border-[var(--border-soft)]">
          <div className="min-w-0 flex-1">
            <h2 className="text-[15px] font-semibold text-[var(--text-strong)]">
              {t("dp1.glyph.title")}
            </h2>
            <p className="text-[12px] text-[var(--text-muted)] mt-0.5 truncate">
              {t("dp1.glyph.subtitle")}
            </p>
          </div>
          <button onClick={onClose} className="dp-btn dp-btn--ghost !w-7 !p-0 shrink-0">
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="flex-1 overflow-auto p-5">
          {/* Підсумок */}
          <div className="grid grid-cols-3 gap-3 mb-5">
            <Card label={t("dp1.glyph.scanned")} value={entries.filter((e) => !e.empty && e.ua).length} />
            <Card
              label={t("dp1.glyph.badEntries")}
              value={badEntries.length}
              tone={badEntries.length > 0 ? "danger" : "success"}
            />
            <Card label={t("dp1.glyph.uniqueChars")} value={charCounts.length} />
          </div>

          {badEntries.length === 0 ? (
            <p className="py-8 text-center text-[13px] text-[var(--success)]">
              ✓ {t("dp1.glyph.allClean")}
            </p>
          ) : (
            <>
              {/* Список унікальних символів */}
              <div className="mb-4">
                <h3 className="text-[11px] font-semibold uppercase tracking-wider text-[var(--text-muted)] mb-2">
                  {t("dp1.glyph.charList")}
                </h3>
                <div className="flex flex-wrap gap-1.5">
                  {charCounts.map(({ ch, count, codepoint }) => (
                    <span
                      key={ch}
                      className="inline-flex items-center gap-2 px-2 py-1 rounded border border-[var(--danger)]/40 bg-[var(--danger)]/10 text-[11px] font-mono"
                      title={`U+${codepoint.toString(16).toUpperCase().padStart(4, "0")}`}
                    >
                      <span className="text-[13px] text-[var(--danger)] font-bold">'{ch}'</span>
                      <span className="text-[var(--text-faint)]">×{count}</span>
                    </span>
                  ))}
                </div>
              </div>

              {/* Список записів */}
              <h3 className="text-[11px] font-semibold uppercase tracking-wider text-[var(--text-muted)] mb-2">
                {t("dp1.glyph.affectedEntries")}
              </h3>
              <div className="border border-[var(--border-soft)] rounded overflow-hidden">
                {badEntries.slice(0, 500).map((b) => (
                  <button
                    key={b.recordIndex}
                    onClick={() => jump(b)}
                    className="w-full text-left px-4 py-2 border-b border-[var(--border-soft)] hover:bg-[var(--row-hover)] flex flex-col gap-0.5"
                  >
                    <div className="flex items-center gap-2 text-[11px]">
                      <span className="font-mono text-[var(--text-faint)] tabular-nums">
                        #{b.recordIndex + 1}
                      </span>
                      <span className="font-mono text-[var(--text-muted)] truncate">{b.id}</span>
                      <span className="ml-auto text-[var(--danger)] font-semibold">
                        {b.bad.length} {t("dp1.glyph.badChars")}
                      </span>
                    </div>
                    <p className="text-[12px] text-[var(--text)] leading-snug font-mono whitespace-pre-wrap break-words line-clamp-2">
                      {highlightBad(b.ua, b.bad)}
                    </p>
                  </button>
                ))}
                {badEntries.length > 500 && (
                  <div className="px-4 py-2 text-[11px] text-[var(--text-faint)] italic">
                    {t("dp1.glyph.more", { n: badEntries.length - 500 })}
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function Card({ label, value, tone }: { label: string; value: number; tone?: "success" | "danger" }) {
  const color = tone === "danger" ? "text-[var(--danger)]"
    : tone === "success" ? "text-[var(--success)]"
    : "text-[var(--text-strong)]";
  return (
    <div className="border border-[var(--border-soft)] rounded p-3 bg-[var(--bg)]">
      <p className="text-[10px] uppercase tracking-wider text-[var(--text-faint)] mb-1">{label}</p>
      <p className={`text-[20px] font-bold tabular-nums leading-none ${color}`}>
        {value.toLocaleString("uk-UA")}
      </p>
    </div>
  );
}
