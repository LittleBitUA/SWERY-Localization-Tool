import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useStore, dp2StatusKey } from "../lib/store";
import { isTranslated, needsTranslation } from "../lib/parser";
import { useT } from "../lib/i18n";
import { useLocalStorage } from "../lib/useLocalStorage";
import type { StatusKind, StatusEntry } from "../lib/status";
import type { FlatEntry } from "../types";
import { MetricsBadge } from "./MetricsBadge";
import { ColResizer } from "./ColResizer";
import type { WrapMode } from "./WrapToggle";
import { alert as showAlert, choose as showChoose } from "../lib/dialogs";

// Memo-рядок: уникає пере-рендеру для всіх ~18к-сусідів, коли змінюється
// `activeIndex`/`selection`/`wrapCls`. Перевикористовується ТАК ДОВГО, ПОКИ
// його власні props збігаються поверховим порівнянням.
const Dp2TableRow = memo(function Dp2TableRow(props: {
  e: FlatEntry;
  i: number;
  isActive: boolean;
  isSelected: boolean;
  status: StatusEntry | undefined;
  translated: boolean;
  wrapCls: string;
  t: (k: string) => string;
  onClick: (i: number, ev: React.MouseEvent) => void;
  onContext: (i: number, ev: React.MouseEvent) => void;
  registerActiveRef: (node: HTMLTableRowElement | null) => void;
}) {
  const { e, i, isActive, isSelected, status: st, translated, wrapCls, t, onClick, onContext, registerActiveRef } = props;
  const idLabel = e.id || `#${i + 1}`;
  const origText = e.originalEn ?? e.en;
  const speaker = e.kind === "sentence" ? (e.charaName ?? "") : (e.itemName ?? "");
  return (
    <tr
      ref={isActive ? registerActiveRef : undefined}
      onClick={(ev) => onClick(i, ev)}
      onContextMenu={(ev) => onContext(i, ev)}
      // CSS-віртуалізація: для off-screen рядків браузер пропускає layout+paint,
      // а contain-intrinsic-size «auto» запам'ятовує реальну висоту (працює зі
      // змінною висотою wrap-режиму). ~18K рядків DP2 монтуються без jank.
      style={{
        contentVisibility: "auto" as React.CSSProperties["contentVisibility"],
        containIntrinsicSize: "auto 44px",
      }}
      className={`cursor-pointer border-b border-[var(--border-soft)] transition-colors ${
        isActive ? "bg-[var(--row-active)]"
        : isSelected ? "bg-[var(--accent-soft)]"
        : "hover:bg-[var(--row-hover)]"
      }`}
    >
      <td className="px-2 py-1.5 text-[var(--text-faint)] tabular-nums text-[11px] align-top">{i + 1}</td>
      <td className="px-2 py-1.5 align-top">
        <p className="font-mono text-[11px] text-[var(--text-muted)] truncate" title={idLabel}>{idLabel}</p>
        {speaker && (
          <p className="text-[10px] text-[var(--text-faint)] truncate mt-0.5" title={speaker}>{speaker}</p>
        )}
      </td>
      <td className="px-2 py-1.5 align-top text-[var(--text-muted)]">
        <p className={`leading-snug ${wrapCls}`}>
          {origText || <span className="text-[var(--text-faint)] italic">—</span>}
        </p>
      </td>
      <td className="px-2 py-1.5 align-top text-[var(--text)]">
        <p className={`leading-snug ${wrapCls}`}>
          {e.en || <span className="text-[var(--text-faint)] italic">—</span>}
        </p>
      </td>
      <td className="px-1 py-1.5 text-center align-top">
        <div className="flex items-center justify-center gap-1">
          {st?.bookmark && (
            <span title={t("status.bookmark")} className="text-[12px] leading-none">🔖</span>
          )}
          <span
            className={`inline-block w-2 h-2 rounded-full ${
              st?.status === "approved" ? "bg-[var(--success)]"
              : st?.status === "review" ? "bg-[var(--warning)]"
              : st?.status === "draft" ? "bg-[var(--accent)]"
              : translated ? "bg-[var(--success)]/60"
              : "bg-[var(--text-faint)]/40"
            }`}
            title={
              st?.status ? t("status." + st.status)
              : translated ? t("status.translated") : t("status.untranslated")
            }
          />
        </div>
      </td>
    </tr>
  );
});

interface ColWidths {
  num: number;
  id: number;
  original: number;
  ua: number;
  status: number;
}

const DEFAULT_COL_WIDTHS: ColWidths = {
  num: 44,
  id: 180,
  original: 380,
  ua: 380,
  status: 56,
};

function countWords(s: string): number {
  if (!s) return 0;
  // Підрахунок слів: розділяємо по пробілах + знаках пунктуації, відкидаємо порожнє.
  const matches = s.trim().split(/[\s\p{P}]+/u).filter(Boolean);
  return matches.length;
}

export function SentenceTable() {
  const t = useT();
  const entries = useStore((s) => s.entries);
  const activeIndex = useStore((s) => s.activeIndex);
  const setActive = useStore((s) => s.setActive);
  const search = useStore((s) => s.search);
  const setSearch = useStore((s) => s.setSearch);
  const filter = useStore((s) => s.translatedFilter);
  const setFilter = useStore((s) => s.setTranslatedFilter);
  const filePath = useStore((s) => s.selectedFilePath);
  const fileName = filePath ? filePath.split(/[\\/]/).pop() : null;
  const statuses = useStore((s) => s.statuses);
  const toggleBookmark = useStore((s) => s.toggleEntryBookmark);
  const bulkSetStatus = useStore((s) => s.bulkSetStatus);
  const bulkCopy = useStore((s) => s.bulkCopyOriginalToTranslation);
  const bulkTrim = useStore((s) => s.bulkTrim);
  const exportTxt = useStore((s) => s.exportTxt);
  const importTxtContent = useStore((s) => s.importTxtContent);
  const undo = useStore((s) => s.undo);

  async function handleExportTxt() {
    // 3-кнопкова модалка: «Оригінал» / «Переклад» / «Скасувати». При кліку-поза
    // чи Esc — повертається null (відмова), і ми просто виходимо без жодних
    // подальших дій. Раніше confirm з 2 опцій трактував dismiss як "переклад",
    // що було неочікувано.
    const picked = await showChoose(
      t("txt.exportChoice.title"),
      t("txt.exportChoice.body"),
      [
        { key: "original", label: t("txt.exportChoice.original") },
        { key: "translation", label: t("txt.exportChoice.translation"), tone: "success" },
      ]
    );
    if (picked === null) return;  // dismiss → нічого не робимо
    const kind = picked as "original" | "translation";
    const r = exportTxt(kind);
    if (!r) return;
    const dest = await window.dp2.pickSaveFile({
      title: t("txt.exportTitle"),
      defaultPath: r.fileName + ".txt",
      filters: [{ name: "Text", extensions: ["txt"] }],
    });
    if (!dest) return;
    await window.dp2.writeFile(dest, r.content);
    await showAlert(t("dialog.exportSuccess"), t("txt.exported", { path: dest }), { tone: "success" });
  }

  async function handleImportTxt() {
    const src = await window.dp2.pickFile({
      title: t("txt.importTitle"),
      filters: [{ name: "Text", extensions: ["txt"] }],
    });
    if (!src) return;
    const txt = await window.dp2.readFile(src);
    const { applied, missing, mismatched } = importTxtContent(txt);
    const msg = t("txt.imported", { applied, missing }) +
      (mismatched > 0 ? "\n\n⚠ " + t("txt.mismatched", { n: mismatched }) : "");
    const tone = mismatched > 0 ? undefined : "success" as const;
    await showAlert(t("dialog.importResult"), msg, { tone });
  }

  const [selection, setSelection] = useState<Set<number>>(new Set());
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; index: number } | null>(null);
  const [colWidths, setColWidths] = useLocalStorage<ColWidths>("dp2.ui.tableCols", DEFAULT_COL_WIDTHS);
  const setCol = (k: keyof ColWidths) => (w: number) => setColWidths({ ...colWidths, [k]: w });
  const [wrapMode] = useLocalStorage<WrapMode>("dp2.ui.tableWrap", "default");
  const wrapCls =
    wrapMode === "wrap" ? "whitespace-pre-wrap break-words"
    : wrapMode === "clip" ? "line-clamp-1 whitespace-pre-wrap break-words"
    : "line-clamp-2 whitespace-pre-wrap break-words";

  const activeRowRef = useRef<HTMLTableRowElement | null>(null);
  useEffect(() => {
    activeRowRef.current?.scrollIntoView({ block: "nearest", behavior: "auto" });
  }, [activeIndex]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return entries
      .map((e, i) => ({ e, i }))
      .filter(({ e }) => {
        const st = statuses.entries[dp2StatusKey(e)];
        if (filter === "translated" && !isTranslated(e)) return false;
        // "Не перекладені" — лише записи, що реально потребують перекладу
        // (мають латинські літери в оригіналі). Числа, "—", порожні рядки
        // не вимагають перекладу — відсікаємо їх.
        if (filter === "untranslated" && (isTranslated(e) || !needsTranslation(e))) return false;
        if (filter === "draft" && st?.status !== "draft") return false;
        if (filter === "review" && st?.status !== "review") return false;
        if (filter === "approved" && st?.status !== "approved") return false;
        if (filter === "bookmarks" && !st?.bookmark) return false;
        if (!q) return true;
        return (
          e.en.toLowerCase().includes(q) ||
          (e.charaName ?? "").toLowerCase().includes(q) ||
          (e.itemName ?? "").toLowerCase().includes(q) ||
          (e.originalEn ?? "").toLowerCase().includes(q) ||
          e.id.toLowerCase().includes(q)
        );
      });
  }, [entries, search, filter, statuses]);

  // Тримаємо у refs, щоб обробники могли бути стабільними (useCallback з [] deps),
  // інакше memo-рядки втрачають вигоду через зміну identity функцій.
  const selectionRef = useRef(selection);
  const activeIndexRef = useRef(activeIndex);
  const filteredRef = useRef(filtered);
  useEffect(() => { selectionRef.current = selection; }, [selection]);
  useEffect(() => { activeIndexRef.current = activeIndex; }, [activeIndex]);
  useEffect(() => { filteredRef.current = filtered; }, [filtered]);

  const handleRowClick = useCallback((i: number, e: React.MouseEvent) => {
    const cur = selectionRef.current;
    const act = activeIndexRef.current;
    if (e.shiftKey && act !== null) {
      // Діапазон рахуємо за ПОЗИЦІЯМИ у видимому (відфільтрованому) списку, а не
      // за сирими entry-індексами — інакше shift захопить приховані фільтром рядки.
      const vis = filteredRef.current;
      const pa = vis.findIndex((r) => r.i === act);
      const pb = vis.findIndex((r) => r.i === i);
      const next = new Set(cur);
      if (pa >= 0 && pb >= 0) {
        const lo = Math.min(pa, pb);
        const hi = Math.max(pa, pb);
        for (let k = lo; k <= hi; k++) next.add(vis[k].i);
      } else {
        next.add(i); // fallback: якщо якийсь кінець не видно — беремо лише клікнутий
      }
      setSelection(next);
      setActive(i);
      return;
    }
    if (e.ctrlKey || e.metaKey) {
      const next = new Set(cur);
      if (next.has(i)) next.delete(i); else next.add(i);
      setSelection(next);
      setActive(i);
      return;
    }
    setSelection(new Set([i]));
    setActive(i);
  }, [setActive]);

  const handleRowContext = useCallback((i: number, e: React.MouseEvent) => {
    e.preventDefault();
    if (!selectionRef.current.has(i)) setSelection(new Set([i]));
    setCtxMenu({ x: e.clientX, y: e.clientY, index: i });
  }, []);

  const registerActiveRef = useCallback((node: HTMLTableRowElement | null) => {
    activeRowRef.current = node;
  }, []);

  // Закрити контекстне меню при кліку поза ним або Esc.
  useEffect(() => {
    if (!ctxMenu) return;
    const close = () => setCtxMenu(null);
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") close(); };
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [ctxMenu]);

  // Шорткати статусів та закладки. Тільки коли є активний рядок і фокус НЕ в інпуті.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const ctrl = e.ctrlKey || e.metaKey;
      const target = e.target as HTMLElement;
      const inEditable =
        target.closest("input, textarea, .monaco-editor, [contenteditable]") !== null;
      if (inEditable) return;
      if (activeIndex === null) return;
      const indices = selection.size > 0 ? Array.from(selection) : [activeIndex];
      // Ctrl+B — bookmark
      if (ctrl && !e.shiftKey && e.key.toLowerCase() === "b") {
        e.preventDefault();
        toggleBookmark(activeIndex);
        return;
      }
      // Alt+1/2/3 — статус draft/review/approved (Ctrl+1..3 теж приймаємо)
      if ((e.altKey || ctrl) && !e.shiftKey && (e.key === "1" || e.key === "2" || e.key === "3")) {
        e.preventDefault();
        const map: Record<string, StatusKind> = { "1": "draft", "2": "review", "3": "approved" };
        bulkSetStatus(indices, map[e.key]);
        return;
      }
      // Alt+0 — зняти статус
      if ((e.altKey || ctrl) && !e.shiftKey && e.key === "0") {
        e.preventDefault();
        bulkSetStatus(indices, undefined);
        return;
      }
      // Ctrl+Z — скасувати останню масову зміну (імпорт .txt тощо). Поза інпутами.
      if (ctrl && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "z") {
        e.preventDefault();
        undo();
        return;
      }
      // Esc — зняти виділення (multi-select). Тільки коли вибрано 2+ рядки.
      if (e.key === "Escape" && selection.size >= 2) {
        e.preventDefault();
        setSelection(new Set());
        return;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [activeIndex, selection, toggleBookmark, bulkSetStatus, undo]);

  // Стат-бар: рядки/слова/перекладено
  const stats = useMemo(() => {
    let totalRows = entries.length;
    let totalWords = 0;
    let translatedRows = 0;
    let translatedWords = 0;
    for (const e of entries) {
      const origText = e.originalEn ?? e.en ?? "";
      const wc = countWords(origText);
      totalWords += wc;
      if (isTranslated(e)) {
        translatedRows++;
        translatedWords += wc;
      }
    }
    const pctRows = totalRows > 0 ? (translatedRows / totalRows) * 100 : 0;
    const pctWords = totalWords > 0 ? (translatedWords / totalWords) * 100 : 0;
    return { totalRows, totalWords, translatedRows, translatedWords, pctRows, pctWords };
  }, [entries]);

  if (!fileName) {
    return (
      <section className="flex-1 flex items-center justify-center p-10 text-center bg-[var(--bg)]">
        <p className="text-[13px] text-[var(--text-muted)] max-w-md leading-relaxed">
          {t("tm.empty.pick")}
        </p>
      </section>
    );
  }

  return (
    <section className="h-full flex flex-col min-w-0 min-h-0 bg-[var(--bg)]">
      {/* Toolbar: search + filters. Статусні фільтри — кнопки-крапки з tooltip,
          щоб у вузькому вікні все вміщалося в один рядок. */}
      <div className="h-12 border-b border-[var(--border-soft)] flex items-center gap-2 px-3">
        <input
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={t("table.search.placeholder")}
          className="dp-input flex-1 max-w-md min-w-[100px]"
        />

        <div className="flex items-center gap-1 ml-2 shrink-0">
          {/* Основні: All / Untranslated / Translated — текст */}
          {[
            { v: "all", label: t("table.filter.all", { n: entries.length }) },
            { v: "untranslated", label: t("table.filter.untranslated") },
            { v: "translated", label: t("table.filter.translated") },
          ].map((opt) => (
            <button
              key={opt.v}
              onClick={() => setFilter(opt.v as any)}
              className={`dp-btn ${filter === opt.v ? "dp-btn--primary" : ""}`}
            >
              {opt.label}
            </button>
          ))}

          {/* Розділювач */}
          <span className="w-px h-5 bg-[var(--border-soft)] mx-1" />

          {/* Статусні — крапки з tooltip */}
          {[
            { v: "draft", label: t("status.draft"), color: "var(--accent)" },
            { v: "review", label: t("status.review"), color: "var(--warning)" },
            { v: "approved", label: t("status.approved"), color: "var(--success)" },
          ].map((opt) => (
            <button
              key={opt.v}
              onClick={() => setFilter(opt.v as any)}
              title={opt.label}
              className={`dp-btn dp-btn--ghost !w-7 !p-0 flex items-center justify-center ${
                filter === opt.v ? "border-[var(--accent)] bg-[var(--accent-soft)]" : ""
              }`}
            >
              <span
                className="inline-block w-2.5 h-2.5 rounded-full"
                style={{ background: opt.color }}
              />
            </button>
          ))}

          {/* Bookmarks — окрема icon-кнопка */}
          <button
            onClick={() => setFilter("bookmarks" as any)}
            title={t("status.bookmarks")}
            className={`dp-btn dp-btn--ghost !w-7 !p-0 flex items-center justify-center ${
              filter === "bookmarks" ? "border-[var(--accent)] bg-[var(--accent-soft)]" : ""
            }`}
          >
            <svg className="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 24 24">
              <path d="M5 5a2 2 0 012-2h10a2 2 0 012 2v16l-7-3.5L5 21V5z" />
            </svg>
          </button>
        </div>

        <button
          className="dp-btn dp-btn--ghost shrink-0"
          onClick={handleExportTxt}
          title={t("txt.export")}
        >
          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M9 5h-3a2 2 0 00-2 2v12a2 2 0 002 2h12a2 2 0 002-2v-3" />
            <path strokeLinecap="round" strokeLinejoin="round" d="M16 3l5 5m0 0v-5m0 5h-5M9 14l11-11" />
          </svg>
          <span className="hidden 2xl:inline">{t("txt.export")}</span>
        </button>
        <button
          className="dp-btn dp-btn--ghost shrink-0"
          onClick={handleImportTxt}
          title={t("txt.import")}
        >
          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M15 5h3a2 2 0 012 2v12a2 2 0 01-2 2H6a2 2 0 01-2-2V7a2 2 0 012-2h3" />
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 3v12m0 0l-4-4m4 4l4-4" />
          </svg>
          <span className="hidden 2xl:inline">{t("txt.import")}</span>
        </button>
      </div>

      {/* Bulk action bar — видимо коли вибрано 2+ рядки. Дає очевидні кнопки
          для затвердити / ревью / чернетка / зняти, бо без цього user мусив
          би знати шорткат Alt+3 або відкривати ПКМ-меню. */}
      {selection.size >= 2 && (
        <div className="h-9 px-3 flex items-center gap-2 border-b border-[var(--border-soft)] bg-[var(--accent-soft)]">
          <span className="text-[11.5px] font-semibold text-[var(--text-strong)] tabular-nums">
            {t("table.bulk.selected", { n: selection.size })}
          </span>
          <span className="w-px h-5 bg-[var(--border-soft)] mx-1" />
          <button
            className="dp-btn dp-btn--ghost !text-[11px] !py-0.5 flex items-center gap-1.5"
            onClick={() => { bulkSetStatus(Array.from(selection), "approved"); setSelection(new Set()); }}
            title={t("table.bulk.approveHint")}
          >
            <span className="inline-block w-2 h-2 rounded-full" style={{ background: "var(--success)" }} />
            {t("table.bulk.approve")}
          </button>
          <button
            className="dp-btn dp-btn--ghost !text-[11px] !py-0.5 flex items-center gap-1.5"
            onClick={() => { bulkSetStatus(Array.from(selection), "review"); setSelection(new Set()); }}
          >
            <span className="inline-block w-2 h-2 rounded-full" style={{ background: "var(--warning)" }} />
            {t("table.bulk.review")}
          </button>
          <button
            className="dp-btn dp-btn--ghost !text-[11px] !py-0.5 flex items-center gap-1.5"
            onClick={() => { bulkSetStatus(Array.from(selection), "draft"); setSelection(new Set()); }}
          >
            <span className="inline-block w-2 h-2 rounded-full" style={{ background: "var(--accent)" }} />
            {t("table.bulk.draft")}
          </button>
          <button
            className="dp-btn dp-btn--ghost !text-[11px] !py-0.5"
            onClick={() => { bulkSetStatus(Array.from(selection), undefined); setSelection(new Set()); }}
            title={t("table.bulk.clearHint")}
          >
            {t("table.bulk.clear")}
          </button>
          <div className="flex-1" />
          <button
            className="dp-btn dp-btn--ghost !text-[11px] !py-0.5"
            onClick={() => setSelection(new Set())}
            title={t("table.bulk.deselectHint")}
          >
            {t("table.bulk.deselect")}
          </button>
        </div>
      )}

      {/* Grid */}
      <div className="flex-1 overflow-auto">
        <table className="text-[12.5px] table-fixed" style={{ width: colWidths.num + colWidths.id + colWidths.original + colWidths.ua + colWidths.status }}>
          <colgroup>
            <col style={{ width: colWidths.num }} />
            <col style={{ width: colWidths.id }} />
            <col style={{ width: colWidths.original }} />
            <col style={{ width: colWidths.ua }} />
            <col style={{ width: colWidths.status }} />
          </colgroup>
          <thead className="sticky top-0 z-10 bg-[var(--bg-surface)] text-[11px] font-semibold uppercase tracking-wider text-[var(--text-muted)] border-b border-[var(--border-soft)]">
            <tr>
              <th className="text-left px-2 py-1.5 relative select-none">
                {t("table.col.num")}
                <ColResizer width={colWidths.num} onChange={setCol("num")} min={32} />
              </th>
              <th className="text-left px-2 py-1.5 relative select-none">
                {t("table.col.id")}
                <ColResizer width={colWidths.id} onChange={setCol("id")} min={60} />
              </th>
              <th className="text-left px-2 py-1.5 relative select-none">
                {t("table.col.original")}
                <ColResizer width={colWidths.original} onChange={setCol("original")} min={80} />
              </th>
              <th className="text-left px-2 py-1.5 relative select-none">
                {t("table.col.ua")}
                <ColResizer width={colWidths.ua} onChange={setCol("ua")} min={80} />
              </th>
              <th className="text-center px-1 py-1.5 relative select-none">
                {t("status.colTitle")}
                <ColResizer width={colWidths.status} onChange={setCol("status")} min={40} max={160} />
              </th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 ? (
              <tr>
                <td colSpan={5} className="text-center text-[var(--text-faint)] py-10">
                  {t("table.empty")}
                </td>
              </tr>
            ) : (
              filtered.map(({ e, i }) => (
                <Dp2TableRow
                  key={i}
                  e={e}
                  i={i}
                  isActive={i === activeIndex}
                  isSelected={selection.has(i)}
                  status={statuses.entries[dp2StatusKey(e)]}
                  translated={isTranslated(e)}
                  wrapCls={wrapCls}
                  t={t}
                  onClick={handleRowClick}
                  onContext={handleRowContext}
                  registerActiveRef={registerActiveRef}
                />
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* Context menu — позиція clamped, щоб не вилазило за viewport
         (інакше на нижніх рядках частина пунктів не видно). */}
      {ctxMenu && (
        <div
          className="fixed z-50 dp-card py-1 text-[12px] min-w-[240px] shadow-xl"
          style={{
            left: Math.min(ctxMenu.x, window.innerWidth - 260),
            top: Math.min(ctxMenu.y, window.innerHeight - 320),
          }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          {(() => {
            const idxs = selection.size > 0 ? Array.from(selection) : [ctxMenu.index];
            const close = () => setCtxMenu(null);
            const items = [
              { label: t("status.markDraft") + (idxs.length > 1 ? ` (${idxs.length})` : ""),
                action: () => { bulkSetStatus(idxs, "draft"); close(); } },
              { label: t("status.markReview") + (idxs.length > 1 ? ` (${idxs.length})` : ""),
                action: () => { bulkSetStatus(idxs, "review"); close(); } },
              { label: t("status.markApproved") + (idxs.length > 1 ? ` (${idxs.length})` : ""),
                action: () => { bulkSetStatus(idxs, "approved"); close(); } },
              { label: t("status.clear"),
                action: () => { bulkSetStatus(idxs, undefined); close(); } },
              { divider: true as const },
              { label: t("status.toggleBookmark"),
                action: () => { toggleBookmark(ctxMenu.index); close(); } },
              { divider: true as const },
              { label: t("bulk.copyOriginal") + (idxs.length > 1 ? ` (${idxs.length})` : ""),
                action: () => { bulkCopy(idxs); close(); } },
              { label: t("bulk.trim") + (idxs.length > 1 ? ` (${idxs.length})` : ""),
                action: () => { bulkTrim(idxs); close(); } },
            ];
            return items.map((it, i) =>
              "divider" in it ? (
                <div key={i} className="h-px bg-[var(--border-soft)] my-1" />
              ) : (
                <button
                  key={i}
                  onClick={it.action}
                  className="block w-full text-left px-3 py-1.5 hover:bg-[var(--row-hover)]"
                >
                  {it.label}
                </button>
              )
            );
          })()}
        </div>
      )}

      {/* Status bar — UELT-style */}
      <div className="h-7 px-3 border-t border-[var(--border-soft)] flex items-center gap-x-4 text-[11px] text-[var(--text-faint)] tabular-nums whitespace-nowrap overflow-x-auto">
        <span>
          {t("table.stat.rows")}: <span className="text-[var(--text)] font-semibold">{stats.totalRows}</span>
        </span>
        <span>
          {t("table.stat.words")}: <span className="text-[var(--text)] font-semibold">{stats.totalWords.toLocaleString()}</span>
        </span>
        <span>
          {t("table.stat.translatedRows")}:{" "}
          <span className="text-[var(--success)] font-semibold">{stats.translatedRows}</span>{" "}
          ({stats.pctRows.toFixed(2)}%)
        </span>
        <span>
          {t("table.stat.words")}:{" "}
          <span className="text-[var(--success)] font-semibold">{stats.translatedWords.toLocaleString()}</span>{" "}
          ({stats.pctWords.toFixed(2)}%)
        </span>
        {activeIndex !== null && (
          <span>
            {t("table.stat.position")}:{" "}
            <span className="text-[var(--text)] font-semibold">
              {activeIndex + 1}/{stats.totalRows}
            </span>
          </span>
        )}
        {selection.size > 0 && (
          <span>
            {t("status.selected")}: <span className="text-[var(--accent)] font-semibold">{selection.size}</span>
          </span>
        )}
        <span className="ml-auto"><MetricsBadge /></span>
        <span>· <span className="font-mono">{fileName}</span></span>
        <span>· {filtered.length} {t("table.stat.shown")}</span>
      </div>
    </section>
  );
}
