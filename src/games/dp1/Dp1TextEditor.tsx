import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import Editor, { type OnMount } from "@monaco-editor/react";
import type { editor as MonacoEditor } from "monaco-editor";
import { useT } from "../../lib/i18n";
import { useDp1Store } from "./store";
import { dp1ComputeFsl, dp1MarkerIssues } from "./parser";
import { useLocalStorage } from "../../lib/useLocalStorage";
import { useAutosave } from "../../lib/useAutosave";
import { Resizer } from "../../components/Resizer";
import { registerDpTextLanguage, DP_TOKEN_RULES } from "../../lib/monacoLang";
import { alert as showAlert, confirm as showConfirm } from "../../lib/dialogs";
import { CorpusStatsModal } from "../../components/CorpusStatsModal";
import { EditorFooter } from "../../components/EditorFooter";
import { LangToggle } from "../../components/LangToggle";
import { MonacoFontSizeControl, useMonacoFontSize } from "../../components/MonacoFontSize";
import { Dp1LintModal } from "./Dp1LintModal";
import { Dp1GlyphMapModal } from "./Dp1GlyphMapModal";

interface Props {
  onHome: () => void;
}

interface ColWidths {
  num: number;
  id: number;
  original: number;
  ua: number;
  status: number;
}
const DEFAULT_COLS: ColWidths = { num: 60, id: 90, original: 380, ua: 380, status: 40 };

// Висота одного рядка таблиці у пікселях — для `contain-intrinsic-size`,
// щоб браузер міг резервувати правильну висоту під ще-не-намальовані
// off-screen рядки (`content-visibility: auto`). Узгоджено з padding/font.
const ROW_HEIGHT = 44;

// Версія редактора — змінюю вручну при кожному фіксі продуктивності.
const DP1_PERF_VERSION = "V6";

// Скільки рядків тримати у DOM поза viewport'ом з кожного боку. 200 — щоб
// під час швидкого скролу користувач ніколи не побачив пустоти.
const VIRT_OVERSCAN = 200;

type Dp1Filter = "all" | "translated" | "untranslated" | "issues";

interface RowSummary {
  index: number;
  translated: boolean;
  hasIssues: boolean;
}

interface Counts {
  total: number;
  translated: number;
  untranslated: number;
  withIssues: number;
}

// Усі props — примітиви або стабільні refs, щоб React.memo (shallow) міг
// коректно skip-нути re-render для незмінених рядків. `active` сюди НЕ
// передаємо — підсвітку активного рядка робимо через data-атрибут + CSS,
// щоб клік не змушував перебудовувати весь масив 17K елементів.
const Dp1TableRow = memo(function Dp1TableRow(props: {
  index: number;
  translated: boolean;
  hasIssues: boolean;
  origText: string;
  doneText: string;
  id1: number;
  id2: number;
  cols: ColWidths;
  onSelect: (index: number) => void;
}) {
  const { index, translated, hasIssues, origText, doneText, id1, id2, cols, onSelect } = props;
  const wrapCls = "line-clamp-2 whitespace-pre-wrap break-words";
  return (
    <tr
      data-dp1-row={index}
      style={{
        height: ROW_HEIGHT,
        contentVisibility: "auto" as React.CSSProperties["contentVisibility"],
        containIntrinsicSize: `0 ${ROW_HEIGHT}px`,
      }}
      className={`dp1-row cursor-pointer border-b border-[var(--border-soft)] ${
        hasIssues ? "bg-[var(--danger)]/8" : ""
      }`}
      onClick={() => onSelect(index)}
    >
      <td style={{ width: cols.num }} className="px-2 py-1.5 text-[var(--text-faint)] tabular-nums text-[11px] align-top">{index}</td>
      <td style={{ width: cols.id }} className="px-2 py-1.5 font-mono text-[11px] text-[var(--text-muted)] align-top truncate">{id1}/{id2}</td>
      <td style={{ width: cols.original }} className="px-2 py-1.5 align-top text-[var(--text-muted)]">
        <p className={`leading-snug ${wrapCls}`}>{origText || <span className="text-[var(--text-faint)] italic">—</span>}</p>
      </td>
      <td style={{ width: cols.ua }} className="px-2 py-1.5 align-top text-[var(--text)]">
        <p className={`leading-snug ${wrapCls}`}>{doneText || <span className="text-[var(--text-faint)] italic">—</span>}</p>
      </td>
      <td style={{ width: cols.status }} className="px-1 py-1.5 text-center align-top">
        {hasIssues ? (
          <span className="text-[var(--danger)] text-[13px]" title="Маркери порушено">⚠</span>
        ) : translated ? (
          <span className="text-[var(--success)] text-[13px]" title="Перекладено">✓</span>
        ) : (
          <span className="text-[var(--text-faint)] text-[13px]" title="Не перекладено">○</span>
        )}
      </td>
    </tr>
  );
});

export function Dp1TextEditor({ onHome }: Props) {
  const t = useT();

  const init = useDp1Store((s) => s.init);
  const loading = useDp1Store((s) => s.loading);
  const error = useDp1Store((s) => s.error);
  const original = useDp1Store((s) => s.original);
  const done = useDp1Store((s) => s.done);
  const visibleIndices = useDp1Store((s) => s.visibleIndices);
  const selectedIndex = useDp1Store((s) => s.selectedIndex);
  const setSelectedIndex = useDp1Store((s) => s.setSelectedIndex);
  const searchQuery = useDp1Store((s) => s.searchQuery);
  const setSearchQuery = useDp1Store((s) => s.setSearchQuery);
  const filter = useDp1Store((s) => s.filter);
  const setFilter = useDp1Store((s) => s.setFilter);
  const updateText = useDp1Store((s) => s.updateText);
  const saveAll = useDp1Store((s) => s.saveAll);
  const dirty = useDp1Store((s) => s.dirty);
  const saving = useDp1Store((s) => s.saving);
  const meta = useDp1Store((s) => s.meta);

  const [fileListW, setFileListW] = useLocalStorage<number>("dp1.ui.fileListW", 240);
  const [editorW, setEditorW] = useLocalStorage<number>("dp1.ui.editorW", 560);
  const [cols] = useLocalStorage<ColWidths>("dp1.ui.tableCols", DEFAULT_COLS);

  const [statsOpen, setStatsOpen] = useState(false);
  const [lintOpen, setLintOpen] = useState(false);
  const [glyphMapOpen, setGlyphMapOpen] = useState(false);
  const [packing, setPacking] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [importing, setImporting] = useState(false);

  // Локальний draft пошуку для debounce — щоб не дзеркалити keystroke у store
  // (а через store — у worker) на кожен символ.
  // Mount-time timestamp — оновлюється при кожному вході у редактор.
  // Якщо ти бачиш свіжий час, але код тупить — це актуальна збірка.
  const [mountTs] = useState(() => new Date().toLocaleTimeString());

  const [searchDraft, setSearchDraft] = useState(searchQuery);
  useEffect(() => {
    const id = setTimeout(() => setSearchQuery(searchDraft), 150);
    return () => clearTimeout(id);
  }, [searchDraft, setSearchQuery]);

  useEffect(() => { init(); }, [init]);

  useAutosave(dirty && !saving, async () => { await saveAll(); }, 20_000);

  // ── Debounced edit queue ─────────────────────────────────────
  // Monaco keystrokes пишуть у ref, не одразу у store. Це знімає re-render
  // батьківського компонента (і відповідно — `.map(17K)` для таблиці) на
  // кожен символ. Store оновлюється:
  //   1) через 250мс після останнього keystroke (debounce),
  //   2) одразу при перемиканні рядка,
  //   3) одразу перед save / pack / export.
  const pendingEditRef = useRef<{ index: number; text: string } | null>(null);
  const debounceRef = useRef<number | null>(null);
  const flushPending = useCallback(() => {
    if (debounceRef.current != null) {
      window.clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }
    const p = pendingEditRef.current;
    if (p) {
      updateText(p.index, p.text);
      pendingEditRef.current = null;
    }
  }, [updateText]);
  const queueEdit = useCallback((index: number, text: string) => {
    pendingEditRef.current = { index, text };
    if (debounceRef.current != null) window.clearTimeout(debounceRef.current);
    debounceRef.current = window.setTimeout(() => { flushPending(); }, 250);
  }, [flushPending]);
  // Якщо selectedIndex змінився — flush для попереднього рядка (ref зберігає його index).
  useEffect(() => { flushPending(); }, [selectedIndex, flushPending]);

  // ── Worker + readiness стадії ─────────────────────────────────
  // Для loading screen відстежуємо 3 стадії:
  //   1) storeLoaded — IPC dp1-text-load повернув дані (loading=false)
  //   2) workerReady — worker отримав init + ми отримали перший counts
  //   3) firstRowsReady — worker віддав перший набір рядків
  // Редактор показуємо лише коли всі 3 = true.
  const workerRef = useRef<Worker | null>(null);
  const reqIdRef = useRef(0);
  const [rows, setRows] = useState<RowSummary[]>([]);
  const [counts, setCounts] = useState<Counts>({ total: 0, translated: 0, untranslated: 0, withIssues: 0 });
  const [workerReady, setWorkerReady] = useState(false);
  const [firstRowsReady, setFirstRowsReady] = useState(false);
  const storeLoaded = !loading && original.length > 0;
  const allReady = storeLoaded && workerReady && firstRowsReady;

  useEffect(() => {
    const w = new Worker(new URL("./dp1.worker.ts", import.meta.url), { type: "module" });
    workerRef.current = w;
    w.onmessage = (e: MessageEvent<{ type: string; rows?: RowSummary[]; counts?: Counts }>) => {
      const msg = e.data;
      if (msg.type === "rows" && msg.rows) {
        setRows(msg.rows);
        setFirstRowsReady(true);
      } else if (msg.type === "counts" && msg.counts) {
        setCounts(msg.counts);
        setWorkerReady(true);
      }
    };
    return () => { w.terminate(); workerRef.current = null; };
  }, []);

  // Скидаємо readiness прапорці, якщо store перезавантажується (reload).
  useEffect(() => {
    if (loading) {
      setWorkerReady(false);
      setFirstRowsReady(false);
    }
  }, [loading]);

  // Init worker: завантажуємо у нього original + done одноразово після init().
  // Передача 8MB JSON у worker через postMessage — це structured clone (~30ms).
  // Робимо це лише після завантаження даних і коли воно реально змінюється
  // (наприклад, після reload).
  const initSeqRef = useRef(0);
  useEffect(() => {
    const w = workerRef.current;
    if (!w || original.length === 0 || done.length === 0) return;
    const id = ++reqIdRef.current;
    initSeqRef.current = id;
    w.postMessage({ id, type: "init", original, done, visibleIndices });
  }, [original, done, visibleIndices]);

  // При зміні фільтра/пошуку — запит у worker. Він повертає масив рядків.
  useEffect(() => {
    const w = workerRef.current;
    if (!w || original.length === 0) return;
    const id = ++reqIdRef.current;
    w.postMessage({ id, type: "query", filter, query: searchQuery });
  }, [filter, searchQuery, original.length, done]);

  // Коли користувач редагує текст — оновлюємо worker і просимо нові counts.
  // Це робить лічильник «Перекладено: N/M %» точним без розсинхрону.
  // Боттлнек: при швидкому набиранні відсилаємо одне updateOne на keystroke.
  // Worker сам тримає cache per-row, тож update — O(1).
  const lastUpdateRef = useRef<{ index: number; text: string } | null>(null);
  useEffect(() => {
    const w = workerRef.current;
    if (!w || selectedIndex == null) return;
    const text = done[selectedIndex]?.Text ?? "";
    const last = lastUpdateRef.current;
    if (last && last.index === selectedIndex && last.text === text) return;
    lastUpdateRef.current = { index: selectedIndex, text };
    const id = ++reqIdRef.current;
    w.postMessage({ id, type: "updateOne", index: selectedIndex, text });
    // Після updateOne запитуємо rows із актуальним статусом активного рядка.
    const id2 = ++reqIdRef.current;
    w.postMessage({ id: id2, type: "query", filter, query: searchQuery });
  }, [done, selectedIndex, filter, searchQuery]);

  // Активний рядок — у пам'яті, доступ за `selectedIndex` (це абсолютний індекс).
  const activeRow = useMemo(() => {
    if (selectedIndex == null) return null;
    const o = original[selectedIndex];
    const d = done[selectedIndex];
    if (!o || !d) return null;
    return { index: selectedIndex, original: o, done: d };
  }, [selectedIndex, original, done]);

  const tagDiff = useMemo(() => {
    if (!activeRow) return { missing: [] as string[], extra: [] as string[] };
    return dp1MarkerIssues(activeRow.original.Text ?? "", activeRow.done.Text ?? "");
  }, [activeRow]);

  const filteredIndices = useMemo(() => rows.map((r) => r.index), [rows]);

  // Віртуалізація: рендеримо лише window'у + 200 overscan з кожного боку.
  // 17K DOM-нод занадто важко монтувати навіть з content-visibility;
  // overscan 200 робить window-зміну при скролі непомітною.
  const tableScrollRef = useRef<HTMLDivElement | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportH, setViewportH] = useState(600);
  useEffect(() => {
    const el = tableScrollRef.current;
    if (!el) return;
    const upd = () => setViewportH(el.clientHeight);
    upd();
    const ro = new ResizeObserver(upd);
    ro.observe(el);
    return () => ro.disconnect();
  }, [allReady]);

  const onTableScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
    setScrollTop(e.currentTarget.scrollTop);
  }, []);

  const visibleStart = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - VIRT_OVERSCAN);
  const visibleEnd = Math.min(rows.length, Math.ceil((scrollTop + viewportH) / ROW_HEIGHT) + VIRT_OVERSCAN);
  const padTop = visibleStart * ROW_HEIGHT;
  const padBottom = Math.max(0, (rows.length - visibleEnd) * ROW_HEIGHT);

  // Scroll активного рядка у viewport.
  useEffect(() => {
    if (selectedIndex == null) return;
    if (!allReady) return;
    const el = tableScrollRef.current;
    if (!el) return;
    const pos = rows.findIndex((r) => r.index === selectedIndex);
    if (pos < 0) return;
    const rowTop = pos * ROW_HEIGHT;
    const rowBot = rowTop + ROW_HEIGHT;
    if (rowTop < el.scrollTop) el.scrollTop = rowTop;
    else if (rowBot > el.scrollTop + viewportH) el.scrollTop = rowBot - viewportH;
  }, [selectedIndex, rows, viewportH, allReady]);

  const handleSelect = useCallback((i: number) => { setSelectedIndex(i); }, [setSelectedIndex]);

  // useMemo для видимого slice'у <Dp1TableRow/>: ребудовується лише при
  // зміні window'и (start/end), rows, original, done, cols. selectedIndex
  // навмисно НЕ у deps — підсвітку робимо через CSS data-атрибут.
  const renderedRows = useMemo(() => {
    const out: React.ReactNode[] = [];
    for (let i = visibleStart; i < visibleEnd; i++) {
      const row = rows[i];
      if (!row) continue;
      const o = original[row.index];
      const d = done[row.index];
      out.push(
        <Dp1TableRow
          key={row.index}
          index={row.index}
          translated={row.translated}
          hasIssues={row.hasIssues}
          origText={o?.Text ?? ""}
          doneText={d?.Text ?? ""}
          id1={o?.Id1 ?? 0}
          id2={o?.Id2 ?? 0}
          cols={cols}
          onSelect={handleSelect}
        />
      );
    }
    return out;
  }, [rows, visibleStart, visibleEnd, original, done, cols, handleSelect]);

  // Підсвітка активного рядка — через DOM-атрибут, без re-render.
  useEffect(() => {
    const root = tableScrollRef.current;
    if (!root) return;
    const prev = root.querySelector("tr[data-dp1-active]");
    if (prev) prev.removeAttribute("data-dp1-active");
    if (selectedIndex == null) return;
    const next = root.querySelector(`tr[data-dp1-row='${selectedIndex}']`);
    if (next) next.setAttribute("data-dp1-active", "");
  }, [selectedIndex, renderedRows]);

  // ── Глобальні шорткати ────────────────────────────────────────
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const ctrl = e.ctrlKey || e.metaKey;
      const target = e.target as HTMLElement;
      const inMonaco = target.closest(".monaco-editor") !== null;
      const inInput = target.closest("input, textarea") !== null;

      if (ctrl && !e.shiftKey && e.key.toLowerCase() === "s") {
        e.preventDefault();
        if (dirty) saveAll();
        return;
      }
      if (!inMonaco && !inInput && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
        if (selectedIndex == null || filteredIndices.length === 0) return;
        const pos = filteredIndices.indexOf(selectedIndex);
        if (pos < 0) return;
        const nextPos = e.key === "ArrowUp"
          ? Math.max(0, pos - 1)
          : Math.min(filteredIndices.length - 1, pos + 1);
        if (nextPos !== pos) {
          e.preventDefault();
          setSelectedIndex(filteredIndices[nextPos]);
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [dirty, saveAll, selectedIndex, filteredIndices, setSelectedIndex]);

  // ── Handlers ──────────────────────────────────────────────────
  async function handleSave() {
    flushPending();
    const r = await saveAll();
    if (!r.ok) await showAlert("Помилка збереження", r.error ?? "");
  }

  async function handlePack() {
    flushPending();
    if (dirty) {
      const sr = await saveAll();
      if (!sr.ok) { await showAlert("Помилка збереження", sr.error ?? ""); return; }
    }
    const lr = await window.dp2.dp1TextLintMarkers();
    if (lr.ok && lr.violations && lr.violations.length > 0) {
      const proceed = await showConfirm(
        `Знайдено ${lr.violations.length} рядків з порушеннями маркерів`,
        "Можна продовжити пакування, але .mes може зламатись у грі. Все одно паковати?\n\n(Натисни «Ні» — відкриється детальний перегляд порушень.)",
        { tone: "warning" }
      );
      if (!proceed) { setLintOpen(true); return; }
    }
    setPacking(true);
    try {
      const r = await window.dp2.dp1Pack();
      if (!r.ok) {
        await showAlert("Помилка пакування", r.error ?? "");
      } else if (r.warning) {
        await showAlert("Готово, але…", `${r.warning}\n\nПроміжний файл:\n${r.intermediatePath ?? ""}`, { tone: "warning" });
      } else {
        await showAlert("Готово!", `mes_all.mes записано:\n${r.outputPath ?? ""}${r.bakPath ? "\n\nКопію попередньої версії збережено як .bak." : ""}`, { tone: "success" });
      }
    } finally { setPacking(false); }
  }

  async function handleExportCombined() {
    flushPending();
    if (dirty) await saveAll();
    setExporting(true);
    try {
      const dest = await window.dp2.pickSaveFile({
        title: "Експорт combined.txt",
        defaultPath: "mes_all-combined.txt",
        filters: [{ name: "Text", extensions: ["txt"] }],
      });
      if (!dest) return;
      const r = await window.dp2.dp1TextExportCombined({ path: dest });
      if (!r.ok) await showAlert("Помилка експорту", r.error ?? "");
      else await showAlert("Експорт виконано", `Записано ${r.bytes ?? 0} байт у:\n${r.path}`, { tone: "success" });
    } finally { setExporting(false); }
  }

  async function handleImportCombined() {
    setImporting(true);
    try {
      const src = await window.dp2.pickFile({
        title: "Імпорт combined.txt",
        filters: [{ name: "Text", extensions: ["txt"] }],
      });
      if (!src) return;
      const r = await window.dp2.dp1TextImportCombined({ path: src });
      if (!r.ok) { await showAlert("Помилка імпорту", r.error ?? ""); return; }
      let msg = `Застосовано: ${r.applied ?? 0}\nПропущено: ${r.skipped ?? 0}`;
      if (r.fakeDiffs && r.fakeDiffs.length > 0) msg += `\n\n⚠ ${r.fakeDiffs.length} блоків мали EN, що не збігається з Original — їх пропущено. Перевір файл.`;
      await showAlert("Імпорт виконано", msg, { tone: r.fakeDiffs?.length ? "warning" : "success" });
      await init();
    } finally { setImporting(false); }
  }

  // ── Render ────────────────────────────────────────────────────
  if (error) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center bg-[var(--bg)] gap-3 p-8">
        <p className="text-[14px] text-[var(--danger)] font-semibold">Не вдалося завантажити</p>
        <p className="text-[12px] text-[var(--text-muted)] max-w-[500px] text-center font-mono whitespace-pre-wrap">{error}</p>
        <button className="dp-btn dp-btn--primary" onClick={() => init()}>Спробувати знову</button>
        <button className="dp-btn dp-btn--ghost" onClick={onHome}>На головну</button>
      </div>
    );
  }
  if (!allReady) {
    // 3-стадійний loading. Кожна стадія показує спінер / зелену галочку.
    type Stage = "pending" | "running" | "done";
    const stageStore: Stage = storeLoaded ? "done" : loading ? "running" : "pending";
    const stageWorker: Stage = workerReady ? "done" : storeLoaded ? "running" : "pending";
    const stageRows: Stage = firstRowsReady ? "done" : workerReady ? "running" : "pending";
    const Step = ({ n, state, title, desc }: { n: number; state: Stage; title: string; desc: string }) => (
      <div className="flex items-start gap-3">
        <span
          className={`flex h-7 w-7 items-center justify-center rounded-full border text-[12px] font-bold shrink-0 ${
            state === "done"
              ? "bg-[var(--success)]/15 text-[var(--success)] border-[var(--success)]/40"
              : state === "running"
                ? "bg-[var(--accent)]/15 text-[var(--accent)] border-[var(--accent)]/40"
                : "bg-[var(--bg-elevated)] text-[var(--text-muted)] border-[var(--border-soft)]"
          }`}
        >
          {state === "done" ? "✓" : state === "running" ? (
            <span className="inline-block w-3 h-3 rounded-full border-2 border-[var(--text-faint)] border-t-[var(--accent)] animate-spin" aria-hidden />
          ) : n}
        </span>
        <div className="flex-1 min-w-0">
          <p className={`text-[13px] font-semibold ${state === "pending" ? "text-[var(--text-muted)]" : "text-[var(--text-strong)]"}`}>{title}</p>
          <p className="text-[11.5px] text-[var(--text-muted)] leading-relaxed">{desc}</p>
        </div>
      </div>
    );
    return (
      <div className="flex-1 flex flex-col bg-[var(--bg)] min-h-0">
        <header className="h-12 px-3 border-b border-[var(--border-soft)] bg-[var(--bg-surface)] flex items-center gap-2 shrink-0">
          <button className="dp-btn dp-btn--ghost shrink-0" onClick={onHome} title={t("header.home")}>←</button>
          <span className="text-[13px] font-semibold text-[var(--text-strong)] truncate">Deadly Premonition</span>
          <span
            className="text-[9px] uppercase tracking-wider text-[var(--accent)] font-mono px-1.5 py-0.5 rounded border border-[var(--accent)]/40 bg-[var(--accent)]/5 ml-2"
          >
            DP1-PERF-{DP1_PERF_VERSION} · {mountTs}
          </span>
        </header>
        <div className="flex-1 flex items-center justify-center bg-[var(--bg)] p-8">
          <div className="w-full max-w-[480px] flex flex-col gap-5">
            <div className="text-center">
              <h2 className="text-[18px] font-bold text-[var(--text-strong)] mb-1">Підготовка редактора…</h2>
              <p className="text-[12px] text-[var(--text-muted)]">17 тисяч діалогів — це не миттєво. Зачекай пару секунд.</p>
            </div>
            <div className="dp-card p-5 flex flex-col gap-4">
              <Step n={1} state={stageStore} title="Завантаження mes_all.json" desc="Читаємо Original + Done з диску у пам'ять." />
              <Step n={2} state={stageWorker} title="Підготовка індексів" desc="Worker-потік рахує статус кожного рядка (перекладений / маркери)." />
              <Step n={3} state={stageRows} title="Збір таблиці" desc="Формуємо фільтрований список — далі редактор відкриється." />
            </div>
            <p className="text-center text-[10px] text-[var(--text-faint)]">Завантаження виконується у фоновому потоці — UI не блокується.</p>
          </div>
        </div>
      </div>
    );
  }

  const percent = counts.total ? Math.round((counts.translated / counts.total) * 100) : 0;
  const filterPills: { id: Dp1Filter; label: string; count: number }[] = [
    { id: "all", label: "Усі", count: counts.total },
    { id: "untranslated", label: "Не перекладені", count: counts.untranslated },
    { id: "translated", label: "Перекладені", count: counts.translated },
    { id: "issues", label: "Маркери ⚠", count: counts.withIssues },
  ];

  return (
    <div className="flex-1 flex flex-col bg-[var(--bg)] min-h-0">
      <style>{`
        .dp1-row { transition: background-color 0.08s linear; }
        .dp1-row:hover { background-color: var(--row-hover); }
        .dp1-row[data-dp1-active] { background-color: var(--row-active) !important; }
      `}</style>
      <header className="h-12 px-3 border-b border-[var(--border-soft)] bg-[var(--bg-surface)] flex items-center gap-2 shrink-0 flex-wrap">
        <button className="dp-btn dp-btn--ghost shrink-0" onClick={onHome} title={t("header.home")}>←</button>
        <span className="text-[13px] font-semibold text-[var(--text-strong)] truncate">Deadly Premonition</span>
        <span className="text-[11px] text-[var(--text-faint)] hidden md:inline truncate">· Director's Cut · MES</span>
        <span
          className="text-[9px] uppercase tracking-wider text-[var(--accent)] font-mono px-1.5 py-0.5 rounded border border-[var(--accent)]/40 bg-[var(--accent)]/5"
          title="DP1 editor build marker — оновлюється при кожному вході у редактор"
        >
          DP1-PERF-{DP1_PERF_VERSION} · {mountTs}
        </span>
        <span className="text-[11px] tabular-nums text-[var(--text-muted)] ml-2 whitespace-nowrap">
          {counts.translated.toLocaleString("uk-UA")} / {counts.total.toLocaleString("uk-UA")}
          <span className={`ml-1 font-semibold ${percent === 100 ? "text-[var(--success)]" : ""}`}>· {percent}%</span>
        </span>
        <div className="flex-1 min-w-0" />
        <button className="dp-btn dp-btn--ghost shrink-0" onClick={handleExportCombined} disabled={exporting} title="Експорт combined.txt">↥ Експорт</button>
        <button className="dp-btn dp-btn--ghost shrink-0" onClick={handleImportCombined} disabled={importing} title="Імпорт combined.txt">↧ Імпорт</button>
        <button className="dp-btn dp-btn--ghost shrink-0" onClick={() => setLintOpen(true)} title="Перевірка цілісності маркерів">⚠ Lint</button>
        <button className="dp-btn dp-btn--ghost shrink-0" onClick={() => setStatsOpen(true)} title={t("stats.btn")}>{t("stats.btnShort")}</button>
        <button
          className="dp-btn dp-btn--ghost shrink-0"
          onClick={() => setGlyphMapOpen(true)}
          title="Мапа підміни гліфів для пакування (Я→Ó, ї→ï тощо)"
        >
          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
            <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
          </svg>
        </button>
        <button className="dp-btn shrink-0" disabled={!dirty || saving} onClick={handleSave} title="Ctrl+S">{saving ? "…" : dirty ? "Зберегти" : "Збережено"}</button>
        <button className="dp-btn dp-btn--success shrink-0" disabled={packing} onClick={handlePack} title="Запакувати у .mes і покласти в гру">{packing ? "…" : "Запакувати у гру"}</button>
        <LangToggle compact />
      </header>

      <div className="flex-1 flex min-h-0">
        {/* LEFT — File info */}
        <div style={{ width: fileListW }} className="h-full bg-[var(--bg-surface)] border-r border-[var(--border-soft)] flex flex-col overflow-y-auto">
          <div className="px-3 py-2 border-b border-[var(--border-soft)] text-[10px] uppercase tracking-wider text-[var(--text-muted)] font-semibold">Файл проєкту</div>
          <div className="p-3">
            <div className="dp-card p-3 flex flex-col gap-2">
              <div className="flex items-center gap-2">
                <span className="text-[14px]">📄</span>
                <span className="font-mono text-[12px] text-[var(--text-strong)]">mes_all.json</span>
              </div>
              <div className="text-[11px] text-[var(--text-muted)]">Записів: <span className="tabular-nums text-[var(--text-strong)]">{counts.total.toLocaleString("uk-UA")}</span></div>
              <div className="text-[11px] text-[var(--text-muted)]">Перекладено: <span className="tabular-nums text-[var(--success)]">{counts.translated.toLocaleString("uk-UA")}</span></div>
              <div className="h-1.5 bg-[var(--bg)] rounded overflow-hidden border border-[var(--border-soft)]">
                <div className="h-full bg-[var(--success)]" style={{ width: `${percent}%` }} />
              </div>
              <div className="text-[10px] text-[var(--text-faint)] tabular-nums text-right">{percent}%</div>
            </div>
            {meta && (
              <div className="mt-3 text-[10.5px] text-[var(--text-faint)] space-y-1">
                {meta.extractedAt && <div>Видобуто: <span className="text-[var(--text-muted)]">{new Date(meta.extractedAt).toLocaleString()}</span></div>}
                {meta.lastSavedAt && <div>Останнє збереження: <span className="text-[var(--text-muted)]">{new Date(meta.lastSavedAt).toLocaleString()}</span></div>}
                {meta.sourceMes && <div className="truncate" title={meta.sourceMes}>Джерело: <span className="font-mono text-[var(--text-muted)]">{meta.sourceMes.split(/[\\/]/).pop()}</span></div>}
              </div>
            )}
            <div className="mt-3 flex flex-col gap-1.5">
              <button className="dp-btn dp-btn--ghost text-[11px] w-full" onClick={() => init()}>↻ Перезавантажити з диску</button>
            </div>
          </div>
        </div>
        <Resizer value={fileListW} onChange={setFileListW} min={180} max={400} />

        {/* CENTER — Table */}
        <div className="flex-1 min-w-0 h-full flex flex-col">
          <div className="px-3 py-2 border-b border-[var(--border-soft)] bg-[var(--bg-surface)] flex items-center gap-2 flex-wrap">
            <input
              type="text"
              className="dp-input flex-1 min-w-[180px]"
              placeholder="Пошук за ID / оригіналом / перекладом…"
              value={searchDraft}
              onChange={(e) => setSearchDraft(e.target.value)}
            />
            <div className="flex items-center gap-1 flex-wrap">
              {filterPills.map((f) => (
                <button
                  key={f.id}
                  className={`px-2 py-1 text-[11px] rounded border transition-colors ${
                    filter === f.id
                      ? "bg-[var(--accent)] text-white border-[var(--accent)]"
                      : "bg-transparent text-[var(--text-muted)] border-[var(--border-soft)] hover:border-[var(--accent)]/40 hover:text-[var(--text)]"
                  }`}
                  onClick={() => setFilter(f.id)}
                >
                  {f.label}
                  <span className="ml-1 tabular-nums text-[10px] opacity-70">{f.count.toLocaleString("uk-UA")}</span>
                </button>
              ))}
            </div>
            <span className="text-[10.5px] text-[var(--text-faint)] tabular-nums ml-auto">
              Показано: {rows.length.toLocaleString("uk-UA")}
            </span>
          </div>

          <div ref={tableScrollRef} className="flex-1 overflow-y-auto" onScroll={onTableScroll}>
            <table className="w-full table-fixed text-[12px] border-collapse">
              <thead className="sticky top-0 bg-[var(--bg-surface)] z-10 border-b border-[var(--border-soft)]">
                <tr>
                  <th style={{ width: cols.num }} className="px-2 py-1.5 text-left text-[10px] uppercase tracking-wider text-[var(--text-faint)] font-semibold">№</th>
                  <th style={{ width: cols.id }} className="px-2 py-1.5 text-left text-[10px] uppercase tracking-wider text-[var(--text-faint)] font-semibold">Id1/Id2</th>
                  <th style={{ width: cols.original }} className="px-2 py-1.5 text-left text-[10px] uppercase tracking-wider text-[var(--text-faint)] font-semibold">Оригінал</th>
                  <th style={{ width: cols.ua }} className="px-2 py-1.5 text-left text-[10px] uppercase tracking-wider text-[var(--text-faint)] font-semibold">Переклад</th>
                  <th style={{ width: cols.status }} className="px-1 py-1.5 text-center text-[10px] uppercase tracking-wider text-[var(--text-faint)] font-semibold">·</th>
                </tr>
              </thead>
              <tbody>
                {padTop > 0 && <tr style={{ height: padTop }}><td colSpan={5} /></tr>}
                {renderedRows}
                {padBottom > 0 && <tr style={{ height: padBottom }}><td colSpan={5} /></tr>}
                {rows.length === 0 && (
                  <tr>
                    <td colSpan={5} className="px-3 py-10 text-center text-[12px] text-[var(--text-faint)]">
                      Нічого не знайдено за цим запитом.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          <EditorFooter
            fileName="mes_all.json"
            stats={[
              { label: "Видно", value: rows.length, tone: "default" },
              { label: "Усього", value: counts.total, tone: "default" },
              {
                label: "Перекладено",
                value: `${counts.translated} (${percent}%)`,
                tone: "success",
              },
              ...(counts.withIssues > 0
                ? [{ label: "З маркерами", value: counts.withIssues, tone: "warning" as const }]
                : []),
              ...(selectedIndex !== null
                ? [{ label: "Позиція", value: `${selectedIndex + 1}/${counts.total}`, tone: "accent" as const }]
                : []),
            ]}
          />
        </div>

        <Resizer value={editorW} onChange={setEditorW} invert min={360} max={900} />

        {/* RIGHT — Monaco (stable instance) */}
        <div style={{ width: editorW }} className="h-full bg-[var(--bg-surface)] border-l border-[var(--border-soft)] flex flex-col">
          <Dp1MonacoPane
            row={activeRow}
            tagDiff={tagDiff}
            onChange={(text) => {
              if (activeRow) queueEdit(activeRow.index, text);
            }}
          />
        </div>
      </div>

      <CorpusStatsModal
        open={statsOpen}
        onClose={() => setStatsOpen(false)}
        mode="dp1"
        computeCustomStats={async () => {
          const r = await window.dp2.dp1TextCorpusStats();
          if (!r.ok) return null;
          return {
            files: r.files ?? 0,
            totalEntries: r.totalEntries ?? 0,
            translatedEntries: r.translatedEntries ?? 0,
            percent: r.percent ?? 0,
            uaWords: r.uaWords ?? 0,
            enWords: r.enWords ?? 0,
            uaChars: r.uaChars ?? 0,
            enChars: r.enChars ?? 0,
            topFiles: r.topFiles ?? [],
          };
        }}
      />
      <Dp1LintModal
        open={lintOpen}
        onClose={() => setLintOpen(false)}
        onGoTo={(idx) => { setSelectedIndex(idx); setLintOpen(false); }}
      />
      <Dp1GlyphMapModal
        open={glyphMapOpen}
        onClose={() => setGlyphMapOpen(false)}
      />
    </div>
  );
}

// ── Stable Monaco pane ────────────────────────────────────────────────
// Не remount-имо редактор при перемиканні рядка — лише оновлюємо value
// прямо через model.setValue() + push undo stack element, щоб історія
// undo не плуталась між рядками. Це знімає затримку ~50ms на кожен клік.
function Dp1MonacoPane(props: {
  row: { index: number; original: import("../../lib/ipc").Dp1Record; done: import("../../lib/ipc").Dp1Record } | null;
  tagDiff: { missing: string[]; extra: string[] };
  onChange: (text: string) => void;
}) {
  const { row, tagDiff, onChange } = props;
  const [monacoFontSize] = useMonacoFontSize();
  const editorRef = useRef<MonacoEditor.IStandaloneCodeEditor | null>(null);
  const lastRowIndexRef = useRef<number | null>(null);
  // Прапор: коли ми міняємо value programmatically (зміна рядка), onChange
  // спрацьовує — фільтруємо, щоб не записати назад у store.
  const skipNextChangeRef = useRef(false);

  const handleMount: OnMount = (editor, monaco) => {
    editorRef.current = editor;
    registerDpTextLanguage(monaco);
    monaco.editor.defineTheme("dp1-dark", {
      base: "vs-dark",
      inherit: true,
      rules: DP_TOKEN_RULES,
      colors: { "editor.background": "#0d1117" },
    });
    monaco.editor.setTheme("dp1-dark");
    editor.focus();
  };

  // Синхронізація: коли row змінився — переписати модель.
  useEffect(() => {
    const ed = editorRef.current;
    if (!ed || !row) return;
    if (lastRowIndexRef.current !== row.index) {
      // Переключення на інший рядок — повна заміна тексту + reset undo.
      lastRowIndexRef.current = row.index;
      skipNextChangeRef.current = true;
      const model = ed.getModel();
      if (model) {
        model.setValue(row.done.Text ?? "");
        model.pushStackElement(); // нова undo-точка
      }
      ed.setPosition({ lineNumber: 1, column: 1 });
      ed.focus();
    }
    // Той самий рядок — НЕ синкаємо з row.done.Text. Monaco-модель є
    // джерелом істини під час набору; debounced flush у parent не повинен
    // переписувати її назад (інакше з'їдається останній символ, якщо він
    // прийшов МІЖ flush'ом і цим effect'ом).
  }, [row]);

  const fslPreview = useMemo(() => dp1ComputeFsl(row?.done.Text ?? ""), [row]);
  const fslOrig = row?.original.FirstSegmentLenght ?? 0;
  const fslDiff = fslPreview !== fslOrig;

  const tokens = useMemo(() => {
    if (!row) return [] as string[];
    const set = new Set<string>();
    const m = (row.original.Text ?? "").match(/\{[^{}]+\}/g) ?? [];
    for (const tok of m) set.add(tok);
    return [...set];
  }, [row]);

  function insertToken(tok: string) {
    const ed = editorRef.current;
    if (!ed || !row) return;
    const sel = ed.getSelection();
    if (sel) {
      ed.executeEdits("insertToken", [{ range: sel, text: tok, forceMoveMarkers: true }]);
      ed.focus();
    }
  }

  if (!row) {
    return (
      <div className="flex-1 flex items-center justify-center text-[12px] text-[var(--text-faint)]">
        Обери рядок ліворуч.
      </div>
    );
  }

  return (
    <>
      <div className="px-3 py-2 border-b border-[var(--border-soft)] flex items-baseline gap-3 flex-wrap">
        <span className="text-[12px] font-semibold text-[var(--text-strong)]">Запис #{row.index}</span>
        <span className="text-[11px] font-mono text-[var(--text-muted)]">Id1/Id2: <span className="text-[var(--text)]">{row.original.Id1}/{row.original.Id2}</span></span>
        <span className="text-[11px] font-mono text-[var(--text-faint)]">flags {row.original.Flag1}/{row.original.Flag2}</span>
        <span className="text-[11px] text-[var(--text-faint)] ml-auto" title="Перерахується при save">
          FSL: <span className={`tabular-nums ${fslDiff ? "text-[var(--warning)]" : "text-[var(--text-muted)]"}`}>{fslPreview}</span>
          <span className="text-[var(--text-faint)]">{` · orig ${fslOrig}`}</span>
        </span>
      </div>

      <div className="px-3 py-2 border-b border-[var(--border-soft)] bg-[var(--bg)]">
        <div className="text-[10px] uppercase tracking-wider text-[var(--text-muted)] mb-1">EN — оригінал</div>
        <p className="text-[12.5px] text-[var(--text-muted)] whitespace-pre-wrap leading-snug break-words max-h-[160px] overflow-y-auto font-mono">{row.original.Text}</p>
      </div>

      {tokens.length > 0 && (
        <div className="px-3 py-2 border-b border-[var(--border-soft)] flex items-center gap-1 flex-wrap">
          <span className="text-[10px] uppercase tracking-wider text-[var(--text-faint)] mr-1">Вставити:</span>
          {tokens.map((tok) => (
            <button
              key={tok}
              className="px-1.5 py-0.5 text-[10.5px] font-mono rounded border border-[var(--border-soft)] bg-[var(--bg)] text-[var(--accent)] hover:bg-[var(--accent)]/10 hover:border-[var(--accent)]/40"
              onClick={() => insertToken(tok)}
              title={`Вставити ${tok} у позицію курсора`}
            >
              {tok}
            </button>
          ))}
        </div>
      )}

      {(tagDiff.missing.length > 0 || tagDiff.extra.length > 0) && (
        <div className="px-3 py-1.5 border-b border-[var(--border-soft)] bg-[var(--danger)]/8 text-[10.5px] flex flex-wrap gap-2">
          {tagDiff.missing.length > 0 && <span className="text-[var(--danger)]">✗ Не вистачає: <span className="font-mono">{tagDiff.missing.join(", ")}</span></span>}
          {tagDiff.extra.length > 0 && <span className="text-[var(--warning)]">+ Зайве: <span className="font-mono">{tagDiff.extra.join(", ")}</span></span>}
        </div>
      )}

      <div className="flex-1 min-h-0">
        <Editor
          height="100%"
          language="dp-text"
          theme="dp1-dark"
          defaultValue={row.done.Text ?? ""}
          onMount={handleMount}
          onChange={(v) => {
            if (skipNextChangeRef.current) { skipNextChangeRef.current = false; return; }
            onChange(v ?? "");
          }}
          options={{
            minimap: { enabled: false },
            fontSize: monacoFontSize,
            lineHeight: Math.round(monacoFontSize * 1.55),
            lineNumbers: "off",
            wordWrap: "on",
            // У тексті жодних пробілів — не вставляємо їх віртуально
            // при переносі (інакше {NEXT_SEGMENT} на новому рядку
            // виглядає так, ніби перед ним є табуляція).
            wrappingIndent: "none",
            scrollBeyondLastLine: false,
            renderLineHighlight: "none",
            padding: { top: 8, bottom: 8 },
          }}
        />
      </div>

      <div className="px-3 py-1.5 border-t border-[var(--border-soft)] text-[10.5px] text-[var(--text-faint)] flex items-center justify-between gap-2">
        <span className="flex items-center gap-2">
          UA
          <MonacoFontSizeControl />
        </span>
        <span className="tabular-nums">
          {(row.done.Text ?? "").length} симв. · EN {(row.original.Text ?? "").length} симв.
        </span>
      </div>
    </>
  );
}
