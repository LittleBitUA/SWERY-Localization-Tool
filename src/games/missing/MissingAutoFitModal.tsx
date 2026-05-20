import { useEffect, useMemo, useState } from "react";
import { parseMissingMsg } from "./parser";
import type { MissingHeightInfo } from "./heightinfo";

interface FileItem {
  name: string;
  origPath: string;
  donePath: string;
  hasDone: boolean;
}

interface CacheRow {
  enumN: number;
  hIdx: number;          // індекс у heightInfo.entries
  enText: string;
  uaText: string;
  enLen: number;         // символів EN
  uaLen: number;         // символів UA
  enLines: number;
  uaLines: number;
  origW: number;         // ПОТОЧНИЙ W у Done (може бути вже модифіковане)
  origH: number;
  refW: number;          // ОРИГІНАЛЬНИЙ W з Meta — baseline для розрахунку newW
  refH: number;
}

interface PreviewRow extends CacheRow {
  newW: number;
  newH: number;
  changed: boolean;
  skipReason?: string;   // якщо рядок пропущено — причина
}

interface Props {
  open: boolean;
  onClose: () => void;
  files: FileItem[];
  /** Current heightInfo (може бути вже-модифікований Done). */
  heightInfo: MissingHeightInfo | null;
  /** ОРИГІНАЛЬНИЙ heightInfo з Meta — нерухомий reference для розрахунків.
   *  Без нього newW = origW × ratio × padding буде мультиплікативним
   *  на кожен повторний apply. Якщо null — fallback на heightInfo. */
  referenceHeightInfo: MissingHeightInfo | null;
  heightInfoIdx: Map<number, number>;
  targetLang: number;
  onApply: (updates: Array<{ hIdx: number; w: number; h: number }>) => void;
}

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const PLACEHOLDER_RE = /^[A-Z_0-9]+_en$|^V_[A-Z]{2}_\d{3}$/;

export function MissingAutoFitModal({ open, onClose, files, heightInfo, referenceHeightInfo, heightInfoIdx, targetLang, onApply }: Props) {
  const [loading, setLoading] = useState(false);
  const [cache, setCache] = useState<CacheRow[]>([]);
  const [padding, setPadding] = useState(1.08);
  const [minPadding, setMinPadding] = useState(0);  // абсолютний мінімум у px (опційно)
  const [onlyGrow, setOnlyGrow] = useState(true);
  const [scaleHeight, setScaleHeight] = useState(true);
  const [sortMode, setSortMode] = useState<"diff" | "ratio" | "enum">("diff");
  const [showAll, setShowAll] = useState(false);

  // Перезавантажуємо cache коли модалка відкривається або змінився targetLang/heightInfo.
  useEffect(() => {
    if (!open || !heightInfo) { setCache([]); return; }
    let cancelled = false;
    setLoading(true);
    (async () => {
      const W = window.dp2 as unknown as { missingTextRead: (p: string) => Promise<{ ok: boolean; base64?: string }> };
      const rows: CacheRow[] = [];
      for (const f of files) {
        try {
          const [oR, dR] = await Promise.all([
            W.missingTextRead(f.origPath),
            W.missingTextRead(f.hasDone ? f.donePath : f.origPath),
          ]);
          if (!oR.ok || !oR.base64) continue;
          const orig = parseMissingMsg(b64ToBytes(oR.base64));
          const done = dR.ok && dR.base64 ? parseMissingMsg(b64ToBytes(dR.base64)) : orig;
          for (let i = 0; i < orig.entries.length; i++) {
            const o = orig.entries[i];
            const d = done.entries[i];
            if (!o || !d) continue;
            if (d.text === o.text || !d.text) continue;
            if (PLACEHOLDER_RE.test(o.text)) continue;
            const enumN = o.msgEnum;
            if (enumN < 0) continue;
            const hIdx = heightInfoIdx.get(enumN);
            if (hIdx === undefined) continue;
            const sz = heightInfo.entries[hIdx].sizes[targetLang];
            if (!sz) continue;
            // Reference: оригінальний W/H з Meta. Якщо reference нема —
            // fallback на поточний sz (тоді алгоритм поведеться як раніше).
            const refSz = referenceHeightInfo?.entries[hIdx]?.sizes[targetLang] ?? sz;
            rows.push({
              enumN, hIdx,
              enText: o.text, uaText: d.text,
              enLen: o.text.length, uaLen: d.text.length,
              enLines: (o.text.match(/\n/g) || []).length + 1,
              uaLines: (d.text.match(/\n/g) || []).length + 1,
              origW: sz.w, origH: sz.h,
              refW: refSz.w, refH: refSz.h,
            });
          }
        } catch {}
        if (cancelled) return;
      }
      if (!cancelled) { setCache(rows); setLoading(false); }
    })();
    return () => { cancelled = true; };
  }, [open, files, heightInfo, referenceHeightInfo, heightInfoIdx, targetLang]);

  // Превʼю — рахуємо синхронно, дешево (~3K рядків × прості формули).
  // КРИТИЧНО: baseline = refW (Original з Meta), а НЕ origW (поточний).
  // Без цього кожен apply мультиплікативно нарощує W, бо origW стає = newW.
  const preview: PreviewRow[] = useMemo(() => {
    return cache.map((c) => {
      const ratio = c.uaLen / Math.max(1, c.enLen);
      let newW = c.refW;
      let newH = c.refH;
      if (ratio > 1 || !onlyGrow) {
        newW = Math.ceil(c.refW * ratio * padding);
        if (minPadding > 0) newW = Math.max(newW, c.refW + minPadding);
      }
      if (scaleHeight && c.uaLines > c.enLines) {
        newH = Math.ceil(c.refH * (c.uaLines / c.enLines));
      }
      // Idempotency: якщо поточний W вже достатньо великий — пропускаємо.
      // Інакше при повторному відкритті Auto-fit показуватиме ті ж рядки.
      const changed = newW !== c.origW || newH !== c.origH;
      let skipReason: string | undefined;
      if (!changed) {
        skipReason = ratio <= 1 ? "UA коротший" : "уже підходить";
      } else if (newW <= c.origW && newH <= c.origH && onlyGrow) {
        // Поточний W вже > розрахованого target → нічого не міняємо.
        skipReason = "поточний W вже достатній";
        return { ...c, newW: c.origW, newH: c.origH, changed: false, skipReason };
      }
      return { ...c, newW, newH, changed, skipReason };
    });
  }, [cache, padding, minPadding, onlyGrow, scaleHeight]);

  const stats = useMemo(() => {
    let willChange = 0, biggest = 0;
    for (const r of preview) {
      if (r.changed) {
        willChange++;
        const diff = r.newW - r.origW;
        if (diff > biggest) biggest = diff;
      }
    }
    return { total: preview.length, willChange, biggest };
  }, [preview]);

  const sortedPreview = useMemo(() => {
    const arr = preview.slice();
    if (sortMode === "diff") arr.sort((a, b) => (b.newW - b.origW) - (a.newW - a.origW));
    else if (sortMode === "ratio") arr.sort((a, b) => (b.uaLen / b.enLen) - (a.uaLen / a.enLen));
    else arr.sort((a, b) => a.enumN - b.enumN);
    return arr;
  }, [preview, sortMode]);

  const visiblePreview = useMemo(() => {
    const filtered = showAll ? sortedPreview : sortedPreview.filter((r) => r.changed);
    return filtered.slice(0, 200);
  }, [sortedPreview, showAll]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  function handleApply() {
    const updates = preview
      .filter((r) => r.changed)
      .map((r) => ({ hIdx: r.hIdx, w: r.newW, h: r.newH }));
    onApply(updates);
    onClose();
  }

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-6 bg-black/70"
      // КРИТИЧНО: ловимо тільки click-и саме на overlay, інакше bubbling від
      // кнопки toolbar-у (яка відкрила модалку) одразу її закриває.
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="dp-card w-full max-w-5xl flex flex-col" style={{ maxHeight: "90vh" }} onMouseDown={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between gap-3 px-5 py-3 border-b border-[var(--border-soft)]">
          <div className="min-w-0 flex-1">
            <h2 className="text-[15px] font-semibold text-[var(--text-strong)]">Auto-fit box-sizes — превʼю</h2>
            <p className="text-[12px] text-[var(--text-muted)] mt-0.5">
              Цільовий слот <span className="font-mono text-[var(--accent)]">L{targetLang}</span>.
              Знайдено <span className="tabular-nums text-[var(--text)]">{stats.total}</span> рядків з перекладом ·
              підлаштується <span className="tabular-nums text-[var(--success)]">{stats.willChange}</span>.
            </p>
          </div>
          <button onClick={onClose} className="dp-btn dp-btn--ghost !w-7 !p-0 shrink-0">
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="px-5 py-3 border-b border-[var(--border-soft)] flex items-end gap-4 flex-wrap">
          {/* Padding slider */}
          <div className="flex flex-col gap-1 min-w-[200px] flex-1">
            <label className="text-[10.5px] uppercase tracking-wider text-[var(--text-faint)] flex justify-between">
              <span>Запас (multiplier)</span>
              <span className="tabular-nums text-[var(--text)]">×{padding.toFixed(2)}</span>
            </label>
            <input
              type="range"
              min={1.0} max={1.5} step={0.01}
              value={padding}
              onChange={(e) => setPadding(parseFloat(e.target.value))}
              className="accent-[var(--accent)]"
            />
            <div className="flex justify-between text-[9px] text-[var(--text-faint)] tabular-nums">
              <span>1.00 (точно)</span>
              <span>1.25</span>
              <span>1.50 (з запасом)</span>
            </div>
          </div>
          {/* Min pixel padding */}
          <div className="flex flex-col gap-1 w-[140px]">
            <label className="text-[10.5px] uppercase tracking-wider text-[var(--text-faint)]" title="Додати фіксований запас у пікселях понад multiplier. Корисно для дуже коротких рядків.">
              Мін. запас, px
            </label>
            <input
              type="number" min={0} max={200} step={1}
              value={minPadding}
              onChange={(e) => setMinPadding(parseInt(e.target.value, 10) || 0)}
              className="dp-input !text-[12px]"
            />
          </div>
          {/* Checkboxes */}
          <div className="flex flex-col gap-1 text-[11px]">
            <label className="flex items-center gap-1.5 cursor-pointer" title="Не звужувати, якщо UA коротший за EN">
              <input type="checkbox" checked={onlyGrow} onChange={(e) => setOnlyGrow(e.target.checked)} />
              <span className="text-[var(--text-muted)]">Лише збільшувати</span>
            </label>
            <label className="flex items-center gap-1.5 cursor-pointer" title="Масштабувати height пропорційно кількості рядків UA">
              <input type="checkbox" checked={scaleHeight} onChange={(e) => setScaleHeight(e.target.checked)} />
              <span className="text-[var(--text-muted)]">Масштабувати висоту</span>
            </label>
          </div>
          {/* Sort */}
          <div className="flex flex-col gap-1 text-[11px]">
            <label className="text-[10.5px] uppercase tracking-wider text-[var(--text-faint)]">Сортування</label>
            <select
              className="dp-input !text-[12px]"
              value={sortMode}
              onChange={(e) => setSortMode(e.target.value as "diff" | "ratio" | "enum")}
            >
              <option value="diff">За приростом (px)</option>
              <option value="ratio">За співвідношенням len(UA)/len(EN)</option>
              <option value="enum">За MsgEnum</option>
            </select>
          </div>
          <div className="flex flex-col gap-1 text-[11px]">
            <label className="flex items-center gap-1.5 cursor-pointer">
              <input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} />
              <span className="text-[var(--text-muted)]">Показати без змін</span>
            </label>
          </div>
        </div>

        <div className="flex-1 overflow-auto">
          {loading && <p className="py-10 text-center text-[12.5px] text-[var(--text-muted)]">Сканую файли…</p>}
          {!loading && stats.total === 0 && (
            <p className="py-10 text-center text-[12.5px] text-[var(--text-faint)]">
              Немає рядків з перекладом, які можна підлаштувати.
            </p>
          )}
          {!loading && stats.total > 0 && (
            <table className="w-full text-[11.5px] border-collapse">
              <thead className="sticky top-0 bg-[var(--bg-surface)] z-10 border-b border-[var(--border-soft)]">
                <tr className="text-[10px] uppercase tracking-wider text-[var(--text-faint)]">
                  <th className="text-left px-3 py-1.5 w-[90px]">MsgEnum</th>
                  <th className="text-left px-2 py-1.5">EN → UA</th>
                  <th className="text-right px-3 py-1.5 w-[120px]">W</th>
                  <th className="text-right px-3 py-1.5 w-[90px]">H</th>
                  <th className="text-right px-3 py-1.5 w-[70px]">Δ%</th>
                </tr>
              </thead>
              <tbody>
                {visiblePreview.map((r) => {
                  const ratio = r.uaLen / Math.max(1, r.enLen);
                  return (
                    <tr key={r.enumN} className="border-b border-[var(--border-soft)] hover:bg-[var(--row-hover)]">
                      <td className="px-3 py-1 font-mono text-[10.5px] text-[var(--text-muted)] tabular-nums">{r.enumN}</td>
                      <td className="px-2 py-1 align-top">
                        <p className="text-[10.5px] text-[var(--text-faint)] line-clamp-1" title={r.enText}>{r.enText}</p>
                        <p className="text-[11px] text-[var(--text)] line-clamp-1" title={r.uaText}>{r.uaText}</p>
                      </td>
                      <td className="px-3 py-1 text-right tabular-nums">
                        <span className="text-[var(--text-faint)]">{r.origW}</span>
                        <span className="text-[var(--text-faint)] mx-1">→</span>
                        <span className={r.newW > r.origW ? "text-[var(--success)] font-semibold" : "text-[var(--text-muted)]"}>{r.newW}</span>
                      </td>
                      <td className="px-3 py-1 text-right tabular-nums">
                        <span className="text-[var(--text-faint)]">{r.origH}</span>
                        {r.newH !== r.origH && (
                          <>
                            <span className="text-[var(--text-faint)] mx-1">→</span>
                            <span className="text-[var(--success)] font-semibold">{r.newH}</span>
                          </>
                        )}
                      </td>
                      <td className="px-3 py-1 text-right tabular-nums text-[10.5px] text-[var(--text-muted)]" title={`UA: ${r.uaLen} симв · EN: ${r.enLen} симв`}>
                        {((ratio - 1) * 100).toFixed(0)}%
                      </td>
                    </tr>
                  );
                })}
                {!loading && !showAll && stats.total > stats.willChange && visiblePreview.length >= stats.willChange && (
                  <tr>
                    <td colSpan={5} className="px-3 py-2 text-center text-[10.5px] text-[var(--text-faint)] italic">
                      {stats.total - stats.willChange} рядків без змін приховано
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          )}
        </div>

        <div className="flex items-center justify-between gap-3 px-5 py-3 border-t border-[var(--border-soft)]">
          <p className="text-[10.5px] text-[var(--text-faint)] flex-1">
            {stats.willChange > 0 && `Найбільший приріст: +${stats.biggest}px у одному рядку.`} Зміни запишуться у <span className="font-mono">Done/heightinfo.bin</span> — пакування у гру при наступному Pack.
          </p>
          <button className="dp-btn dp-btn--ghost" onClick={onClose}>Скасувати</button>
          <button className="dp-btn dp-btn--primary" disabled={loading || stats.willChange === 0} onClick={handleApply}>
            Підлаштувати ({stats.willChange})
          </button>
        </div>
      </div>
    </div>
  );
}
