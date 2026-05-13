import { useEffect, useMemo, useRef, useState } from "react";
import Editor, { type OnMount } from "@monaco-editor/react";
import { useDp1Store, dp1Key } from "./store";
import { dp1Stats, isDp1Translated, bracesBalanced } from "./parser";
import { useT } from "../../lib/i18n";
import { LangToggle } from "../../components/LangToggle";
import { TmPanel } from "../../components/TmPanel";
import { GlossaryModal } from "../../components/GlossaryModal";
import { MetricsBadge } from "../../components/MetricsBadge";
import { ColResizer } from "../../components/ColResizer";
import { WrapToggle, type WrapMode } from "../../components/WrapToggle";
import { useLocalStorage } from "../../lib/useLocalStorage";
import { readGlossary, type GlossaryEntry } from "../../lib/glossary";

interface Dp1ColWidths {
  num: number;
  id: number;
  original: number;
  ua: number;
  status: number;
}
const DP1_DEFAULT_COL_WIDTHS: Dp1ColWidths = {
  num: 60,
  id: 80,
  original: 380,
  ua: 380,
  status: 40,
};
import type { StatusKind } from "../../lib/status";
import {
  DP_TOKEN_RULES,
  diffTags,
  extractTags,
  registerDpTextLanguage,
  setTagDiagnostics,
} from "../../lib/monacoLang";

interface Dp1EditorProps {
  onHome: () => void;
  onOpenSettings: () => void;
}

const TOKEN_INSERTS = [
  "{NEXT_SEGMENT}",
  "{NEXT_FRAME id=0, letters=0}",
  "{NO_OP:0xFFF5}",
  "{ICON id=0}",
];

function shortPath(p: string | null): string {
  if (!p) return "—";
  const parts = p.split(/[\\/]/);
  return parts.slice(-2).join("/");
}

export function Dp1Editor({ onHome, onOpenSettings }: Dp1EditorProps) {
  const t = useT();
  const init = useDp1Store((s) => s.init);
  const engPath = useDp1Store((s) => s.engPath);
  const entries = useDp1Store((s) => s.entries);
  const activeIndex = useDp1Store((s) => s.activeIndex);
  const setActive = useDp1Store((s) => s.setActive);
  const search = useDp1Store((s) => s.search);
  const setSearch = useDp1Store((s) => s.setSearch);
  const filter = useDp1Store((s) => s.filter);
  const setFilter = useDp1Store((s) => s.setFilter);
  const updateActive = useDp1Store((s) => s.updateActive);
  const saveWorkfile = useDp1Store((s) => s.saveWorkfile);
  const saveDone = useDp1Store((s) => s.saveDone);
  const step = useDp1Store((s) => s.step);
  const jumpNext = useDp1Store((s) => s.jumpToNextUntranslated);
  const copyOrig = useDp1Store((s) => s.copyOriginalToTranslation);
  const dirty = useDp1Store((s) => s.dirty);
  const loading = useDp1Store((s) => s.loading);
  const error = useDp1Store((s) => s.error);
  const loadEng = useDp1Store((s) => s.loadEng);
  const statuses = useDp1Store((s) => s.statuses);
  const toggleBookmark = useDp1Store((s) => s.toggleEntryBookmark);
  const bulkSetStatus = useDp1Store((s) => s.bulkSetStatus);
  const bulkCopy = useDp1Store((s) => s.bulkCopyOriginalToTranslation);
  const bulkTrim = useDp1Store((s) => s.bulkTrim);
  const exportTxt = useDp1Store((s) => s.exportTxt);
  const importTxtContent = useDp1Store((s) => s.importTxtContent);

  async function handleExportTxt() {
    const r = exportTxt();
    if (!r) return;
    const dest = await window.dp2.pickSaveFile({
      title: t("txt.exportTitle"),
      defaultPath: r.fileName + ".txt",
      filters: [{ name: "Text", extensions: ["txt"] }],
    });
    if (!dest) return;
    await window.dp2.writeFile(dest, r.content);
    alert(t("txt.exported", { path: dest }));
  }

  async function handleImportTxt() {
    const src = await window.dp2.pickFile({
      title: t("txt.importTitle"),
      filters: [{ name: "Text", extensions: ["txt"] }],
    });
    if (!src) return;
    const txt = await window.dp2.readFile(src);
    const { applied, missing } = importTxtContent(txt);
    alert(t("txt.imported", { applied, missing }));
  }

  const [packState, setPackState] = useState<"idle" | "packing" | "done" | "error">("idle");
  const [packMsg, setPackMsg] = useState("");
  const [selection, setSelection] = useState<Set<number>>(new Set());
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; index: number } | null>(null);
  const [colWidths, setColWidths] = useLocalStorage<Dp1ColWidths>("dp1.ui.tableCols", DP1_DEFAULT_COL_WIDTHS);
  const setCol = (k: keyof Dp1ColWidths) => (w: number) => setColWidths({ ...colWidths, [k]: w });
  const [wrapMode, setWrapMode] = useLocalStorage<WrapMode>("dp1.ui.tableWrap", "default");
  const wrapCls =
    wrapMode === "wrap" ? "whitespace-pre-wrap break-words"
    : wrapMode === "clip" ? "line-clamp-1 whitespace-pre-wrap break-words"
    : "line-clamp-2 whitespace-pre-wrap break-words";

  // Глосарій + TM-панель для DP1 (опційно).
  const [glossary, setGlossary] = useState<GlossaryEntry[]>([]);
  const [glossaryOpen, setGlossaryOpen] = useState(false);
  const [dp2Folder, setDp2Folder] = useState<string | null>(null);
  const saveTick = useDp1Store((s) => s.saveTick);

  useEffect(() => {
    // Глосарій лежить у теці dp2 (єдиний для обох ігор), якщо вона задана.
    window.dp2.getSettings().then(async (s) => {
      const folder = (s as any).lastFolder as string | undefined;
      setDp2Folder(folder ?? null);
      if (folder) {
        const g = await readGlossary(folder);
        setGlossary(g);
      }
    });
  }, []);

  const editorRef = useRef<any>(null);

  useEffect(() => { init(); }, [init]);

  // Якщо ще не завантажено — пропонуємо вибрати файл.
  async function pickEng() {
    const f = await window.dp2.pickFile({
      title: "Виберіть eng.json (DP1)",
      filters: [{ name: "JSON", extensions: ["json"] }],
    });
    if (f) await loadEng(f);
  }

  // Мапа entry.index → positional index у `entries` (для O(1) lookup у row click).
  // Без цього кожен ряд викликає findIndex → O(n^2) на render таблиці.
  const positionalByRecordIndex = useMemo(() => {
    const m = new Map<number, number>();
    for (let i = 0; i < entries.length; i++) m.set(entries[i].index, i);
    return m;
  }, [entries]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return entries.filter((e) => {
      if (e.empty) return false;
      const st = statuses.entries[dp1Key(e.index)];
      if (filter === "translated" && !isDp1Translated(e)) return false;
      if (filter === "untranslated" && isDp1Translated(e)) return false;
      if (filter === "draft" && st?.status !== "draft") return false;
      if (filter === "review" && st?.status !== "review") return false;
      if (filter === "approved" && st?.status !== "approved") return false;
      if (filter === "bookmarks" && !st?.bookmark) return false;
      if (!q) return true;
      return (
        e.original.toLowerCase().includes(q) ||
        e.ua.toLowerCase().includes(q) ||
        e.id.includes(q)
      );
    });
  }, [entries, search, filter, statuses]);

  const active = activeIndex !== null ? entries[activeIndex] : null;
  const stats = useMemo(() => dp1Stats(entries), [entries]);

  // Закрити контекстне меню
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

  // Шорткати статусів / закладок (поза інпутами).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const ctrl = e.ctrlKey || e.metaKey;
      const target = e.target as HTMLElement;
      const inEditable =
        target.closest("input, textarea, .monaco-editor, [contenteditable]") !== null;
      if (inEditable) return;
      if (activeIndex === null) return;
      const indices = selection.size > 0 ? Array.from(selection) : [activeIndex];
      if (ctrl && !e.shiftKey && e.key.toLowerCase() === "b") {
        e.preventDefault();
        toggleBookmark(entries[activeIndex].index);
        return;
      }
      if ((e.altKey || ctrl) && !e.shiftKey && (e.key === "1" || e.key === "2" || e.key === "3")) {
        e.preventDefault();
        const map: Record<string, StatusKind> = { "1": "draft", "2": "review", "3": "approved" };
        const realIndices = indices.map((i) => entries[i]?.index).filter((i): i is number => typeof i === "number");
        bulkSetStatus(realIndices, map[e.key]);
        return;
      }
      if ((e.altKey || ctrl) && !e.shiftKey && e.key === "0") {
        e.preventDefault();
        const realIndices = indices.map((i) => entries[i]?.index).filter((i): i is number => typeof i === "number");
        bulkSetStatus(realIndices, undefined);
        return;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [activeIndex, selection, entries, toggleBookmark, bulkSetStatus]);

  // Глобальні шорткати редагування — як у DP2 редакторі.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const ctrl = e.ctrlKey || e.metaKey;
      const k = e.key;
      if (ctrl && !e.shiftKey && k.toLowerCase() === "s") {
        e.preventDefault(); e.stopPropagation();
        saveWorkfile();
        return;
      }
      if (ctrl && !e.shiftKey && k === "Enter") {
        e.preventDefault(); e.stopPropagation();
        (async () => {
          await saveWorkfile();
          jumpNext();
        })();
        return;
      }
      if (ctrl && !e.shiftKey && k.toLowerCase() === "j") {
        e.preventDefault(); e.stopPropagation();
        jumpNext();
        return;
      }
      if (ctrl && !e.shiftKey && k.toLowerCase() === "d") {
        e.preventDefault(); e.stopPropagation();
        copyOrig();
        return;
      }
      if (e.altKey && !ctrl && !e.shiftKey && (k === "ArrowUp" || k === "ArrowDown")) {
        e.preventDefault(); e.stopPropagation();
        step(k === "ArrowDown" ? 1 : -1);
        return;
      }
    };
    window.addEventListener("keydown", onKey, { capture: true });
    return () => window.removeEventListener("keydown", onKey, { capture: true } as any);
  }, [saveWorkfile, jumpNext, step, copyOrig]);

  // Автоскрол активного рядка у таблиці
  const activeRowRef = useRef<HTMLTableRowElement | null>(null);
  useEffect(() => {
    activeRowRef.current?.scrollIntoView({ block: "nearest", behavior: "auto" });
  }, [activeIndex]);

  const handleMount: OnMount = (editor, monaco) => {
    editorRef.current = editor;
    registerDpTextLanguage(monaco);
    monaco.editor.defineTheme("dp2-dark", {
      base: "vs-dark", inherit: true, rules: DP_TOKEN_RULES,
      colors: {
        "editor.background": "#0d1117",
        "editor.foreground": "#c9d1d9",
        "editor.lineHighlightBackground": "#161b22",
        "editor.lineHighlightBorder": "#161b22",
      },
    });
    monaco.editor.setTheme("dp2-dark");
    editor.focus();
    if (active) setTagDiagnostics(monaco, editor, active.original, active.ua);
    editor.onDidChangeModelContent(() => {
      if (active) setTagDiagnostics(monaco, editor, active.original, editor.getValue());
    });
  };

  async function runPack() {
    if (!engPath) return;
    setPackState("packing");
    setPackMsg("Зберігаю прогрес і експортую _ua_done.json...");
    try {
      const donePath = await saveDone();
      if (!donePath) throw new Error("Не вдалося зберегти _ua_done.json");
      setPackMsg("Підставляю гліфи і викликаю DPMsgTool...");
      const res = await window.dp2.dp1Pack({ donePath });
      if (res.error) throw new Error(res.error);
      setPackState("done");
      setPackMsg(`Готово → ${res.outputPath}`);
      setTimeout(() => setPackState("idle"), 12000);
    } catch (e: any) {
      setPackState("error");
      setPackMsg(String(e?.message ?? e));
      setTimeout(() => setPackState("idle"), 12000);
    }
  }

  function insertToken(token: string) {
    if (!active) return;
    const ed = editorRef.current;
    if (ed && ed.executeEdits) {
      const sel = ed.getSelection();
      ed.executeEdits("insert-token", [{ range: sel, text: token, forceMoveMarkers: true }]);
      ed.focus();
    } else {
      updateActive((active.ua || "") + token);
    }
  }

  // Якщо файл ще не відкритий — show empty-state з кнопкою вибору.
  if (!engPath) {
    return (
      <div className="flex-1 flex flex-col bg-[var(--bg)]">
        <header className="h-12 px-4 border-b border-[var(--border-soft)] bg-[var(--bg-surface)] flex items-center gap-3">
          <button className="dp-btn dp-btn--ghost" onClick={onHome} title={t("header.home")}>
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M10 19l-7-7m0 0l7-7m-7 7h18" />
            </svg>
          </button>
          <span className="text-[13px] text-[var(--text-muted)]">{t("dp1.brand")}</span>
          <div className="flex-1" />
          <LangToggle compact />
        </header>
        <div className="flex-1 flex items-center justify-center p-8">
          <div className="max-w-[520px] text-center">
            <h2 className="text-[18px] font-bold text-[var(--text-strong)] mb-2">{t("dp1.empty.title")}</h2>
            <p className="text-[13px] text-[var(--text-muted)] mb-4 leading-relaxed">{t("dp1.empty.hint")}</p>
            <button className="dp-btn dp-btn--primary" onClick={pickEng}>{t("dp1.empty.pickBtn")}</button>
            {error && (
              <p className="mt-3 text-[12px] text-[var(--danger)] whitespace-pre-wrap">{error}</p>
            )}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col bg-[var(--bg)] min-w-0">
      {/* Header */}
      <header className="h-12 px-4 border-b border-[var(--border-soft)] bg-[var(--bg-surface)] flex items-center gap-3">
        <button className="dp-btn dp-btn--ghost" onClick={onHome} title={t("header.home")}>
          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M10 19l-7-7m0 0l7-7m-7 7h18" />
          </svg>
        </button>
        <span className="text-[13px] text-[var(--text-muted)]">{t("dp1.brand")}</span>

        <div className="flex items-center gap-2 text-[12px] text-[var(--text-faint)] ml-3 min-w-0">
          <span className="font-mono truncate" title={engPath}>{shortPath(engPath)}</span>
        </div>

        <div className="flex-1" />

        {packState !== "idle" && (
          <span
            className={`text-[11px] font-mono px-2.5 py-1 rounded ${
              packState === "error" ? "dp-pill--danger"
              : packState === "done" ? "dp-pill--success"
              : "dp-pill"
            }`}
          >
            {packMsg}
          </span>
        )}

        <LangToggle compact />
        <button className="dp-btn dp-btn--ghost" onClick={onOpenSettings} title={t("dp1.set.title")}>
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
            <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
          </svg>
        </button>
        <button className="dp-btn" onClick={pickEng}>{t("btn.open")}</button>
        <button
          className="dp-btn"
          disabled={!dirty}
          onClick={() => saveWorkfile()}
          title="Ctrl+S"
        >
          {dirty ? t("header.save") : t("header.saved")}
        </button>
        <button
          className="dp-btn dp-btn--success"
          disabled={packState === "packing"}
          onClick={runPack}
          title={t("dp1.pack")}
        >
          {t("dp1.pack")}
        </button>
      </header>

      <div className="flex-1 flex min-h-0">
        {/* Таблиця — Original / Ukrainian */}
        <section className="flex-1 flex flex-col min-w-0 min-h-0 border-r border-[var(--border-soft)]">
          <div className="h-12 border-b border-[var(--border-soft)] flex items-center gap-2 px-3">
            <input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t("dp1.search.placeholder")}
              className="dp-input flex-1 max-w-md"
            />
            <div className="flex gap-1 ml-2 flex-wrap">
              {[
                { v: "all", label: t("table.filter.all", { n: entries.length }) },
                { v: "untranslated", label: t("table.filter.untranslated") },
                { v: "translated", label: t("table.filter.translated") },
                { v: "draft", label: t("status.draft") },
                { v: "review", label: t("status.review") },
                { v: "approved", label: t("status.approved") },
                { v: "bookmarks", label: t("status.bookmarks") },
              ].map((opt) => (
                <button
                  key={opt.v}
                  onClick={() => setFilter(opt.v as any)}
                  className={`dp-btn ${filter === opt.v ? "dp-btn--primary" : ""}`}
                >
                  {opt.label}
                </button>
              ))}
            </div>

            <button className="dp-btn dp-btn--ghost" onClick={handleExportTxt} title={t("txt.export")}>
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M9 5h-3a2 2 0 00-2 2v12a2 2 0 002 2h12a2 2 0 002-2v-3" />
                <path strokeLinecap="round" strokeLinejoin="round" d="M16 3l5 5m0 0v-5m0 5h-5M9 14l11-11" />
              </svg>
              {t("txt.export")}
            </button>
            <button className="dp-btn dp-btn--ghost" onClick={handleImportTxt} title={t("txt.import")}>
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M15 5h3a2 2 0 012 2v12a2 2 0 01-2 2H6a2 2 0 01-2-2V7a2 2 0 012-2h3" />
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 3v12m0 0l-4-4m4 4l4-4" />
              </svg>
              {t("txt.import")}
            </button>

            <WrapToggle value={wrapMode} onChange={setWrapMode} />
          </div>

          <div className="flex-1 overflow-auto">
            {loading ? (
              <p className="py-10 text-center text-[13px] text-[var(--text-muted)]">{t("app.loading")}</p>
            ) : (
              <table
                className="text-[12.5px] table-fixed"
                style={{ width: colWidths.num + colWidths.id + colWidths.original + colWidths.ua + colWidths.status }}
              >
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
                      {t("dp1.col.num")}
                      <ColResizer width={colWidths.num} onChange={setCol("num")} min={40} />
                    </th>
                    <th className="text-left px-2 py-1.5 relative select-none">
                      {t("dp1.col.id")}
                      <ColResizer width={colWidths.id} onChange={setCol("id")} min={48} />
                    </th>
                    <th className="text-left px-2 py-1.5 relative select-none">
                      {t("dp1.col.original")}
                      <ColResizer width={colWidths.original} onChange={setCol("original")} min={80} />
                    </th>
                    <th className="text-left px-2 py-1.5 relative select-none">
                      {t("dp1.col.ua")}
                      <ColResizer width={colWidths.ua} onChange={setCol("ua")} min={80} />
                    </th>
                    <th className="relative select-none">
                      <ColResizer width={colWidths.status} onChange={setCol("status")} min={32} max={120} />
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((e) => {
                    const positionalIndex = positionalByRecordIndex.get(e.index) ?? -1;
                    const isActive = activeIndex !== null && entries[activeIndex]?.index === e.index;
                    const isSelected = selection.has(positionalIndex);
                    const trans = isDp1Translated(e);
                    const st = statuses.entries[dp1Key(e.index)];
                    return (
                      <tr
                        key={e.index}
                        ref={isActive ? activeRowRef : undefined}
                        onClick={(ev) => {
                          const i = positionalIndex;
                          if (ev.shiftKey && activeIndex !== null) {
                            const a = Math.min(activeIndex, i);
                            const b = Math.max(activeIndex, i);
                            const next = new Set(selection);
                            for (let k = a; k <= b; k++) next.add(k);
                            setSelection(next);
                          } else if (ev.ctrlKey || ev.metaKey) {
                            const next = new Set(selection);
                            if (next.has(i)) next.delete(i); else next.add(i);
                            setSelection(next);
                          } else {
                            setSelection(new Set([i]));
                          }
                          setActive(i);
                        }}
                        onContextMenu={(ev) => {
                          ev.preventDefault();
                          if (!selection.has(positionalIndex)) setSelection(new Set([positionalIndex]));
                          setCtxMenu({ x: ev.clientX, y: ev.clientY, index: positionalIndex });
                        }}
                        className={`cursor-pointer border-b border-[var(--border-soft)] transition-colors ${
                          isActive ? "bg-[var(--row-active)]"
                          : isSelected ? "bg-[var(--accent-soft)]"
                          : "hover:bg-[var(--row-hover)]"
                        }`}
                      >
                        <td className="px-2 py-1.5 text-[var(--text-faint)] tabular-nums text-[11px] align-top">
                          {e.index + 1}
                        </td>
                        <td className="px-2 py-1.5 align-top font-mono text-[11px] text-[var(--text-muted)]">
                          {e.id}
                        </td>
                        <td className="px-2 py-1.5 align-top text-[var(--text-muted)]">
                          <p className={`leading-snug ${wrapCls}`}>
                            {e.original || <span className="italic text-[var(--text-faint)]">—</span>}
                          </p>
                        </td>
                        <td className="px-2 py-1.5 align-top text-[var(--text)]">
                          <p className={`leading-snug ${wrapCls}`}>
                            {e.ua || <span className="italic text-[var(--text-faint)]">—</span>}
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
                                : trans ? "bg-[var(--success)]/60"
                                : "bg-[var(--text-faint)]/40"
                              }`}
                              title={
                                st?.status ? t("status." + st.status)
                                : trans ? t("status.translated") : t("status.untranslated")
                              }
                            />
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>

          {ctxMenu && (
            <div
              className="fixed z-50 dp-card py-1 text-[12px] min-w-[220px]"
              style={{ left: ctxMenu.x, top: ctxMenu.y }}
              onMouseDown={(e) => e.stopPropagation()}
            >
              {(() => {
                const positional = selection.size > 0 ? Array.from(selection) : [ctxMenu.index];
                const realIndices = positional.map((i) => entries[i]?.index).filter((i): i is number => typeof i === "number");
                const close = () => setCtxMenu(null);
                const items: Array<{ label: string; action: () => void } | { divider: true }> = [
                  { label: t("status.markDraft") + (realIndices.length > 1 ? ` (${realIndices.length})` : ""),
                    action: () => { bulkSetStatus(realIndices, "draft"); close(); } },
                  { label: t("status.markReview") + (realIndices.length > 1 ? ` (${realIndices.length})` : ""),
                    action: () => { bulkSetStatus(realIndices, "review"); close(); } },
                  { label: t("status.markApproved") + (realIndices.length > 1 ? ` (${realIndices.length})` : ""),
                    action: () => { bulkSetStatus(realIndices, "approved"); close(); } },
                  { label: t("status.clear"), action: () => { bulkSetStatus(realIndices, undefined); close(); } },
                  { divider: true },
                  { label: t("status.toggleBookmark"),
                    action: () => { if (entries[ctxMenu.index]) toggleBookmark(entries[ctxMenu.index].index); close(); } },
                  { divider: true },
                  { label: t("bulk.copyOriginal") + (positional.length > 1 ? ` (${positional.length})` : ""),
                    action: () => { bulkCopy(positional); close(); } },
                  { label: t("bulk.trim") + (positional.length > 1 ? ` (${positional.length})` : ""),
                    action: () => { bulkTrim(positional); close(); } },
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

          <div className="h-7 px-3 border-t border-[var(--border-soft)] flex items-center gap-x-4 text-[11px] text-[var(--text-faint)] tabular-nums whitespace-nowrap overflow-x-auto">
            <span>
              {t("table.stat.rows")}: <span className="text-[var(--text)] font-semibold">{stats.totalLines}</span>
            </span>
            <span>
              {t("dp1.col.ua")}:{" "}
              <span className="text-[var(--success)] font-semibold">{stats.uaLines}</span>{" "}
              ({stats.uaPercent.toFixed(2).replace(".", ",")}%)
            </span>
            <span>
              {t("table.stat.words")}: <span className="text-[var(--text)] font-semibold">{stats.uaWords}</span>
              {" / "}
              <span className="text-[var(--text)] font-semibold">{stats.enWords}</span>
            </span>
            {activeIndex !== null && (
              <span>
                {t("table.stat.position")}:{" "}
                <span className="text-[var(--text)] font-semibold">
                  {activeIndex + 1}/{entries.length}
                </span>
              </span>
            )}
            {selection.size > 0 && (
              <span>
                {t("status.selected")}: <span className="text-[var(--accent)] font-semibold">{selection.size}</span>
              </span>
            )}
            <span className="ml-auto"><MetricsBadge /></span>
            <span>· {filtered.length} {t("table.stat.shown")}</span>
          </div>
        </section>

        {/* Редактор */}
        <aside className="w-[540px] shrink-0 flex flex-col bg-[var(--bg-surface)]">
          {!active ? (
            <div className="flex-1 flex items-center justify-center p-8 text-center">
              <p className="text-[13px] text-[var(--text-muted)]">{t("tm.empty.pick")}</p>
            </div>
          ) : (
            <>
              <div className="px-4 py-3 border-b border-[var(--border-soft)]">
                <p className="text-[11px] font-semibold uppercase tracking-wider text-[var(--text-muted)] mb-1">
                  {t("dp1.record", { n: active.index + 1 })}
                </p>
                <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] font-mono text-[var(--text-faint)]">
                  <span>id: <span className="text-[var(--text-muted)]">{active.id}</span></span>
                  <span>{t("dp1.flags")}: <span className="text-[var(--text-muted)]">{active.flags}</span></span>
                </div>
              </div>

              <div className="px-4 py-2.5 border-b border-[var(--border-soft)] bg-[var(--bg)]">
                <div className="flex items-center justify-between mb-1">
                  <span className="text-[10px] font-semibold uppercase tracking-wider text-[var(--text-faint)]">
                    {t("dp1.en.label")}
                  </span>
                  <button
                    className="text-[10px] uppercase tracking-wider text-[var(--accent)] hover:underline"
                    onClick={() => navigator.clipboard.writeText(active.original)}
                  >
                    {t("btn.copy")}
                  </button>
                </div>
                <p className="text-[13px] text-[var(--text-muted)] leading-relaxed whitespace-pre-wrap font-mono">
                  {active.original}
                </p>
              </div>

              {(() => {
                const tags = extractTags(active.original);
                if (tags.length === 0) return null;
                const { missing, extra } = diffTags(active.original, active.ua);
                return (
                  <div className="px-4 py-2 border-b border-[var(--border-soft)] bg-[var(--bg)]">
                    <div className="flex items-center justify-between mb-1">
                      <span className="text-[10px] font-semibold uppercase tracking-wider text-[var(--text-faint)]">
                        {t("editor.tags.label")}
                      </span>
                      {(missing.length > 0 || extra.length > 0) && (
                        <span className="text-[10px] text-[var(--warning)]">
                          {missing.length > 0 && t("editor.tags.missing", { n: missing.length })}
                          {missing.length > 0 && extra.length > 0 && " · "}
                          {extra.length > 0 && t("editor.tags.extra", { n: extra.length })}
                        </span>
                      )}
                    </div>
                    <div className="flex flex-wrap gap-1">
                      {tags.map((tag, i) => {
                        const isMissing = missing.includes(tag);
                        return (
                          <span
                            key={i}
                            className={`text-[10px] font-mono px-1.5 py-0.5 rounded border ${
                              isMissing
                                ? "border-[var(--warning)] text-[var(--warning)] bg-[var(--warning)]/10"
                                : "border-[var(--border-soft)] text-[var(--text-muted)] bg-[var(--bg-elevated)]"
                            }`}
                          >
                            {tag}
                          </span>
                        );
                      })}
                    </div>
                  </div>
                );
              })()}

              <div className="px-4 py-2 border-b border-[var(--border-soft)] flex items-center gap-2 flex-wrap">
                <span className="text-[10px] uppercase tracking-wider text-[var(--text-faint)]">
                  {t("dp1.insertToken")}
                </span>
                {TOKEN_INSERTS.map((tok) => (
                  <button
                    key={tok}
                    onClick={() => insertToken(tok)}
                    className="text-[10px] font-mono px-2 py-0.5 rounded border border-[var(--border-soft)] hover:border-[var(--accent)] text-[var(--text-muted)]"
                  >
                    {tok}
                  </button>
                ))}
                {!bracesBalanced(active.ua) && (
                  <span className="ml-auto text-[10px] text-[var(--danger)]">{t("dp1.bracesWarn")}</span>
                )}
              </div>

              <div className="flex-1 flex flex-col min-h-0">
                <div className="px-4 pt-2 pb-1 flex items-center justify-between shrink-0">
                  <label className="text-[10px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
                    {t("dp1.ua.label")}
                  </label>
                  <span className="text-[10px] text-[var(--text-faint)] tabular-nums">
                    {active.ua.length} {t("dp1.chars")}
                  </span>
                </div>
                <div className="flex-1 min-h-0 mx-3 mb-3 border border-[var(--border)] rounded-md overflow-hidden">
                  <Editor
                    key={`dp1::${active.index}`}
                    defaultValue={active.ua}
                    onChange={(v) => updateActive(v ?? "")}
                    language="dp-text"
                    theme="dp2-dark"
                    onMount={handleMount}
                    options={{
                      fontFamily: '"JetBrains Mono", ui-monospace, monospace',
                      fontSize: 13,
                      lineHeight: 20,
                      wordWrap: "on",
                      minimap: { enabled: false },
                      lineNumbers: "on",
                      folding: false,
                      scrollBeyondLastLine: false,
                      padding: { top: 10, bottom: 10 },
                      tabSize: 2,
                    }}
                  />
                </div>
              </div>

              <div className="px-4 py-2 border-t border-[var(--border-soft)] flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-[var(--text-faint)]">
                <span className="dp-kbd">Ctrl+Enter</span>
                <span>{t("editor.kbd.saveNext")}</span>
                <span className="dp-kbd">Ctrl+J</span>
                <span>{t("editor.kbd.nextUntranslated")}</span>
                <span className="dp-kbd">Alt+↑/↓</span>
                <span>{t("editor.kbd.between")}</span>
                <span className="dp-kbd">Ctrl+D</span>
                <span>{t("editor.kbd.copyOriginal")}</span>
                <span className="dp-kbd">Ctrl+S</span>
                <span>{t("editor.kbd.save")}</span>
              </div>
            </>
          )}
        </aside>

        {/* TM-панель з кросс-корпусом DP1↔DP2. */}
        {active && (
          <div className="w-[300px] shrink-0">
            <TmPanel
              glossary={glossary}
              onOpenGlossary={() => setGlossaryOpen(true)}
              query={active.original}
              excludeTgt={active.ua}
              dp2Folder={dp2Folder}
              dp1EngPath={engPath}
              refreshKey={saveTick}
              onApply={(tgt) => updateActive(tgt)}
            />
          </div>
        )}
      </div>
      <GlossaryModal
        open={glossaryOpen}
        folder={dp2Folder}
        onClose={(saved) => {
          setGlossaryOpen(false);
          if (saved) setGlossary(saved);
        }}
      />
    </div>
  );
}
