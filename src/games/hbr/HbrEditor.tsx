import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useT } from "../../lib/i18n";
import { alert as showAlert } from "../../lib/dialogs";
import { applyCombinedToParsed, applyHbrEdits, formatHbrCombinedTxt, isHbrItemTranslatedByParser, isHbrSystemRow, parseHbrCombinedTxt, parseHbrJson, validatePlaceholders, type HbrParsedFile, type HbrTextItem } from "./parser";
import { EditorFooter } from "../../components/EditorFooter";
import { LangToggle } from "../../components/LangToggle";
import { confirm as showConfirm } from "../../lib/dialogs";
import hbrHero from "../../ui-v2/assets/hbr-hero.jpg";
import { HbrItemEditor } from "./HbrItemEditor";
import { CorpusStatsModal } from "../../components/CorpusStatsModal";
import type { CorpusStats } from "../../lib/ipc";
import { readStatusFile, writeStatusFile, pruneEntry, type StatusFile, type StatusKind } from "../../lib/status";
import { HbrFindReplaceModal } from "./HbrFindReplaceModal";
import { showError, showOk } from "../../components/Toast";
import { useLocalStorage } from "../../lib/useLocalStorage";
import { HighlightedText } from "../../components/HighlightedText";
import { HeaderProgress } from "../../components/HeaderProgress";
import { HeaderMenu, type MenuItem } from "../../components/HeaderMenu";
import { CommandPalette, type CommandItem } from "../../components/CommandPalette";
import { HbrShortcutsModal } from "./HbrShortcutsModal";
import { HbrFileSidebar } from "./HbrFileSidebar";
import { HbrMigrateDiffModal, type MigrateDiffEntry } from "./HbrMigrateDiffModal";
import { buildTranslationMemory, type TranslationMemory } from "./HbrTranslationMemory";
import { GlossaryModal } from "../../components/GlossaryModal";

// HbrRow — top-level memo. Раніше рядок жив inline у `filteredItems.map` і
// перерендеровувався на кожному keystroke по всьому списку (1000+ DOM-вузлів).
// Тепер при оновленні одного рядка React міняє reference тільки для змінено-
// го `it`, інші HbrRow пропускають render через memo-порівняння пропсів.
interface HbrRowProps {
  it: HbrTextItem;
  realIdx: number;
  active: boolean;
  // Статус і закладка з sidecar — додатковий візуал поверх default border.
  status?: "draft" | "review" | "approved";
  bookmark?: boolean;
  /** Manual override через ПКМ → «Позначити перекладеним». Border = зелений. */
  markedTranslated?: boolean;
  onSelect: (realIdx: number) => void;
  onContextMenu: (e: React.MouseEvent, realIdx: number) => void;
}
const HbrRow = memo(function HbrRow({ it, realIdx, active, status, bookmark, markedTranslated, onSelect, onContextMenu }: HbrRowProps) {
  const isSystem = isHbrSystemRow(it.original);
  const isSame = it.current === it.original;
  const isEmpty = !it.current || it.current.trim().length === 0;
  // System-row (тільки теги/прочерки) рахуємо як «перекладений» автоматично.
  // markedTranslated (manual ПКМ-toggle) теж — для рядків типу ":)" які
  // не потребують реальної правки.
  const isTranslated = isSystem || markedTranslated || (!isSame && !isEmpty);
  // Border підсвічує лише ПРОБЛЕМНІ або ЯВНО-ПОМІЧЕНІ рядки.
  const borderClass = status === "approved"
    ? "border-l-[3px] border-l-[var(--success)]"
    : status === "review"
      ? "border-l-[3px] border-l-[var(--accent)]"
      : status === "draft"
        ? "border-l-[3px] border-l-dashed border-l-[var(--warning,#d97706)]"
        : markedTranslated
          ? "border-l-2 border-l-[var(--success)]"
          : isEmpty
            ? "border-l-2 border-l-[var(--danger)]"
            : !isTranslated
              ? "border-l-2 border-l-[var(--warning,#d97706)]"
              : "border-l-2 border-l-transparent";
  return (
    <tr
      data-hbr-row={`${it.textId}::${it.variantIdx}`}
      className={`border-b border-[var(--border-soft)] align-top cursor-pointer ${borderClass} ${
        active ? "bg-[var(--accent)]/15" : "hover:bg-[var(--row-hover)]"
      }`}
      // CSS-level virtualization: для off-screen рядків браузер skip-ує
      // layout+paint, а contain-intrinsic-size резервує висоту, щоб скрол
      // не стрибав. ~5000 рядків HBR-файлу — 2-3x швидше за прямий render.
      style={{
        contentVisibility: "auto",
        containIntrinsicSize: "auto 32px",
      }}
      onClick={() => onSelect(realIdx)}
      onContextMenu={(e) => onContextMenu(e, realIdx)}
    >
      <td className="px-2 py-1 font-mono text-[11px] text-[var(--text-muted)]">
        {bookmark && <span className="mr-1 text-[var(--accent)]" title="bookmark">🔖</span>}
        {it.textId}
      </td>
      <td className="px-2 py-1 font-mono text-[11px] text-[var(--text-faint)] tabular-nums">{it.variantIdx}</td>
      <td className="px-2 py-1 text-[var(--text-muted)] whitespace-pre-wrap break-words">
        <HighlightedText text={it.original} />
      </td>
      <td className="px-2 py-1 whitespace-pre-wrap break-words text-[var(--text-muted)]">
        <HighlightedText text={it.current} />
      </td>
    </tr>
  );
});

interface Props {
  onHome: () => void;
}

interface PrepStatus {
  ok?: boolean;
  bundlePath?: string | null;
  originalDir?: string;
  doneDir?: string;
  originalCount?: number;
  doneCount?: number;
  error?: string;
}

interface FileItem {
  file: string;
  donePath: string;
  origPath: string;
  size: number;
}

type Phase = "init" | "preparing" | "ready" | "error";
type StepStatus = "pending" | "running" | "done" | "skipped";
interface StepStates {
  tool: StepStatus;
  catalog: StepStatus;
  extract: StepStatus;
  mirror: StepStatus;
}
// Очікувана кількість файлів _EN у bundle HBR (для відображення відсотка).
const EXPECTED_HBR_FILES = 61;

interface ToolProgress {
  phase: "download" | "done" | "error";
  i18nKey?: string;
  i18nParams?: Record<string, string | number>;
  message?: string;
  total?: number;
  downloaded?: number;
  percent?: number;
  bytesPerSec?: number;
}

function humanBytes(n?: number): string {
  if (!n || n <= 0) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function PrepStep({
  index, status, title, subtitle, children,
}: {
  index: number;
  status: StepStatus;
  title: string;
  subtitle: string;
  children?: ReactNode;
}) {
  const isRunning = status === "running";
  const isDone = status === "done" || status === "skipped";
  const isPending = status === "pending";
  const borderCls = isRunning
    ? "border-[var(--accent)]/60 bg-[var(--accent)]/5"
    : isDone
      ? "border-[var(--border-soft)] bg-[var(--bg-surface)]/40"
      : "border-[var(--border-soft)] bg-[var(--bg-surface)]/20";
  const titleCls = isPending
    ? "text-[var(--text-faint)]"
    : isRunning
      ? "text-[var(--text-strong)]"
      : "text-[var(--text)]";
  return (
    <li className={`rounded-lg border px-4 py-3 transition-colors ${borderCls}`}>
      <div className="flex items-start gap-3">
        <span
          className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[12px] font-semibold mt-[1px] ${
            isDone
              ? "bg-[var(--success)]/15 text-[var(--success)] border border-[var(--success)]/40"
              : isRunning
                ? "bg-[var(--accent)]/15 text-[var(--accent)] border border-[var(--accent)]/40"
                : "bg-[var(--bg-elevated)] text-[var(--text-faint)] border border-[var(--border-soft)]"
          }`}
        >
          {isDone ? "✓" : isRunning ? (
            <span className="inline-block h-3 w-3 rounded-full border-2 border-current border-t-transparent animate-spin" />
          ) : index}
        </span>
        <div className="flex-1 min-w-0">
          <p className={`text-[13px] font-semibold leading-snug ${titleCls}`}>{title}</p>
          <p className="text-[11.5px] text-[var(--text-muted)] leading-snug mt-0.5">{subtitle}</p>
          {children && <div className="mt-2">{children}</div>}
        </div>
      </div>
    </li>
  );
}

function ProgressBlock({
  label, percent, downloaded, total, bps, speedLabel,
}: {
  label: string;
  percent: number | null;
  downloaded?: number;
  total?: number;
  bps?: number;
  speedLabel: (v: string) => string;
}) {
  const pct = percent != null ? Math.max(0, Math.min(100, percent)) : null;
  return (
    <div>
      <div className="flex items-baseline justify-between mb-1.5 gap-2">
        <span className="text-[11.5px] text-[var(--text)] truncate">{label}</span>
        {total ? (
          <span className="text-[10.5px] tabular-nums text-[var(--text-muted)] shrink-0">
            {humanBytes(downloaded)} / {humanBytes(total)}
            {pct != null && ` · ${pct}%`}
          </span>
        ) : pct != null ? (
          <span className="text-[10.5px] tabular-nums text-[var(--text-muted)] shrink-0">{pct}%</span>
        ) : null}
      </div>
      <div className="h-1 rounded-full bg-[var(--bg-elevated)] overflow-hidden">
        <div
          className="h-full bg-[var(--accent)] transition-all"
          style={{ width: pct != null ? `${pct}%` : "0%" }}
        />
      </div>
      {bps != null && bps > 0 && (
        <p className="mt-1 text-[10.5px] tabular-nums text-[var(--text-faint)]">
          {speedLabel(humanBytes(bps))}
        </p>
      )}
    </div>
  );
}

function ExtractProgress({
  count, total, lastLine,
}: {
  count: number;
  total: number;
  lastLine?: string;
}) {
  const pct = total > 0 ? Math.min(100, Math.round((count / total) * 100)) : null;
  // Last file name з рядка [EXPORTED] <name>_EN (PathID …) → … .json
  let lastName = "";
  if (lastLine) {
    const m = lastLine.match(/\[EXPORTED\]\s+([^\s(]+)/);
    if (m) lastName = m[1];
  }
  return (
    <div>
      <div className="flex items-baseline justify-between mb-1.5 gap-2">
        <span className="text-[11.5px] text-[var(--text)] tabular-nums">
          {count} / ~{total}
          {pct != null && ` · ${pct}%`}
        </span>
        {lastName && (
          <span className="text-[10.5px] text-[var(--text-faint)] font-mono truncate shrink min-w-0" title={lastName}>
            {lastName}
          </span>
        )}
      </div>
      <div className="h-1 rounded-full bg-[var(--bg-elevated)] overflow-hidden">
        <div
          className="h-full bg-[var(--accent)] transition-all"
          style={{ width: pct != null ? `${pct}%` : "0%" }}
        />
      </div>
    </div>
  );
}

export function HbrEditor({ onHome }: Props) {
  const t = useT();
  const [phase, setPhase] = useState<Phase>("init");
  const [status, setStatus] = useState<PrepStatus | null>(null);
  const [files, setFiles] = useState<FileItem[]>([]);
  const [activeFile, setActiveFile] = useState<FileItem | null>(null);
  const [parsed, setParsed] = useState<HbrParsedFile | null>(null);
  const [dirty, setDirty] = useState(false);
  // Patch-міграція: bundle на диску має новий hash → пропонуємо перемігрувати,
  // зберігши переклади. Заповнюється на mount через hbrPatchMigrateCheck.
  const [migrateInfo, setMigrateInfo] = useState<{
    needed: boolean; newBundle: string; oldBundle: string; metaItemsCount: number; doneCount: number;
  } | null>(null);
  const [migrating, setMigrating] = useState(false);
  const [search, setSearch] = useState("");
  // `search` оновлюється з debounce 150мс — інакше на 5000-рядкових файлах
  // кожне натискання клавіші triger'ить filter+ререндер всієї таблиці
  // і ввід «лагає». Власне поле input живе в `searchDraft` — миттєво
  // друкує, дебаунс лише накочує реальний фільтр.
  const [searchDraft, setSearchDraft] = useState("");
  useEffect(() => {
    if (searchDraft === search) return;
    const id = setTimeout(() => setSearch(searchDraft), 150);
    return () => clearTimeout(id);
  }, [searchDraft, search]);
  const [progressLines, setProgressLines] = useState<string[]>([]);
  const [extractedCount, setExtractedCount] = useState(0);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [toolProgress, setToolProgress] = useState<ToolProgress | null>(null);
  const [steps, setSteps] = useState<StepStates>({
    tool: "pending", catalog: "pending", extract: "pending", mirror: "pending",
  });
  const setStep = (k: keyof StepStates, v: StepStatus) =>
    setSteps((s) => ({ ...s, [k]: v }));
  const [saving, setSaving] = useState(false);
  // parserKeys: множина "<textId>::<variantIdx>" — рядків, які ПАРСЕР уже
  // зараховує як translated (system-row або cur≠orig & non-empty). Тримаємо
  // окремо від `translated` числа, щоб у markedTranslatedByFile віднімати
  // overlap і уникати double-count'у (issue: progress >100% або застряглий
  // лічильник, бо ПКМ-mark і парсер ловили той самий рядок двічі).
  const [fileStats, setFileStats] = useState<Record<string, { total: number; translated: number; parserKeys: Set<string> }>>({});
  // Фільтри для рядків — як у DP2 («не перекл / перекл / збігаються»).
  type RowFilter = "all" | "untranslated" | "translated" | "samesAsOriginal";
  const [rowFilter, setRowFilter] = useState<RowFilter>("all");
  // ПКМ-меню над рядком АБО файлом.
  type CtxRow = { kind: "row"; x: number; y: number; itemIndex: number };
  type CtxFile = { kind: "file"; x: number; y: number; file: FileItem };
  const [ctxMenu, setCtxMenu] = useState<CtxRow | CtxFile | null>(null);
  // Якщо встановлено — при відкритті файлу скролимо до цього рядка
  // (використовується глобальним пошуком). Має бути ОГОЛОШЕНО ПЕРЕД
  // useEffect нижче, інакше TDZ під час mount.
  const [pendingScrollTextId, setPendingScrollTextId] = useState<{ textId: string; variantIdx: number } | null>(null);
  // Індекс активного рядка в `parsed.items` — для Monaco-редактора у правому
  // sidebar (DP2-style). null = редактор сховано, працюємо лише з таблицею.
  const [activeItemIndex, setActiveItemIndex] = useState<number | null>(null);
  const [statsOpen, setStatsOpen] = useState(false);
  // Sidecar `Documents\…\HBR\Text\Done\.hbr-status.json` зберігає статуси
  // (draft/review/approved) і закладки для рядків. Ключ — стабільний:
  // `<filename>::<textId>::<variantIdx>`. Sidecar не зачіпає ігрові JSON.
  const [statusFile, setStatusFile] = useState<StatusFile>({ version: 1, entries: {} });
  const statusPathRef = useRef<string | null>(null);
  const statusKey = useCallback((fileName: string, textId: string, variantIdx: number) =>
    `${fileName}::${textId}::${variantIdx}`, []);
  // Гарна модалка результату Pack (замінює простий showAlert).
  const [packSuccess, setPackSuccess] = useState<null | {
    applied: number;
    failed: number;
    totalFields: number;
    bundlePath?: string;
    bundleSize?: number;
    bakPath?: string;
    logPath?: string;
    failedRows?: Array<{ name: string; reason: string }>;
  }>(null);
  // Модалка результату «Імпорт TXT»: показує скільки додано, загальну
  // готовність проєкту та конкретні файли (з кількістю оновлених записів).
  const [importDone, setImportDone] = useState<null | {
    records: number;
    files: Array<{ name: string; updated: number }>;
    errors: string[];
    overall: { translated: number; total: number };
  }>(null);
  const [findReplaceOpen, setFindReplaceOpen] = useState(false);
  // UX-state: командна палітра + cheatsheet + collapse Monaco + diff модалка.
  const [cmdOpen, setCmdOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [monacoCollapsed, setMonacoCollapsed] = useLocalStorage<boolean>("hbr.ui.monacoCollapsed", false);
  const [diffOpen, setDiffOpen] = useState(false);
  const [diffEntries, setDiffEntries] = useState<MigrateDiffEntry[]>([]);
  // TM кешуємо у state — будується після кожної зміни parsed/files (debounced).
  const [tm, setTm] = useState<TranslationMemory>(new Map());
  // Glossary (термінологічний словник) — інтегруємо ту саму модалку, що й
  // у DP2. Шлях до файлу — Done/.glossary.json через doneDir статусу.
  const [glossaryOpen, setGlossaryOpen] = useState(false);
  useEffect(() => {
    if (!ctxMenu) return;
    const close = () => setCtxMenu(null);
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") close(); };
    window.addEventListener("click", close);
    window.addEventListener("keydown", onKey);
    return () => { window.removeEventListener("click", close); window.removeEventListener("keydown", onKey); };
  }, [ctxMenu]);

  async function restoreFileFromOriginal(f: FileItem) {
    const ok = await showConfirm(
      t("hbr.ctx.restoreFileTitle"),
      t("hbr.ctx.restoreFileBody", { file: f.file }),
      { tone: "danger", okLabel: t("hbr.ctx.restoreOriginal") }
    );
    if (!ok) return;
    try {
      const w = window.dp2 as unknown as {
        hbrTextRead: (p: string) => Promise<{ ok: boolean; raw?: string; error?: string }>;
        hbrTextWrite: (p: { fullPath: string; raw: string }) => Promise<{ ok: boolean; error?: string }>;
      };
      const r = await w.hbrTextRead(f.origPath);
      if (!r.ok || !r.raw) throw new Error(r.error || "read fail");
      const wr = await w.hbrTextWrite({ fullPath: f.donePath, raw: r.raw });
      if (!wr.ok) throw new Error(wr.error || "write fail");
      // Якщо файл відкритий — перевантажуємо.
      if (activeFile?.donePath === f.donePath) {
        setParsed(parseHbrJson(r.raw, r.raw, f.donePath, f.origPath));
        setDirty(false);
      }
      await refreshProjectStats();
    } catch (e: unknown) {
      await showAlert(t("hbr.editor.saveErrTitle"), String((e as Error)?.message ?? e), { tone: "danger" });
    }
  }

  // Restore Done/<file>.json from its .bak (created on first save).
  async function restoreFileFromBak(f: FileItem) {
    const ok = await showConfirm(
      t("hbr.ctx.restoreBakTitle"),
      t("hbr.ctx.restoreBakBody", { file: f.file }),
      { tone: "danger", okLabel: t("hbr.ctx.restoreFromBak") }
    );
    if (!ok) return;
    try {
      const w = window.dp2 as unknown as {
        hbrTextRestoreBak: (p: string) => Promise<{ ok: boolean; raw?: string; error?: string }>;
      };
      const r = await w.hbrTextRestoreBak(f.donePath);
      if (!r.ok) {
        if (r.error === "no-bak") {
          await showAlert(t("hbr.ctx.restoreBakMissingTitle"), t("hbr.ctx.restoreBakMissingBody", { file: f.file }), { tone: "warning" });
          return;
        }
        throw new Error(r.error || "restore fail");
      }
      const raw = r.raw || "";
      if (activeFile?.donePath === f.donePath) {
        // Original залишається з оригіналу диску, переклад — з .bak.
        const orig = window.dp2 as unknown as { hbrTextRead: (p: string) => Promise<{ ok: boolean; raw?: string }> };
        const o = await orig.hbrTextRead(f.origPath);
        const origRaw = o.ok && o.raw ? o.raw : raw;
        setParsed(parseHbrJson(raw, origRaw, f.donePath, f.origPath));
        setDirty(false);
      }
      await refreshProjectStats();
    } catch (e: unknown) {
      await showAlert(t("hbr.editor.saveErrTitle"), String((e as Error)?.message ?? e), { tone: "danger" });
    }
  }
  const triedRef = useRef(false);

  // Status-sidecar: завантажуємо при ready (через hbrTextPrepStatus → doneDir).
  useEffect(() => {
    if (phase !== "ready") return;
    let cancelled = false;
    (async () => {
      try {
        const s = await window.dp2.hbrTextPrepStatus();
        if (cancelled) return;
        if (!s.doneDir) return;
        const sidecar = s.doneDir.replace(/[\\/]$/, "") + (s.doneDir.includes("\\") ? "\\" : "/") + ".hbr-status.json";
        statusPathRef.current = sidecar;
        const f = await readStatusFile(sidecar);
        if (!cancelled) setStatusFile(f);
      } catch { /* silent */ }
    })();
    return () => { cancelled = true; };
  }, [phase]);

  // Debounced save sidecar — 500мс після останньої зміни.
  useEffect(() => {
    if (!statusPathRef.current) return;
    const id = setTimeout(() => {
      const path = statusPathRef.current;
      if (!path) return;
      writeStatusFile(path, statusFile).catch(() => {});
    }, 500);
    return () => clearTimeout(id);
  }, [statusFile]);

  // Helpers — оновлюємо запис в map. Якщо в результаті він порожній,
  // pruneEntry викидає його (щоб sidecar не пухнув).
  function setRowStatus(realIdx: number, status: StatusKind | undefined) {
    if (!parsed || !activeFile) return;
    const it = parsed.items[realIdx];
    if (!it) return;
    const key = statusKey(activeFile.file, it.textId, it.variantIdx);
    setStatusFile((f) => {
      const cur = f.entries[key] ?? {};
      const next: StatusFile = { ...f, entries: { ...f.entries, [key]: { ...cur, status } } };
      return pruneEntry(next, key);
    });
  }
  function toggleRowBookmark(realIdx: number) {
    if (!parsed || !activeFile) return;
    const it = parsed.items[realIdx];
    if (!it) return;
    const key = statusKey(activeFile.file, it.textId, it.variantIdx);
    setStatusFile((f) => {
      const cur = f.entries[key] ?? {};
      const next: StatusFile = { ...f, entries: { ...f.entries, [key]: { ...cur, bookmark: cur.bookmark ? undefined : true } } };
      return pruneEntry(next, key);
    });
  }
  function toggleRowMarkedTranslated(realIdx: number) {
    if (!parsed || !activeFile) return;
    const it = parsed.items[realIdx];
    if (!it) return;
    const key = statusKey(activeFile.file, it.textId, it.variantIdx);
    setStatusFile((f) => {
      const cur = f.entries[key] ?? {};
      const nextEntry = { ...cur, markedTranslated: cur.markedTranslated ? undefined : true } as typeof cur;
      const next: StatusFile = { ...f, entries: { ...f.entries, [key]: nextEntry } };
      return pruneEntry(next, key);
    });
  }

  // Bulk-операція: позначити/зняти markedTranslated для УСІХ рядків файлу.
  // Викликається з ПКМ-меню файлу у sidebar. Читає Done-JSON (або Original
  // fallback), парсить через parseHbrJson, генерує statusKey для кожного
  // item і одним setStatusFile пише патч.
  async function bulkMarkFileTranslated(file: FileItem, mark: boolean) {
    try {
      const w = window.dp2 as unknown as {
        hbrTextRead: (p: string) => Promise<{ ok: boolean; raw?: string; error?: string }>;
      };
      const sourcePath = file.donePath;
      const r = await w.hbrTextRead(sourcePath);
      if (!r.ok || !r.raw) {
        const o = await w.hbrTextRead(file.origPath);
        if (!o.ok || !o.raw) {
          showError("Не вдалося прочитати файл", "Bulk-mark");
          return;
        }
        r.raw = o.raw;
      }
      const origRes = await w.hbrTextRead(file.origPath);
      const p = parseHbrJson(r.raw, origRes.ok ? origRes.raw! : null, file.donePath, file.origPath);
      const keys = p.items.map((it) => statusKey(file.file, it.textId, it.variantIdx));
      if (keys.length === 0) {
        showError("У файлі нема рядків для позначення", "Bulk-mark");
        return;
      }
      setStatusFile((f) => {
        let next = { ...f, entries: { ...f.entries } };
        for (const k of keys) {
          const cur = next.entries[k] ?? {};
          const merged = { ...cur, markedTranslated: mark ? true : undefined } as typeof cur;
          next.entries[k] = merged;
          next = pruneEntry(next, k);
        }
        return next;
      });
      showOk(
        mark
          ? `Позначено ${keys.length} рядків як перекладені`
          : `Знято позначку з ${keys.length} рядків`,
        file.file,
      );
    } catch (e) {
      showError(e, "Bulk-mark failed");
    }
  }

  // Live прогрес.
  useEffect(() => {
    const w = window.dp2 as unknown as { onHbrTextPrepProgress?: (cb: (l: string) => void) => () => void };
    if (!w.onHbrTextPrepProgress) return;
    const off = w.onHbrTextPrepProgress((line) => {
      setProgressLines((p) => [...p.slice(-200), line]);
      if (/^\[EXPORTED\]/.test(line)) setExtractedCount((n) => n + 1);
    });
    return () => { if (typeof off === "function") off(); };
  }, []);

  // Прогрес завантаження CatalogTool.exe.
  useEffect(() => {
    const w = window.dp2 as unknown as { onHbrToolsProgress?: (cb: (p: ToolProgress) => void) => () => void };
    if (!w.onHbrToolsProgress) return;
    const off = w.onHbrToolsProgress((p) => setToolProgress(p));
    return () => { if (typeof off === "function") off(); };
  }, []);

  // Скрол до рядка з global-search hit після того, як файл парситься.
  useEffect(() => {
    if (!parsed || !pendingScrollTextId) return;
    const sel = `[data-hbr-row="${CSS.escape(pendingScrollTextId.textId)}::${pendingScrollTextId.variantIdx}"]`;
    const tryScroll = () => {
      const el = document.querySelector(sel) as HTMLElement | null;
      if (el) {
        el.scrollIntoView({ block: "center", behavior: "smooth" });
        el.style.outline = "2px solid var(--accent)";
        setTimeout(() => { el.style.outline = ""; }, 1600);
        setPendingScrollTextId(null);
      }
    };
    // Чекаємо тік щоб React відрендерив <tbody>.
    const id = setTimeout(tryScroll, 50);
    return () => clearTimeout(id);
  }, [parsed, pendingScrollTextId]);

  // Прогрес паку у гру — той же файл-лог + live.
  useEffect(() => {
    const w = window.dp2 as unknown as { onHbrPackProgress?: (cb: (l: string) => void) => () => void };
    if (!w.onHbrPackProgress) return;
    const off = w.onHbrPackProgress((line) => setPackLog((p) => [...p.slice(-300), line]));
    return () => { if (typeof off === "function") off(); };
  }, []);

  async function reExtractFromGame() {
    const ok = await showConfirm(
      t("hbr.reextract.title"),
      t("hbr.reextract.body"),
      { tone: "danger", okLabel: t("hbr.reextract.ok") }
    );
    if (!ok) return;
    try {
      // Видаляємо meta — статус повернеться у "ні original'у", це примусить
      // повторний extract + mirror, без видалення Done/ (там переклади).
      const w = window.dp2 as unknown as {
        hbrOpenFolder?: (which: string) => Promise<{ ok: boolean; path?: string }>;
        hbrTextPrepExtract: () => Promise<{ ok: boolean; error?: string }>;
        hbrTextPrepMirror: (p: { overwrite?: boolean }) => Promise<{ ok: boolean; error?: string }>;
      };
      setPhase("preparing");
      setStep("tool", "skipped");
      setStep("catalog", "skipped");
      setStep("extract", "running");
      setExtractedCount(0);
      setProgressLines([]);
      const r = await w.hbrTextPrepExtract();
      if (!r.ok) { setErrorMsg(r.error || "extract fail"); setPhase("error"); return; }
      setStep("extract", "done");
      setStep("mirror", "running");
      const mr = await w.hbrTextPrepMirror({ overwrite: false });
      if (!mr.ok) { setErrorMsg(mr.error || "mirror fail"); setPhase("error"); return; }
      setStep("mirror", "done");
      await refreshFiles();
      setPhase("ready");
    } catch (e: unknown) {
      setErrorMsg(String((e as Error)?.message ?? e));
      setPhase("error");
    }
  }

  async function refreshFiles() {
    const w = window.dp2 as unknown as { hbrTextList: () => Promise<{ ok: boolean; items: FileItem[] }> };
    const r = await w.hbrTextList();
    if (!r.ok) return;
    // Подвійний захист: відсіюємо dot-файли (`.hbr-status.json`,
    // `.preimport.bak.json` тощо), якщо їх не відсіяв main-process.
    setFiles(r.items.filter((it) => !it.file.startsWith(".")));
  }

  async function runFlow() {
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    try {
      const w = window.dp2 as unknown as {
        hbrTextPrepStatus: () => Promise<PrepStatus>;
        hbrTextPrepExtract: () => Promise<{ ok: boolean; error?: string }>;
        hbrTextPrepMirror: (p: { overwrite?: boolean }) => Promise<{ ok: boolean; error?: string }>;
        hbrToolsStatus: () => Promise<{ ok: boolean; present: boolean; path: string }>;
        hbrToolsDownload: () => Promise<{ ok: boolean; error?: string; path?: string }>;
        hbrCatalogStatus: () => Promise<{ ok: boolean; hasCatalog?: boolean; hasOld?: boolean; error?: string }>;
        hbrCatalogPatch: () => Promise<{ ok: boolean; alreadyPatched?: boolean; error?: string }>;
      };
      // Status-перевірка перед будь-яким UI — якщо ВСЕ вже зроблено
      // (originalCount > 0 і doneCount = originalCount), одразу відкриваємо
      // редактор, без блимання майстра з трьома галочками.
      let s = await w.hbrTextPrepStatus();
      setStatus(s);
      if (!s.ok) { setErrorMsg(s.error || "status fail"); setPhase("error"); return; }
      const fullyReady =
        !!s.originalCount && (s.doneCount ?? 0) >= (s.originalCount ?? 0);
      if (fullyReady) {
        setSteps({ tool: "skipped", catalog: "skipped", extract: "skipped", mirror: "skipped" });
        await refreshFiles();
        setPhase("ready");
        return;
      }

      setPhase("preparing");

      // Якщо текст уже витягнуто, але Done не повний (рідкісний випадок) —
      // переходимо одразу на крок mirror.
      if (s.originalCount) {
        setSteps({
          tool: "skipped", catalog: "skipped",
          extract: "skipped",
          mirror: "pending",
        });
      } else {
        // Step 1 — CatalogTool.exe.
        setStep("tool", "running");
        const ts = await w.hbrToolsStatus();
        if (!ts.ok) { setErrorMsg("tool status fail"); setPhase("error"); return; }
        if (ts.present) {
          await sleep(700);
          setStep("tool", "skipped");
        } else {
          const dl = await w.hbrToolsDownload();
          if (!dl.ok) { setErrorMsg(dl.error || "tool download fail"); setPhase("error"); return; }
          await sleep(400);
          setStep("tool", "done");
        }

        // Step 2 — catalog.json patch.
        setStep("catalog", "running");
        const cs = await w.hbrCatalogStatus();
        if (!cs.ok) { setErrorMsg(cs.error || "catalog status fail"); setPhase("error"); return; }
        if (cs.hasOld) {
          await sleep(700);
          setStep("catalog", "skipped");
        } else {
          const cp = await w.hbrCatalogPatch();
          if (!cp.ok) { setErrorMsg(cp.error || "catalog patch fail"); setPhase("error"); return; }
          await sleep(400);
          setStep("catalog", cp.alreadyPatched ? "skipped" : "done");
        }

        // Step 3 — extract text.
        setStep("extract", "running");
        const r = await w.hbrTextPrepExtract();
        if (!r.ok) { setErrorMsg(r.error || "extract fail"); setPhase("error"); return; }
        setStep("extract", "done");
        s = await w.hbrTextPrepStatus(); setStatus(s);
      }

      // Mirror — fast, тримаємо у фоні, але показуємо як крок.
      if (!s.doneCount || (s.doneCount ?? 0) < (s.originalCount ?? 0)) {
        setStep("mirror", "running");
        const r = await w.hbrTextPrepMirror({ overwrite: false });
        if (!r.ok) { setErrorMsg(r.error || "mirror fail"); setPhase("error"); return; }
        setStep("mirror", "done");
      } else if (steps.mirror !== "skipped") {
        setStep("mirror", "skipped");
      }

      await refreshFiles();
      await sleep(400);
      setPhase("ready");
    } catch (e: unknown) {
      setErrorMsg(String((e as Error)?.message ?? e));
      setPhase("error");
    }
  }

  useEffect(() => {
    if (triedRef.current) return;
    triedRef.current = true;
    runFlow();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function openFile(f: FileItem) {
    // Авто-save при перемиканні файлу: якщо буфер dirty — тихо записуємо.
    // Раніше показувався showAlert, що дратував; тепер тихо. АЛЕ якщо save
    // справді впав (IPC error, диск повний) — кидаємо toast, інакше
    // користувач думає що збереглось, а воно ні.
    if (dirty && activeFile && parsed) {
      try { await saveActive(); }
      catch (e) {
        showError(e instanceof Error ? e.message : String(e), `Не вдалося зберегти ${activeFile.file} перед переключенням`);
      }
    }
    setActiveFile(f);
    setParsed(null);
    setDirty(false);
    setActiveItemIndex(null);
    try {
      const w = window.dp2 as unknown as { hbrTextRead: (p: string) => Promise<{ ok: boolean; raw?: string; error?: string }> };
      const doneRes = await w.hbrTextRead(f.donePath);
      if (!doneRes.ok || !doneRes.raw) throw new Error(doneRes.error || "read fail");
      const origRes = await w.hbrTextRead(f.origPath);

      // Crash-recovery: чи є autosave-чернетка свіжіша за Done? Якщо так —
      // питаємо у користувача чи відновити з неї. На «Викинути» autosave
      // видаляється, щоб prompt не повертався.
      let rawForParse = doneRes.raw;
      try {
        const auto = await window.dp2.readAutosave(f.donePath);
        if (auto && auto.content && auto.autosaveMtime > auto.originalMtime + 500) {
          const fmt = new Date(auto.autosaveMtime).toLocaleString();
          const recover = await showConfirm(
            t("hbr.recover.title"),
            t("hbr.recover.body", { file: f.file, at: fmt }),
            { okLabel: t("hbr.recover.restore"), cancelLabel: t("hbr.recover.discard") },
          );
          if (recover) {
            rawForParse = auto.content;
            setDirty(true);
          } else {
            await window.dp2.deleteAutosave(f.donePath);
          }
        }
      } catch { /* silent */ }

      const p = parseHbrJson(rawForParse, origRes.ok ? origRes.raw! : null, f.donePath, f.origPath);
      setParsed(p);
      // DP2-parity: одразу робимо активним перший рядок, щоб HbrItemEditor
      // показав редактор без додаткового кліку. pendingScrollTextId
      // (глобальний пошук) має пріоритет — обробляється в окремому useEffect.
      if (p.items.length > 0 && !pendingScrollTextId) {
        setActiveItemIndex(0);
      }
    } catch (e: unknown) {
      await showAlert(t("hbr.editor.readErrTitle"), String((e as Error)?.message ?? e), { tone: "danger" });
    }
  }

  function patchItem(idx: number, text: string) {
    if (!parsed) return;
    const items = parsed.items.slice();
    items[idx] = { ...items[idx], current: text };
    setParsed({ ...parsed, items });
    setDirty(true);
  }

  async function saveActive() {
    if (!parsed || !activeFile || saving) return;
    setSaving(true);
    try {
      const w = window.dp2 as unknown as {
        hbrTextRead: (p: string) => Promise<{ ok: boolean; raw?: string; error?: string }>;
        hbrTextWrite: (p: { fullPath: string; raw: string }) => Promise<{ ok: boolean; error?: string }>;
      };
      const r = await w.hbrTextRead(activeFile.donePath);
      if (!r.ok || !r.raw) throw new Error(r.error || "read fail");
      const newRaw = applyHbrEdits(r.raw, parsed.items);
      const wr = await w.hbrTextWrite({ fullPath: activeFile.donePath, raw: newRaw });
      if (!wr.ok) throw new Error(wr.error || "write fail");
      // Успішний save → прибираємо autosave-чернетку, щоб recovery-prompt
      // не з'явився при наступному відкритті.
      try { await window.dp2.deleteAutosave(activeFile.donePath); } catch {}
      setDirty(false);
    } catch (e: unknown) {
      await showAlert(t("hbr.editor.saveErrTitle"), String((e as Error)?.message ?? e), { tone: "danger" });
    } finally {
      setSaving(false);
    }
  }

  // Debounce-інтервал autosave у мс. Зчитується з settings.autosaveIntervalMin
  // (default 1 хв, мін 0.25 хв = 15 с). Оновлюється на mount + при переході
  // у новий файл, тож можна змінити "на льоту" з App Settings.
  const [autosaveMs, setAutosaveMs] = useState(60_000);
  useEffect(() => {
    let cancelled = false;
    window.dp2.getSettings().then((s) => {
      if (cancelled) return;
      const min = (s as { autosaveIntervalMin?: number }).autosaveIntervalMin;
      const clamped = typeof min === "number" && isFinite(min) ? Math.max(0.25, Math.min(60, min)) : 1;
      setAutosaveMs(Math.round(clamped * 60_000));
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [activeFile]);

  // Debounced autosave — пишемо raw-JSON поточного `parsed` у autosave-файл
  // (sidecar або у вказану директорію — main.cjs сам обирає). Якщо процес
  // впаде до явного Save — openFile запропонує відновити чернетку.
  useEffect(() => {
    if (!dirty || !parsed || !activeFile) return;
    const id = setTimeout(async () => {
      try {
        const w = window.dp2 as unknown as {
          hbrTextRead: (p: string) => Promise<{ ok: boolean; raw?: string }>;
        };
        const r = await w.hbrTextRead(activeFile.donePath);
        if (!r.ok || !r.raw) return;
        const draft = applyHbrEdits(r.raw, parsed.items);
        await window.dp2.writeAutosave(activeFile.donePath, draft);
      } catch { /* silent — autosave не має блокувати UI */ }
    }, autosaveMs);
    return () => clearTimeout(id);
  }, [parsed, dirty, activeFile, autosaveMs]);

  // Знайти наступний неперекладений рядок у `parsed.items`, починаючи з
  // (from+1). isTranslated = (current !== original) AND (current.trim() !== "").
  // Якщо немає — повертає null, тоді нічого не міняємо.
  function findNextUntranslated(from: number | null): number | null {
    if (!parsed) return null;
    const start = (from ?? -1) + 1;
    for (let i = start; i < parsed.items.length; i++) {
      const it = parsed.items[i];
      // System-row (тільки теги/прочерк) пропускаємо — там нема чого перекладати.
      if (isHbrSystemRow(it.original)) continue;
      // Пропускаємо рядки, помічені вручну як «перекладено» (ПКМ → toggle).
      if (activeFile) {
        const sk = statusKey(activeFile.file, it.textId, it.variantIdx);
        if (statusFile.entries[sk]?.markedTranslated) continue;
      }
      const isSame = it.current === it.original;
      const isEmpty = !it.current || it.current.trim().length === 0;
      if (isSame || isEmpty) return i;
    }
    return null;
  }

  // Auto-save при перемиканні активного рядка. Зберігає буфер ДО зміни.
  // Тримаємо в ref попередній індекс, аби засейвити саме його стан.
  const prevActiveIndexRef = useRef<number | null>(null);
  useEffect(() => {
    const prev = prevActiveIndexRef.current;
    if (prev !== null && prev !== activeItemIndex && dirty && parsed && activeFile && !saving) {
      saveActive();
    }
    prevActiveIndexRef.current = activeItemIndex;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeItemIndex]);

  // Глобальні шорткати редактора (DP2-парітет):
  //  Ctrl+S        — save active file
  //  Ctrl+Enter    — save + jump to next untranslated
  //  Ctrl+J        — jump to next untranslated (без save)
  //  Ctrl+D        — copy original → translation
  //  Alt+↑/↓       — попередній/наступний рядок
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const ctrl = e.ctrlKey || e.metaKey;
      const k = e.key;
      const target = e.target as HTMLElement | null;
      const inMonaco = !!target?.closest(".monaco-editor");
      const inInput = !!target?.closest("input, textarea");
      // Ctrl+K — командна палітра (універсальна для всіх редакторів проєкту).
      if (ctrl && !e.shiftKey && !e.altKey && k.toLowerCase() === "k") {
        e.preventDefault();
        setCmdOpen(true);
        return;
      }
      // ? — cheatsheet (поза інпутом).
      if (!ctrl && !e.shiftKey && !e.altKey && k === "?" && !inMonaco && !inInput) {
        e.preventDefault();
        setShortcutsOpen(true);
        return;
      }
      // Цифри 0-3 у фокусі таблиці — швидке встановлення status.
      if (!ctrl && !e.shiftKey && !e.altKey && !inMonaco && !inInput && activeItemIndex !== null && activeFile && parsed) {
        const map: Record<string, "draft" | "review" | "approved" | undefined> = {
          "1": "draft", "2": "review", "3": "approved", "0": undefined,
        };
        if (k in map) {
          e.preventDefault();
          setRowStatus(activeItemIndex, map[k]);
          return;
        }
      }
      if (ctrl && !e.shiftKey && !e.altKey && k.toLowerCase() === "s") {
        e.preventDefault();
        saveActive();
        return;
      }
      if (ctrl && !e.shiftKey && !e.altKey && k === "Enter") {
        e.preventDefault();
        (async () => {
          await saveActive();
          const next = findNextUntranslated(activeItemIndex);
          if (next !== null) setActiveItemIndex(next);
        })();
        return;
      }
      if (ctrl && !e.shiftKey && !e.altKey && k.toLowerCase() === "j") {
        e.preventDefault();
        const next = findNextUntranslated(activeItemIndex);
        if (next !== null) setActiveItemIndex(next);
        return;
      }
      if (ctrl && !e.shiftKey && !e.altKey && k.toLowerCase() === "d") {
        e.preventDefault();
        if (parsed && activeItemIndex !== null) {
          const it = parsed.items[activeItemIndex];
          patchItem(activeItemIndex, it.original);
        }
        return;
      }
      if (ctrl && !e.shiftKey && !e.altKey && k.toLowerCase() === "h") {
        e.preventDefault();
        if (parsed && parsed.items.length > 0) setFindReplaceOpen(true);
        return;
      }
      if (ctrl && !e.shiftKey && !e.altKey && k.toLowerCase() === "b") {
        e.preventDefault();
        if (activeItemIndex !== null) toggleRowBookmark(activeItemIndex);
        return;
      }
      if (e.altKey && !ctrl && !e.shiftKey && (k === "ArrowUp" || k === "ArrowDown")) {
        e.preventDefault();
        if (parsed && activeItemIndex !== null) {
          const delta = k === "ArrowDown" ? 1 : -1;
          const target = activeItemIndex + delta;
          if (target >= 0 && target < parsed.items.length) setActiveItemIndex(target);
        }
        return;
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [parsed, activeFile, saving, activeItemIndex]);

  // Загальні лічильники по всьому проекту (Done vs Original).
  const [projectStats, setProjectStats] = useState<{ files: number; total: number; translated: number } | null>(null);
  // Per-file count рядків з прапором markedTranslated (manual override через
  // ПКМ → «Позначити перекладеним»). Додаємо це до projectStats/fileStats у
  // відображенні — щоб поточний % одразу враховував мітку без heavy IPC.
  //
  // КРИТИЧНО: рахуємо лише ті позначки, КЛЮЧ ЯКИХ ще НЕ зарахований парсером
  // (fileStats[…].parserKeys). Раніше додавали всі marked → double-count:
  // ПКМ-mark + реальний переклад того ж рядка давали 33/32 (103%) або
  // навпаки лічильник застрягав на 99% при фактичних 100%.
  const markedTranslatedByFile = useMemo(() => {
    const m = new Map<string, number>();
    for (const [key, entry] of Object.entries(statusFile.entries)) {
      if (!entry.markedTranslated) continue;
      // statusKey: "<fileName>::<textId>::<variantIdx>" — fileName до 1-го "::",
      // решта — itemKey, який порівнюємо з parserKeys (формат той самий).
      const sep = key.indexOf("::");
      if (sep < 0) continue;
      const fileName = key.slice(0, sep);
      const itemKey = key.slice(sep + 2);
      const parserKeys = fileStats[fileName]?.parserKeys;
      if (parserKeys && parserKeys.has(itemKey)) continue; // overlap → skip
      m.set(fileName, (m.get(fileName) ?? 0) + 1);
    }
    return m;
  }, [statusFile, fileStats]);
  const totalMarkedTranslated = useMemo(() => {
    let n = 0;
    for (const v of markedTranslatedByFile.values()) n += v;
    return n;
  }, [markedTranslatedByFile]);
  const [packLog, setPackLog] = useState<string[]>([]);
  const [packing, setPacking] = useState(false);
  const [packMenuOpen, setPackMenuOpen] = useState(false);
  // Глобальний пошук по всіх Done/*.json файлах.
  const [globalQuery, setGlobalQuery] = useState("");
  const [globalSearching, setGlobalSearching] = useState(false);
  interface GlobalHit { file: FileItem; textId: string; variantIdx: number; snippet: string; }
  const [globalHits, setGlobalHits] = useState<GlobalHit[] | null>(null);
  async function refreshProjectStats() {
    if (!files.length) { setProjectStats(null); setFileStats({}); return; }
    const w = window.dp2 as unknown as { hbrTextRead: (p: string) => Promise<{ ok: boolean; raw?: string }> };
    // Раніше: послідовно 61 файл × 2 read = 122 sequential IPC. Тепер обидва
    // read'и для одного файлу робимо в Promise.all, а самі файли — теж
    // паралельно. Це ~10× швидше відкриття проєкту і pack'у.
    const perFile: Record<string, { total: number; translated: number; parserKeys: Set<string> }> = {};
    const results = await Promise.all(files.map(async (f) => {
      try {
        const [doneRes, origRes] = await Promise.all([
          w.hbrTextRead(f.donePath),
          w.hbrTextRead(f.origPath),
        ]);
        if (!doneRes.ok || !doneRes.raw) return null;
        const p = parseHbrJson(doneRes.raw, origRes.ok ? origRes.raw! : null, f.donePath, f.origPath);
        const parserKeys = new Set<string>();
        for (const it of p.items) {
          if (isHbrItemTranslatedByParser(it.original, it.current)) {
            parserKeys.add(`${it.textId}::${it.variantIdx}`);
          }
        }
        return { file: f.file, total: p.totalItems, translated: p.translatedItems, parserKeys };
      } catch { return null; }
    }));
    let total = 0, translated = 0;
    for (const r of results) {
      if (!r) continue;
      total += r.total; translated += r.translated;
      perFile[r.file] = { total: r.total, translated: r.translated, parserKeys: r.parserKeys };
    }
    setProjectStats({ files: files.length, total, translated });
    setFileStats(perFile);
  }
  useEffect(() => { if (phase === "ready") refreshProjectStats();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, files.length]);

  // Translation Memory — будуємо при phase=ready, після того як refreshProjectStats
  // зібрав parsed-файли. Debounced 600мс — щоб post-save reload одного файлу не
  // тригерив повний rescan.
  const tmBuildRef = useRef<number | null>(null);
  async function rebuildTm() {
    if (!files.length) { setTm(new Map()); return; }
    const w = window.dp2 as unknown as { hbrTextRead: (p: string) => Promise<{ ok: boolean; raw?: string }> };
    const parsedFiles = await Promise.all(files.map(async (f) => {
      try {
        const [d, o] = await Promise.all([w.hbrTextRead(f.donePath), w.hbrTextRead(f.origPath)]);
        if (!d.ok || !d.raw) return null;
        const p = parseHbrJson(d.raw, o.ok ? o.raw! : null, f.donePath, f.origPath);
        return { name: f.file, parsed: p };
      } catch { return null; }
    }));
    const validFiles = parsedFiles.filter((x): x is { name: string; parsed: HbrParsedFile } => x != null);
    const next = buildTranslationMemory({
      files: validFiles,
      isTranslated: (orig, cur) => isHbrItemTranslatedByParser(orig, cur),
    });
    setTm(next);
  }
  useEffect(() => {
    if (phase !== "ready") return;
    if (tmBuildRef.current != null) window.clearTimeout(tmBuildRef.current);
    tmBuildRef.current = window.setTimeout(() => { void rebuildTm(); }, 600);
    return () => { if (tmBuildRef.current != null) window.clearTimeout(tmBuildRef.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, files.length, parsed]);

  // Apply TM до активного файлу: для кожного НЕперекладеного рядка, чий
  // original є у TM, виставити current = tm[original].translation. Це фіча
  // на запит юзера ("додай TM, щоб я не перекладав 'Yes' двадцять разів").
  function applyTmToActiveFile() {
    if (!parsed) return;
    if (tm.size === 0) { showError("TM порожній — у проєкті ще немає перекладів", "Translation Memory"); return; }
    const items = parsed.items.slice();
    let applied = 0;
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      if (isHbrSystemRow(it.original)) continue;
      const isEmpty = !it.current || it.current.trim() === "";
      const isSame = it.current === it.original;
      if (!isEmpty && !isSame) continue;
      const hit = tm.get(it.original);
      if (!hit || !hit.consistent) continue;
      items[i] = { ...it, current: hit.translation };
      applied++;
    }
    if (applied === 0) { showOk("Нічого підходящого з TM", "Translation Memory"); return; }
    setParsed({ ...parsed, items });
    setDirty(true);
    showOk(`Auto-fill: ${applied} рядків з Translation Memory`, "Translation Memory");
  }

  // Знайти перший неперекладений рядок у всьому проєкті. Іде по всіх файлах,
  // парсить кожен, шукає item де парсер не вважає рядок перекладеним AND
  // markedTranslated не виставлено. Якщо знайдено — відкриває файл і ставить
  // активним рядком. Корисно, коли загальний % застряг на 99.9% і не зрозуміло,
  // де саме той 1 рядок.
  async function findFirstUntranslated() {
    if (!files.length) return;
    const w = window.dp2 as unknown as { hbrTextRead: (p: string) => Promise<{ ok: boolean; raw?: string }> };
    // Серіально, не паралельно — бо хочемо ПЕРШИЙ за алфавітом, не випадковий.
    for (const f of files) {
      try {
        const [d, o] = await Promise.all([w.hbrTextRead(f.donePath), w.hbrTextRead(f.origPath)]);
        if (!d.ok || !d.raw) continue;
        const p = parseHbrJson(d.raw, o.ok ? o.raw! : null, f.donePath, f.origPath);
        for (let i = 0; i < p.items.length; i++) {
          const it = p.items[i];
          if (isHbrItemTranslatedByParser(it.original, it.current)) continue;
          if (isHbrSystemRow(it.original)) continue; // система — пропускаємо
          const sk = statusKey(f.file, it.textId, it.variantIdx);
          if (statusFile.entries[sk]?.markedTranslated) continue;
          // Знайдено! Відкриваємо файл, ставимо активним рядок.
          await openFile(f);
          setActiveItemIndex(i);
          showOk(`Знайдено у ${f.file}, textId=${it.textId}`, "Untranslated");
          return;
        }
      } catch { /* skip broken file */ }
    }
    showOk("Усі рядки перекладені або позначені перекладеними 🎉", "Untranslated");
  }

  // Перевірка patch-міграції: коли редактор стає ready, питаємо main чи bundle
  // на диску ще відповідає тому, з якого ми робили extract. Якщо ні — піднімаємо
  // банер з кнопкою "Перемігрувати".
  useEffect(() => {
    if (phase !== "ready") return;
    let cancelled = false;
    (async () => {
      try {
        const w = window.dp2 as unknown as {
          hbrPatchMigrateCheck: () => Promise<{ ok: boolean; needed?: boolean; newBundle?: string; oldBundle?: string; metaItemsCount?: number; doneCount?: number }>;
        };
        const r = await w.hbrPatchMigrateCheck();
        if (cancelled || !r.ok) return;
        if (r.needed) {
          setMigrateInfo({
            needed: true,
            newBundle: r.newBundle || "?",
            oldBundle: r.oldBundle || "?",
            metaItemsCount: r.metaItemsCount || 0,
            doneCount: r.doneCount || 0,
          });
        } else {
          setMigrateInfo(null);
        }
      } catch {}
    })();
    return () => { cancelled = true; };
  }, [phase, files.length]);

  async function runPatchMigrate() {
    if (migrating) return;
    const ok = await showConfirm(
      t("hbr.migrate.confirmTitle"),
      t("hbr.migrate.confirmBody"),
      { tone: "warning", okLabel: t("hbr.migrate.confirmOk"), cancelLabel: t("btn.cancel") }
    );
    if (!ok) return;
    setMigrating(true);
    try {
      const w = window.dp2 as unknown as {
        hbrPatchMigrate: () => Promise<{ ok: boolean; error?: string; mergedFiles?: number; translated?: number; newCells?: number; backup?: string }>;
      };
      const r = await w.hbrPatchMigrate();
      if (!r.ok) {
        await showAlert(t("hbr.migrate.errTitle"), r.error || "?", { tone: "danger" });
        return;
      }
      await showAlert(
        t("hbr.migrate.doneTitle"),
        t("hbr.migrate.doneBody", {
          merged: String(r.mergedFiles ?? 0),
          translated: String(r.translated ?? 0),
          newCells: String(r.newCells ?? 0),
          backup: r.backup ?? "?",
        }),
        { tone: "success" }
      );
      setMigrateInfo(null);
      await refreshFiles();
    } finally {
      setMigrating(false);
    }
  }

  async function runGlobalSearch() {
    const q = globalQuery.trim().toLowerCase();
    if (!q) { setGlobalHits(null); return; }
    setGlobalSearching(true);
    try {
      const w = window.dp2 as unknown as { hbrTextRead: (p: string) => Promise<{ ok: boolean; raw?: string }> };
      // Паралельно читаємо всі файли + парсимо. На 61 файлі це ~10× швидше
      // за послідовний loop. Hits лімітуємо по 500 ПІСЛЯ збору — кінцевий
      // зріз робиться нижче.
      const perFile = await Promise.all(files.map(async (f) => {
        try {
          const [doneRes, origRes] = await Promise.all([
            w.hbrTextRead(f.donePath),
            w.hbrTextRead(f.origPath),
          ]);
          if (!doneRes.ok || !doneRes.raw) return null;
          const p = parseHbrJson(doneRes.raw, origRes.ok ? origRes.raw! : null, f.donePath, f.origPath);
          const localHits: GlobalHit[] = [];
          for (const it of p.items) {
            const inId = it.textId.toLowerCase().includes(q);
            const inOrig = it.original.toLowerCase().includes(q);
            const inCur = it.current.toLowerCase().includes(q);
            if (!inId && !inOrig && !inCur) continue;
            const snippetSrc = inCur ? it.current : (inOrig ? it.original : it.textId);
            const idx = snippetSrc.toLowerCase().indexOf(q);
            const start = Math.max(0, idx - 28);
            const end = Math.min(snippetSrc.length, idx + q.length + 36);
            const snippet = (start > 0 ? "…" : "") + snippetSrc.slice(start, end).replace(/\s+/g, " ") + (end < snippetSrc.length ? "…" : "");
            localHits.push({ file: f, textId: it.textId, variantIdx: it.variantIdx, snippet });
            if (localHits.length > 500) break;
          }
          return localHits;
        } catch { return null; }
      }));
      const hits: GlobalHit[] = [];
      for (const local of perFile) {
        if (!local) continue;
        for (const h of local) {
          hits.push(h);
          if (hits.length > 500) break;
        }
        if (hits.length > 500) break;
      }
      setGlobalHits(hits);
    } finally { setGlobalSearching(false); }
  }

  async function jumpToHit(h: GlobalHit) {
    setSearch("");
    setSearchDraft("");
    setRowFilter("all");
    setPendingScrollTextId({ textId: h.textId, variantIdx: h.variantIdx });
    await openFile(h.file);
  }

  async function loadAllParsed(): Promise<HbrParsedFile[]> {
    const w = window.dp2 as unknown as { hbrTextRead: (p: string) => Promise<{ ok: boolean; raw?: string }> };
    const out: HbrParsedFile[] = [];
    for (const f of files) {
      const doneRes = await w.hbrTextRead(f.donePath);
      const origRes = await w.hbrTextRead(f.origPath);
      if (!doneRes.ok || !doneRes.raw) continue;
      out.push(parseHbrJson(doneRes.raw, origRes.ok ? origRes.raw! : null, f.donePath, f.origPath));
    }
    return out;
  }

  async function exportCombined() {
    if (!files.length) return;
    setSaving(true);
    try {
      const all = await loadAllParsed();
      const txt = formatHbrCombinedTxt(all);
      const w = window.dp2 as unknown as {
        pickSaveFile: (opts: { title: string; defaultPath?: string; filters?: { name: string; extensions: string[] }[] }) => Promise<string | null>;
        writeFile: (path: string, content: string) => Promise<{ ok?: boolean; error?: string } | string | null>;
      };
      const dst = await w.pickSaveFile({
        title: t("hbr.combined.exportTitle"),
        defaultPath: "hbr-combined.txt",
        filters: [{ name: "Text", extensions: ["txt"] }],
      });
      if (!dst) return;
      const r = await w.writeFile(dst, txt);
      if (r && typeof r === "object" && r.ok === false) throw new Error(r.error || "write fail");
      await showAlert(t("hbr.combined.exportDoneTitle"), t("hbr.combined.exportDoneBody", { path: dst, n: all.length }), { tone: "success" });
    } catch (e: unknown) {
      await showAlert(t("hbr.combined.exportErrTitle"), String((e as Error)?.message ?? e), { tone: "danger" });
    } finally { setSaving(false); }
  }

  async function importCombined() {
    setSaving(true);
    try {
      const w = window.dp2 as unknown as {
        pickFile: (opts: { title: string; filters?: { name: string; extensions: string[] }[] }) => Promise<string | null>;
        readFile: (p: string) => Promise<string>;
        hbrTextRead: (p: string) => Promise<{ ok: boolean; raw?: string }>;
        hbrTextWrite: (p: { fullPath: string; raw: string }) => Promise<{ ok: boolean; error?: string }>;
      };
      const src = await w.pickFile({
        title: t("hbr.combined.importTitle"),
        filters: [{ name: "Text", extensions: ["txt"] }],
      });
      if (!src) return;
      const txt = await w.readFile(src);
      const parsed = parseHbrCombinedTxt(txt);
      if (parsed.blocks.length === 0) {
        await showAlert(t("hbr.combined.importErrTitle"), parsed.warnings.join("\n") || "no blocks", { tone: "danger" });
        return;
      }
      let totalUpdated = 0;
      const updatedFiles: Array<{ name: string; updated: number }> = [];
      const errors: string[] = [...parsed.warnings];
      for (const block of parsed.blocks) {
        const fileItem = files.find((x) => x.file === block.fileName);
        if (!fileItem) { errors.push(`Файл [${block.fileName}] не знайдено у Done — пропущено`); continue; }
        const doneRes = await w.hbrTextRead(fileItem.donePath);
        const origRes = await w.hbrTextRead(fileItem.origPath);
        if (!doneRes.ok || !doneRes.raw) { errors.push(`Не прочитано ${block.fileName}`); continue; }
        const parsedFile = parseHbrJson(doneRes.raw, origRes.ok ? origRes.raw! : null, fileItem.donePath, fileItem.origPath);
        const apply = applyCombinedToParsed(parsedFile, block.records);
        for (const k of apply.missing) errors.push(`[${block.fileName}] запис не знайдено: ${k}`);
        if (apply.updated > 0) {
          // applyHbrEdits тепер кидає при невідповідності кількості _Text у raw vs items.
          // Це сигналізує що bundle оновлено між extract і import — пропускаємо файл,
          // не псуючи інші.
          let newRaw: string;
          try {
            newRaw = applyHbrEdits(doneRes.raw, parsedFile.items);
          } catch (e) {
            errors.push(`[${block.fileName}] integrity check failed: ${(e as Error).message}`);
            continue;
          }
          const wr = await w.hbrTextWrite({ fullPath: fileItem.donePath, raw: newRaw });
          if (!wr.ok) { errors.push(`Не вдалося записати ${block.fileName}: ${wr.error}`); continue; }
          updatedFiles.push({ name: block.fileName, updated: apply.updated });
          totalUpdated += apply.updated;
        }
      }
      await refreshProjectStats();
      // Перезавантажуємо активний файл, якщо він відкритий.
      if (activeFile) {
        const refresh = await w.hbrTextRead(activeFile.donePath);
        if (refresh.ok && refresh.raw) {
          const origRes2 = await w.hbrTextRead(activeFile.origPath);
          setParsed(parseHbrJson(refresh.raw, origRes2.ok ? origRes2.raw! : null, activeFile.donePath, activeFile.origPath));
        }
      }
      // Беремо актуальні підсумкові цифри (refreshProjectStats уже відпрацював).
      const fresh = await window.dp2.hbrCorpusStats();
      setImportDone({
        records: totalUpdated,
        files: updatedFiles,
        errors,
        overall: {
          translated: fresh.ok ? (fresh.translatedEntries ?? 0) : 0,
          total: fresh.ok ? (fresh.totalEntries ?? 0) : 0,
        },
      });
    } catch (e: unknown) {
      await showAlert(t("hbr.combined.importErrTitle"), String((e as Error)?.message ?? e), { tone: "danger" });
    } finally { setSaving(false); }
  }

  async function packIntoGame(mode: "game" | "release" = "game") {
    const titleKey = mode === "release" ? "hbr.pack.confirmTitleRelease" : "hbr.pack.confirmTitle";
    const bodyKey = mode === "release" ? "hbr.pack.confirmBodyRelease" : "hbr.pack.confirmBody";
    const ok = await showConfirm(t(titleKey), t(bodyKey), { tone: "danger", okLabel: t("hbr.pack.confirmOk") });
    if (!ok) return;

    // Pre-pack lint: сканування плейсхолдерів. Якщо хоч один рядок має missing/
    // extra {n}/${var}/<tag>/[ctl] — попереджаємо. Це не блокує pack — лише
    // дає шанс відкатитись, бо такий білд може зламати UI/диалоги у грі.
    try {
      const lint = await window.dp2.hbrTextLintPlaceholders();
      const v = lint.violations ?? [];
      if (v.length > 0) {
        const preview = v.slice(0, 8).map((x) => {
          const bits = [];
          if (x.missing.length) bits.push(t("hbr.lint.missing", { tags: x.missing.join(", ") }));
          if (x.extra.length) bits.push(t("hbr.lint.extra", { tags: x.extra.join(", ") }));
          return `• ${x.file.replace(/-_resources_.+$/, "")} · ${x.textId} #${x.variantIdx} → ${bits.join(" · ")}`;
        }).join("\n");
        const proceed = await showConfirm(
          t("hbr.lint.title"),
          t("hbr.lint.body", { n: v.length, files: lint.scannedFiles ?? 0 }) + "\n\n" + preview + (v.length > 8 ? `\n…+${v.length - 8}` : ""),
          { tone: "warning", okLabel: t("hbr.lint.proceed"), cancelLabel: t("btn.cancel") },
        );
        if (!proceed) return;
      }
    } catch { /* lint не повинен валити pack — ігноруємо */ }

    setSaving(true);
    setPacking(true);
    setPackLog([]);
    try {
      const w = window.dp2 as unknown as {
        hbrPackIntoGame: () => Promise<{
          ok: boolean; error?: string; logPath?: string;
          bundlePath?: string; bundleSize?: number; bakPath?: string; bakSize?: number;
          totalFields?: number;
          summary?: { applied?: number; failed?: { name: string; reason: string }[] };
        }>;
        hbrBuildRelease: () => Promise<{
          ok: boolean; error?: string; releaseRoot?: string;
          bundleName?: string; bundleSize?: number; logPath?: string;
          packSummary?: { applied?: number; failed?: { name: string; reason: string }[] };
        }>;
        openFolder?: (p: string) => void;
      };

      if (mode === "release") {
        const r = await w.hbrBuildRelease();
        if (!r.ok) {
          await showAlert(t("hbr.pack.errTitle"), r.error ?? "?", { tone: "danger" });
          return;
        }
        const applied = r.packSummary?.applied ?? 0;
        const failed = r.packSummary?.failed?.length ?? 0;
        const sizeKb = r.bundleSize ? `${(r.bundleSize / 1024 / 1024).toFixed(1)} MB` : "—";
        const lines: string[] = [];
        lines.push(t("hbr.release.doneBody", { path: r.releaseRoot ?? "—", applied, failed, size: sizeKb }));
        const opened = await showConfirm(
          t("hbr.release.doneTitle"),
          lines.join("\n"),
          { tone: "success", okLabel: t("hbr.release.openFolder"), cancelLabel: t("btn.close") }
        );
        if (opened && r.releaseRoot && w.openFolder) w.openFolder(r.releaseRoot);
        return;
      }

      const r = await w.hbrPackIntoGame();
      if (!r.ok) {
        const logHint = r.logPath ? `\n\n${t("hbr.pack.logSaved", { path: r.logPath })}` : "";
        await showAlert(t("hbr.pack.errTitle"), (r.error ?? "?") + logHint, { tone: "danger" });
        return;
      }
      setPackSuccess({
        applied: r.summary?.applied ?? 0,
        failed: r.summary?.failed?.length ?? 0,
        totalFields: r.totalFields ?? 0,
        bundlePath: r.bundlePath,
        bundleSize: r.bundleSize,
        bakPath: r.bakPath,
        logPath: r.logPath,
        failedRows: r.summary?.failed,
      });
    } finally {
      setSaving(false);
      setPacking(false);
    }
  }

  // O(1) lookup item→idx замість parsed.items.indexOf(it) у map (O(N²) для
  // 1000+ items). Перебудовується тільки при зміні parsed.
  const idxMap = useMemo(() => {
    const m = new Map<HbrTextItem, number>();
    if (parsed) parsed.items.forEach((it, i) => m.set(it, i));
    return m;
  }, [parsed]);

  // Стабільні refs для HbrRow memo — інакше memo пропускає рендер тільки коли
  // callbacks не змінюються при кожному рендері HbrEditor.
  const handleRowSelect = useCallback((realIdx: number) => {
    setActiveItemIndex(realIdx);
  }, []);
  const handleRowContextMenu = useCallback((e: React.MouseEvent, realIdx: number) => {
    e.preventDefault();
    e.stopPropagation();
    setCtxMenu({ kind: "row", x: e.clientX, y: e.clientY, itemIndex: realIdx });
  }, []);

  // Real-time лічильник translated для АКТИВНОГО файлу. parsed.translatedItems
  // фіксується в parseHbrJson і не оновлюється при `setParsed({…items})` під
  // час редагування — тому брали його разом з extra було і застаріло, і ще й
  // ризик double-count. Тут рахуємо за тією ж формулою, що й фільтр рядків.
  const activeTranslatedCount = useMemo(() => {
    if (!parsed) return 0;
    let n = 0;
    for (const it of parsed.items) {
      if (isHbrItemTranslatedByParser(it.original, it.current)) { n++; continue; }
      const sk = activeFile ? statusKey(activeFile.file, it.textId, it.variantIdx) : "";
      if (sk && statusFile.entries[sk]?.markedTranslated) n++;
    }
    return n;
  }, [parsed, activeFile, statusFile, statusKey]);

  const filteredItems = useMemo(() => {
    if (!parsed) return [];
    const q = search.trim().toLowerCase();
    return parsed.items.filter((it) => {
      // Статус-фільтр: визначаємо isTranslated як у parseHbrJson:
      // current !== original AND current не порожній. System-row (тільки
      // теги типу <space=0em>, прочерк «-» тощо) автоматично translated.
      // markedTranslated (manual ПКМ-toggle) теж рахується як translated.
      const isSystem = isHbrSystemRow(it.original);
      const isSame = it.current === it.original;
      const isEmpty = !it.current || it.current.trim().length === 0;
      const sk = activeFile ? statusKey(activeFile.file, it.textId, it.variantIdx) : "";
      const marked = !!(sk && statusFile.entries[sk]?.markedTranslated);
      const isTranslated = isSystem || marked || (!isSame && !isEmpty);
      if (rowFilter === "untranslated" && isTranslated) return false;
      if (rowFilter === "translated" && !isTranslated) return false;
      if (rowFilter === "samesAsOriginal" && !isSame) return false;
      if (!q) return true;
      return (
        it.textId.toLowerCase().includes(q) ||
        it.original.toLowerCase().includes(q) ||
        it.current.toLowerCase().includes(q)
      );
    });
  }, [parsed, search, rowFilter, statusFile, activeFile, statusKey]);

  // ── Command palette items (Ctrl+K) ─────────────────────────────────────
  const commandItems = useMemo<CommandItem[]>(() => {
    const out: CommandItem[] = [];
    // Дії
    out.push({
      id: "save", category: "Дії", icon: "💾", label: "Зберегти файл",
      shortcut: "Ctrl+S", disabled: !parsed || !dirty || saving,
      run: () => { void saveActive(); },
    });
    out.push({
      id: "pack", category: "Дії", icon: "📦", label: "Pack у bundle",
      disabled: saving || !files.length,
      run: () => setPackMenuOpen(true),
    });
    out.push({
      id: "export", category: "Дії", icon: "↓", label: t("hbr.combined.exportBtn"),
      disabled: saving || !files.length,
      run: () => { void exportCombined(); },
    });
    out.push({
      id: "import", category: "Дії", icon: "↑", label: t("hbr.combined.importBtn"),
      disabled: saving || !files.length,
      run: () => { void importCombined(); },
    });
    // Інструменти
    out.push({
      id: "stats", category: "Інструменти", icon: "📊", label: t("hbr.stats.btn"),
      disabled: saving, run: () => setStatsOpen(true),
    });
    out.push({
      id: "reextract", category: "Інструменти", icon: "🔄", label: t("hbr.reextract.btn"),
      disabled: saving, run: () => { void reExtractFromGame(); },
    });
    out.push({
      id: "findReplace", category: "Інструменти", icon: "🔍", label: "Знайти / Замінити у файлі",
      shortcut: "Ctrl+H", disabled: !parsed || !parsed.items.length,
      run: () => setFindReplaceOpen(true),
    });
    out.push({
      id: "tm-apply", category: "Інструменти", icon: "✨", label: "Translation Memory: auto-fill",
      hint: `${tm.size} оригіналів`, disabled: !parsed || tm.size === 0,
      run: () => applyTmToActiveFile(),
    });
    out.push({
      id: "tm-rebuild", category: "Інструменти", icon: "🔁", label: "Translation Memory: перерахувати",
      run: () => { void rebuildTm(); },
    });
    out.push({
      id: "find-untranslated", category: "Інструменти", icon: "🔎",
      label: "Знайти перший неперекладений рядок",
      keywords: "untranslated 99 99% missing search неперекладений",
      disabled: files.length === 0,
      run: () => { void findFirstUntranslated(); },
    });
    out.push({
      id: "glossary", category: "Інструменти", icon: "📚", label: "Glossary…",
      disabled: !status?.doneDir, run: () => setGlossaryOpen(true),
    });
    out.push({
      id: "diff-view", category: "Інструменти", icon: "🧬", label: "Перегляд змін bundle",
      disabled: diffEntries.length === 0,
      hint: diffEntries.length > 0 ? `${diffEntries.length} змін` : "немає",
      run: () => setDiffOpen(true),
    });
    out.push({
      id: "monaco-toggle", category: "Перегляд",
      icon: monacoCollapsed ? "▶" : "◀",
      label: monacoCollapsed ? "Показати редактор справа" : "Сховати редактор справа",
      run: () => setMonacoCollapsed(!monacoCollapsed),
    });
    out.push({
      id: "shortcuts", category: "Перегляд", icon: "⌨", label: "Гарячі клавіші",
      shortcut: "?", run: () => setShortcutsOpen(true),
    });
    // Фільтри активного файлу
    const filters: Array<[RowFilter, string]> = [
      ["all", "Усі рядки"],
      ["untranslated", "Лиш неперекладені"],
      ["translated", "Лиш перекладені"],
      ["samesAsOriginal", "Однакові з оригіналом"],
    ];
    for (const [k, lab] of filters) {
      out.push({
        id: `filter-${k}`, category: "Фільтр рядків",
        icon: rowFilter === k ? "●" : "○",
        label: lab, run: () => setRowFilter(k),
      });
    }
    // Файли — швидкий перехід.
    for (const f of files) {
      const st = fileStats[f.file];
      const pct = st && st.total > 0 ? Math.round((st.translated / st.total) * 100) : 0;
      out.push({
        id: `file-${f.donePath}`, category: "Перехід до файлу", icon: "📄",
        label: f.file, hint: st ? `${st.translated}/${st.total} · ${pct}%` : undefined,
        run: () => { void openFile(f); },
      });
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [parsed, dirty, saving, files, fileStats, rowFilter, monacoCollapsed, tm.size, diffEntries.length]);

  return (
    <div className="flex-1 flex flex-col bg-[var(--bg)] min-h-0">
      <header className="h-12 px-4 border-b border-[var(--border-soft)] bg-[var(--bg-surface)] flex items-center gap-2 shrink-0">
        <button className="dp-btn dp-btn--ghost" onClick={onHome} title={t("header.home")}>←</button>
        <span className="text-[13px] font-semibold text-[var(--text-strong)] truncate">Hotel Barcelona · Text</span>
        {projectStats && (() => {
          const tr = projectStats.translated + totalMarkedTranslated;
          return (
            <HeaderProgress
              translated={tr}
              total={projectStats.total}
              title={`Загальний прогрес проєкту · ${projectStats.files} файлів`}
            />
          );
        })()}
        <div className="flex-1" />
        {phase === "ready" && (
          <>
            <button
              className="dp-btn dp-btn--ghost"
              onClick={() => setCmdOpen(true)}
              title="Командна палітра (Ctrl+K)"
            >
              <svg className="w-3.5 h-3.5 inline" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
              </svg>
              <span className="ml-1 text-[10px] font-mono px-1 py-0.5 border border-[var(--border-soft)] rounded">⌘K</span>
            </button>
            <HeaderMenu
              trigger={<span className="flex items-center gap-1"><span aria-hidden>🛠</span> Інструменти</span>}
              items={[
                { icon: "📊", label: t("hbr.stats.btn"), title: t("hbr.stats.btnHint"), disabled: saving, onClick: () => setStatsOpen(true) },
                { icon: "🔄", label: t("hbr.reextract.btn"), title: t("hbr.reextract.hint"), disabled: saving, onClick: () => reExtractFromGame() },
                { icon: "🔍", label: "Знайти / Замінити", shortcut: "Ctrl+H", disabled: !parsed || !parsed.items.length, onClick: () => setFindReplaceOpen(true) },
                {},
                { icon: "✨", label: `Translation Memory: auto-fill`, title: `${tm.size} оригіналів у пам'яті`, disabled: !parsed || tm.size === 0, onClick: () => applyTmToActiveFile() },
                { icon: "🔎", label: "Знайти неперекладений рядок", title: "Сканує всі файли і відкриває перший неперекладений рядок. Корисно коли % застряг на 99.9%.", disabled: files.length === 0, onClick: () => { void findFirstUntranslated(); } },
                { icon: "📚", label: "Glossary…", title: "Терміновий словник UK ↔ EN для консистентності перекладу", disabled: !status?.doneDir, onClick: () => setGlossaryOpen(true) },
                { icon: "🧬", label: "Перегляд змін bundle…", title: "Diff між старим/новим bundle після patch-migrate", disabled: diffEntries.length === 0, onClick: () => setDiffOpen(true) },
              ]}
            />
            <HeaderMenu
              trigger={<span className="flex items-center gap-1"><span aria-hidden>📁</span> Файл</span>}
              items={[
                { icon: "↓", label: t("hbr.combined.exportBtn"), title: t("hbr.combined.exportBtnHint"), disabled: saving || !files.length, onClick: () => exportCombined() },
                { icon: "↑", label: t("hbr.combined.importBtn"), title: t("hbr.combined.importBtnHint"), disabled: saving || !files.length, onClick: () => importCombined() },
                {},
                { icon: "⌨", label: "Гарячі клавіші", shortcut: "?", onClick: () => setShortcutsOpen(true) },
                { icon: monacoCollapsed ? "▶" : "◀", label: monacoCollapsed ? "Показати pane редактора" : "Сховати pane редактора", onClick: () => setMonacoCollapsed(!monacoCollapsed) },
              ]}
            />
            <button
              className="dp-btn dp-btn--success"
              disabled={saving || !files.length}
              onClick={() => setPackMenuOpen(true)}
              title={t("hbr.pack.btnHint")}
            >
              {t("hbr.pack.btn")}
            </button>
          </>
        )}
        <LangToggle compact />
      </header>

      {/* Patch-migration банер. З'являється коли bundle на диску має новий
         хеш, а meta/Done ще посилаються на старий — тобто гра отримала патч
         і треба пере-екстрактувати + перенести переклади. */}
      {phase === "ready" && migrateInfo?.needed && (
        <div className="px-4 py-2.5 border-b border-[var(--border-soft)] bg-[var(--warning,#d97706)]/10 flex items-center gap-3 shrink-0">
          <svg className="w-5 h-5 text-[var(--warning,#d97706)] shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z" />
          </svg>
          <div className="flex-1 min-w-0">
            <div className="text-[12.5px] font-semibold text-[var(--text-strong)]">
              {t("hbr.migrate.bannerTitle")}
            </div>
            <div className="text-[11px] text-[var(--text-muted)] mt-0.5">
              {t("hbr.migrate.bannerBody", { old: migrateInfo.oldBundle, fresh: migrateInfo.newBundle })}
            </div>
          </div>
          <button className="dp-btn dp-btn--primary shrink-0" onClick={runPatchMigrate} disabled={migrating}>
            {migrating ? t("hbr.migrate.btnRunning") : t("hbr.migrate.btn")}
          </button>
        </div>
      )}

      {/* Sub-toolbar для активного файлу. Винесено з головної шапки, бо там
         довжина fileName / поява-зникнення "Збережено"-індикатора штовхали
         центральні кнопки і "Зібрати у гру" танцювала туди-сюди. Тут фікс-
         ширина і justify-between — нічого не стрибає. */}
      {phase === "ready" && activeFile && (
        <div className="h-9 px-4 border-b border-[var(--border-soft)] bg-[var(--bg)] flex items-center gap-2 shrink-0">
          <span className="text-[11px] text-[var(--text-faint)] font-mono truncate min-w-0 flex-1" title={activeFile.file}>
            {activeFile.file}
          </span>
          <button
            className="dp-btn dp-btn--ghost shrink-0"
            onClick={() => setFindReplaceOpen(true)}
            disabled={!parsed || !parsed.items.length}
            title={t("hbr.findReplace.btnHint")}
          >
            {t("hbr.findReplace.btn")}
          </button>
          <span
            className="text-[11px] text-[var(--success)] flex items-center gap-1 shrink-0"
            title={t("hbr.editor.savedHint")}
            style={{ visibility: parsed && !dirty && !saving ? "visible" : "hidden" }}
          >
            <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
            </svg>
            {t("hbr.editor.saved")}
          </span>
          <button
            className={`dp-btn shrink-0 ${dirty ? "dp-btn--primary" : ""}`}
            onClick={saveActive}
            disabled={!parsed || !dirty || saving}
            title="Ctrl+S"
          >
            {saving ? t("hbr.editor.saving") : t("hbr.editor.save")}
          </button>
        </div>
      )}

      {phase === "preparing" && (
        <div className="flex-1 flex items-center justify-center p-8 overflow-y-auto relative" style={{ background: "#0d1117" }}>
          <div
            aria-hidden
            style={{
              position: "absolute", inset: 0,
              backgroundImage: `url(${hbrHero})`,
              backgroundSize: "cover",
              backgroundPosition: "center",
              filter: "blur(2px) brightness(0.45) saturate(1.1)",
              opacity: 0.6,
              zIndex: 0,
            }}
          />
          <div
            aria-hidden
            style={{
              position: "absolute", inset: 0,
              background: "linear-gradient(180deg, rgba(13,17,23,0.45) 0%, rgba(13,17,23,0.85) 60%, rgba(13,17,23,0.95) 100%)",
              zIndex: 0,
            }}
          />
          <div className="w-full max-w-[680px] relative" style={{ zIndex: 1 }}>
            <header className="mb-6 text-center">
              <p className="text-[11px] uppercase tracking-[0.2em] text-[var(--text-faint)] mb-1">
                Hotel Barcelona
              </p>
              <h2 className="text-[20px] font-bold text-[var(--text-strong)] mb-1">
                {t("hbr.prep.wizardTitle")}
              </h2>
              <p className="text-[12.5px] text-[var(--text-muted)] leading-relaxed">
                {t("hbr.prep.wizardSubtitle")}
              </p>
            </header>

            <ol className="space-y-2.5">
              <PrepStep
                index={1}
                status={steps.tool}
                title={t("hbr.prep.step.toolTitle")}
                subtitle={t("hbr.prep.step.toolSubtitle")}
              >
                {steps.tool === "running" && (
                  <ProgressBlock
                    label={
                      toolProgress?.i18nKey
                        ? t(toolProgress.i18nKey, toolProgress.i18nParams)
                        : t("hbr.tools.checking")
                    }
                    percent={toolProgress?.percent ?? null}
                    downloaded={toolProgress?.downloaded}
                    total={toolProgress?.total}
                    bps={toolProgress?.bytesPerSec}
                    speedLabel={(v) => t("hbr.tools.speed", { speed: v })}
                  />
                )}
                {steps.tool === "skipped" && (
                  <p className="text-[11.5px] text-[var(--text-faint)]">{t("hbr.tools.alreadyHave")}</p>
                )}
                {steps.tool === "done" && (
                  <p className="text-[11.5px] text-[var(--text-faint)]">{t("hbr.tools.downloaded")}</p>
                )}
              </PrepStep>

              <PrepStep
                index={2}
                status={steps.catalog}
                title={t("hbr.prep.step.catalogTitle")}
                subtitle={t("hbr.prep.step.catalogSubtitle")}
              >
                {steps.catalog === "running" && (
                  <p className="text-[11.5px] text-[var(--text-muted)] flex items-center gap-2">
                    <span className="inline-block h-1.5 w-1.5 rounded-full bg-[var(--accent)] animate-pulse" />
                    {t("hbr.catalog.patching")}
                  </p>
                )}
                {steps.catalog === "skipped" && (
                  <p className="text-[11.5px] text-[var(--text-faint)]">{t("hbr.catalog.alreadyPatched")}</p>
                )}
                {steps.catalog === "done" && (
                  <p className="text-[11.5px] text-[var(--text-faint)]">{t("hbr.catalog.patched")}</p>
                )}
              </PrepStep>

              <PrepStep
                index={3}
                status={steps.extract}
                title={t("hbr.prep.step.extractTitle")}
                subtitle={t("hbr.prep.step.extractSubtitle")}
              >
                {steps.extract === "running" && (
                  <ExtractProgress
                    count={extractedCount}
                    total={EXPECTED_HBR_FILES}
                    lastLine={progressLines[progressLines.length - 1]}
                  />
                )}
                {steps.extract === "skipped" && (
                  <p className="text-[11.5px] text-[var(--text-faint)]">{t("hbr.prep.step.extractAlready")}</p>
                )}
                {steps.extract === "done" && (
                  <p className="text-[11.5px] text-[var(--text-faint)]">
                    {t("hbr.prep.step.extractDone", { n: extractedCount || EXPECTED_HBR_FILES })}
                  </p>
                )}
                {steps.mirror === "running" && (
                  <p className="mt-1 text-[11.5px] text-[var(--text-muted)] flex items-center gap-2">
                    <span className="inline-block h-1.5 w-1.5 rounded-full bg-[var(--accent)] animate-pulse" />
                    {t("hbr.prep.mirroring")}
                  </p>
                )}
              </PrepStep>
            </ol>
          </div>
        </div>
      )}

      {packMenuOpen && !packing && (
        <div className="fixed inset-0 z-40 bg-black/60 flex items-center justify-center p-6" onClick={() => setPackMenuOpen(false)}>
          <div
            className="w-full max-w-[560px] bg-[var(--bg-surface)] border border-[var(--border-soft)] rounded-lg shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="px-5 py-3 border-b border-[var(--border-soft)] flex items-center gap-2">
              <p className="text-[13px] font-semibold text-[var(--text-strong)]">{t("hbr.packMenu.title")}</p>
              <div className="flex-1" />
              <button className="dp-btn dp-btn--ghost" onClick={() => setPackMenuOpen(false)}>✕</button>
            </div>
            <div className="p-4 space-y-2">
              <button
                className="w-full text-left rounded-md border border-[var(--border-soft)] bg-[var(--bg)] hover:bg-[var(--row-hover)] p-4 flex items-start gap-3"
                onClick={() => { setPackMenuOpen(false); packIntoGame("game"); }}
              >
                <span className="text-[18px] leading-none mt-0.5">🎮</span>
                <div className="flex-1 min-w-0">
                  <p className="text-[13px] font-semibold text-[var(--text-strong)]">{t("hbr.packMenu.gameTitle")}</p>
                  <p className="text-[11.5px] text-[var(--text-muted)] mt-1 leading-relaxed">{t("hbr.packMenu.gameBody")}</p>
                </div>
              </button>
              <button
                className="w-full text-left rounded-md border border-[var(--border-soft)] bg-[var(--bg)] hover:bg-[var(--row-hover)] p-4 flex items-start gap-3"
                onClick={() => { setPackMenuOpen(false); packIntoGame("release"); }}
              >
                <span className="text-[18px] leading-none mt-0.5">📦</span>
                <div className="flex-1 min-w-0">
                  <p className="text-[13px] font-semibold text-[var(--text-strong)]">{t("hbr.packMenu.releaseTitle")}</p>
                  <p className="text-[11.5px] text-[var(--text-muted)] mt-1 leading-relaxed">{t("hbr.packMenu.releaseBody")}</p>
                </div>
              </button>
            </div>
          </div>
        </div>
      )}

      {packing && (() => {
        // Похідні з лога значення для прогрес-шкали.
        const patchedLines = packLog.filter((l) => l.startsWith("[PATCHED]"));
        const failLines = packLog.filter((l) => l.startsWith("[FAIL]"));
        const totalMatch = packLog.find((l) => /\[DIAG\] Meta items:/.test(l));
        const totalGuess = totalMatch ? parseInt(totalMatch.replace(/[^\d]/g, ""), 10) || files.length : (files.length || 61);
        const done = patchedLines.length + failLines.length;
        const pct = totalGuess > 0 ? Math.min(100, Math.round((done / totalGuess) * 100)) : null;
        const isWriting = packLog.some((l) => /Writing bundle/i.test(l));
        const isDone = packLog.some((l) => /\[STEP\] DONE/i.test(l));
        const hasMeta = packLog.some((l) => /\[DIAG\] Meta items:/.test(l));
        const hasBundleLoad = packLog.some((l) => /\[STEP\] Loading bundle/i.test(l));
        const lastLine = packLog[packLog.length - 1] || "";
        const lastName = (() => {
          const m = lastLine.match(/\[PATCHED\]\s+([^\s(]+)/);
          return m ? m[1] : "";
        })();

        // Чек-лист 5 кроків — статус кожного виводимо з логу.
        type StepKey = "meta" | "bundle" | "patch" | "write" | "done";
        const stepStatus = (k: StepKey): "pending" | "running" | "done" => {
          if (k === "meta") return hasMeta ? "done" : "running";
          if (k === "bundle") return hasBundleLoad ? (hasMeta ? "done" : "running") : "pending";
          if (k === "patch") {
            if (!hasBundleLoad) return "pending";
            if (totalGuess > 0 && done >= totalGuess) return "done";
            return "running";
          }
          if (k === "write") {
            if (isDone) return "done";
            if (isWriting) return "running";
            return "pending";
          }
          if (k === "done") return isDone ? "done" : "pending";
          return "pending";
        };

        const renderStep = (k: StepKey, title: string, sub?: ReactNode) => {
          const s = stepStatus(k);
          const icon = s === "done"
            ? <span className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-[var(--success)]/15 text-[var(--success)] border border-[var(--success)]/40 text-[10px] font-bold shrink-0">✓</span>
            : s === "running"
              ? <span className="inline-flex items-center justify-center w-5 h-5 rounded-full border border-[var(--accent)]/40 bg-[var(--accent)]/10 shrink-0"><span className="inline-block h-2.5 w-2.5 rounded-full border-2 border-[var(--accent)] border-t-transparent animate-spin" /></span>
              : <span className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-[var(--bg-elevated)] border border-[var(--border-soft)] text-[var(--text-faint)] text-[10px] shrink-0">○</span>;
          const titleCls = s === "running"
            ? "text-[var(--text-strong)]"
            : s === "done"
              ? "text-[var(--text)]"
              : "text-[var(--text-faint)]";
          return (
            <li className="flex items-start gap-2.5 py-1.5">
              {icon}
              <div className="flex-1 min-w-0">
                <p className={`text-[12.5px] leading-snug ${titleCls}`}>{title}</p>
                {sub && <div className="text-[11px] text-[var(--text-muted)] mt-0.5">{sub}</div>}
              </div>
            </li>
          );
        };

        // Кольорування рядків лога: type-based.
        const colorize = (line: string): string => {
          if (line.startsWith("[PATCHED]")) return "text-[var(--success)]";
          if (line.startsWith("[FAIL]")) return "text-[var(--danger)] font-semibold";
          if (line.startsWith("[STEP]")) return "text-[var(--accent)]";
          if (line.startsWith("[DIAG]")) return "text-[var(--text-faint)]";
          if (line.startsWith("[SKIP]")) return "text-[var(--warning)]";
          return "text-[var(--text-muted)]";
        };

        return (
          <div className="fixed inset-0 z-40 bg-black/60 flex items-center justify-center p-6">
            <div className="w-full max-w-[640px] bg-[var(--bg-surface)] border border-[var(--border-soft)] rounded-lg shadow-xl">
              {/* Header */}
              <div className="px-5 py-3 border-b border-[var(--border-soft)] flex items-center gap-3">
                <span className="inline-block h-3 w-3 rounded-full border-2 border-[var(--accent)] border-t-transparent animate-spin" />
                <p className="text-[13px] font-semibold text-[var(--text-strong)]">{t("hbr.pack.runningTitle")}</p>
                <span className="ml-auto text-[10.5px] tabular-nums text-[var(--text-faint)]">
                  {patchedLines.length}/{totalGuess}
                  {failLines.length > 0 && (
                    <span className="text-[var(--danger)] ml-1">· {failLines.length} {t("hbr.pack.failedShort")}</span>
                  )}
                </span>
              </div>

              {/* Чек-лист фаз */}
              <ol className="px-5 py-3">
                {renderStep("meta", t("hbr.pack.step.meta"),
                  hasMeta ? <span className="tabular-nums">{totalGuess} items</span> : undefined)}
                {renderStep("bundle", t("hbr.pack.step.bundle"))}
                {renderStep(
                  "patch",
                  t("hbr.pack.step.patch"),
                  stepStatus("patch") !== "pending" ? (
                    <div>
                      <div className="flex items-baseline justify-between mb-1 gap-2">
                        <span className="tabular-nums text-[var(--text-muted)]">
                          {done} / {totalGuess}{pct != null && ` · ${pct}%`}
                        </span>
                        {lastName && (
                          <span className="font-mono text-[10.5px] text-[var(--text-faint)] truncate max-w-[260px]" title={lastName}>{lastName}</span>
                        )}
                      </div>
                      <div className="h-1 rounded-full bg-[var(--bg-elevated)] overflow-hidden">
                        <div
                          className="h-full bg-[var(--accent)] transition-all"
                          style={{ width: pct != null ? `${pct}%` : "0%" }}
                        />
                      </div>
                    </div>
                  ) : undefined,
                )}
                {renderStep("write", t("hbr.pack.step.write"))}
                {renderStep("done", t("hbr.pack.step.done"))}
              </ol>

              {/* Лог — згорнутий за замовч. */}
              <div className="px-5 pb-4">
                <details className="group">
                  <summary className="cursor-pointer list-none text-[11px] text-[var(--text-muted)] hover:text-[var(--text)] flex items-center gap-1 select-none">
                    <span className="inline-block transition-transform group-open:rotate-90">›</span>
                    {t("hbr.pack.logToggle")} <span className="text-[var(--text-faint)]">({packLog.length})</span>
                  </summary>
                  <div className="mt-2 text-[10.5px] font-mono bg-[var(--bg)] border border-[var(--border-soft)] rounded p-2 max-h-[260px] overflow-y-auto whitespace-pre-wrap break-all">
                    {packLog.length === 0 ? (
                      <span className="text-[var(--text-faint)]">{t("hbr.pack.starting")}</span>
                    ) : (
                      packLog.slice(-200).map((line, i) => (
                        <div key={i} className={colorize(line)}>{line}</div>
                      ))
                    )}
                  </div>
                </details>
              </div>
            </div>
          </div>
        );
      })()}

      {phase === "error" && (
        <div className="p-6 max-w-[820px]">
          <div className="rounded border border-[var(--danger)]/40 bg-[var(--danger)]/10 p-4">
            <p className="text-[13px] font-bold text-[var(--danger)] mb-1">{t("hbr.prep.errTitle")}</p>
            <p className="text-[12.5px] text-[var(--text)] whitespace-pre-wrap leading-relaxed">{errorMsg}</p>
            <div className="flex gap-2 mt-3">
              <button
                className="dp-btn dp-btn--primary"
                onClick={() => {
                  setErrorMsg(null);
                  setProgressLines([]);
                  setExtractedCount(0);
                  triedRef.current = false;
                  runFlow();
                  triedRef.current = true;
                }}
              >
                {t("hbr.prep.retry")}
              </button>
              <button
                className="dp-btn dp-btn--ghost ml-auto"
                onClick={async () => {
                  await showAlert(t("hbr.prep.diagTitle"), progressLines.slice(-50).join("\n") || "(no log)");
                }}
              >
                {t("hbr.prep.showLog")}
              </button>
            </div>
          </div>
        </div>
      )}

      {ctxMenu && (
        <ul
          className="fixed z-50 min-w-[240px] py-1 bg-[var(--bg-surface)] border border-[var(--border-soft)] rounded shadow-lg text-[12.5px]"
          style={{ left: ctxMenu.x, top: ctxMenu.y }}
          onClick={(e) => e.stopPropagation()}
        >
          {ctxMenu.kind === "row" && parsed && (() => {
            const idx = ctxMenu.itemIndex;
            const it = parsed.items[idx];
            const sk = activeFile && it ? statusKey(activeFile.file, it.textId, it.variantIdx) : "";
            const entry = sk ? statusFile.entries[sk] : undefined;
            return (
              <>
                <li
                  className={`px-3 py-1.5 hover:bg-[var(--row-hover)] cursor-pointer ${entry?.status === "draft" ? "text-[var(--warning,#d97706)] font-semibold" : ""}`}
                  onClick={() => { setRowStatus(idx, entry?.status === "draft" ? undefined : "draft"); setCtxMenu(null); }}
                >
                  {t("status.markDraft")}
                </li>
                <li
                  className={`px-3 py-1.5 hover:bg-[var(--row-hover)] cursor-pointer ${entry?.status === "review" ? "text-[var(--accent)] font-semibold" : ""}`}
                  onClick={() => { setRowStatus(idx, entry?.status === "review" ? undefined : "review"); setCtxMenu(null); }}
                >
                  {t("status.markReview")}
                </li>
                <li
                  className={`px-3 py-1.5 hover:bg-[var(--row-hover)] cursor-pointer ${entry?.status === "approved" ? "text-[var(--success)] font-semibold" : ""}`}
                  onClick={() => { setRowStatus(idx, entry?.status === "approved" ? undefined : "approved"); setCtxMenu(null); }}
                >
                  {t("status.markApproved")}
                </li>
                <li
                  className="px-3 py-1.5 hover:bg-[var(--row-hover)] cursor-pointer"
                  onClick={() => { setRowStatus(idx, undefined); setCtxMenu(null); }}
                >
                  {t("status.clear")}
                </li>
                <li className="border-t border-[var(--border-soft)] my-0.5" />
                <li
                  className={`px-3 py-1.5 hover:bg-[var(--row-hover)] cursor-pointer ${entry?.bookmark ? "text-[var(--accent)] font-semibold" : ""}`}
                  onClick={() => { toggleRowBookmark(idx); setCtxMenu(null); }}
                >
                  {t("status.toggleBookmark")}
                </li>
                <li
                  className={`px-3 py-1.5 hover:bg-[var(--row-hover)] cursor-pointer ${entry?.markedTranslated ? "text-[var(--success)] font-semibold" : ""}`}
                  onClick={() => { toggleRowMarkedTranslated(idx); setCtxMenu(null); }}
                >
                  {entry?.markedTranslated ? t("status.unmarkTranslated") : t("status.markTranslated")}
                </li>
                <li className="border-t border-[var(--border-soft)] my-0.5" />
                <li
                  className="px-3 py-1.5 hover:bg-[var(--row-hover)] cursor-pointer"
                  onClick={() => { if (it) patchItem(idx, it.original); setCtxMenu(null); }}
                >
                  {t("bulk.copyOriginal")}
                </li>
                <li
                  className="px-3 py-1.5 hover:bg-[var(--row-hover)] cursor-pointer"
                  onClick={() => { if (it) patchItem(idx, it.current.trim()); setCtxMenu(null); }}
                >
                  {t("bulk.trim")}
                </li>
                <li
                  className="px-3 py-1.5 hover:bg-[var(--row-hover)] cursor-pointer"
                  onClick={async () => {
                    if (it) { try { await navigator.clipboard.writeText(it.original); } catch {} }
                    setCtxMenu(null);
                  }}
                >
                  {t("hbr.ctx.copyOriginal")}
                </li>
                <li
                  className="px-3 py-1.5 hover:bg-[var(--row-hover)] cursor-pointer text-[var(--danger)]"
                  onClick={() => { if (it) patchItem(idx, ""); setCtxMenu(null); }}
                >
                  {t("hbr.ctx.clearTranslation")}
                </li>
              </>
            );
          })()}
          {ctxMenu.kind === "file" && (() => {
            // Перевіряємо, чи цей файл вже на 100% (translated >= total —
            // means усі рядки парсер бачить як перекладені або marked-translated
            // вже стояли). У такому разі основна дія — «Зняти позначку».
            const st = fileStats[ctxMenu.file.file];
            const extra = markedTranslatedByFile.get(ctxMenu.file.file) ?? 0;
            const total = st?.total ?? 0;
            const translated = (st?.translated ?? 0) + extra;
            const isFullyMarked = total > 0 && translated >= total;
            const file = ctxMenu.file;
            return (
              <>
                <li className="px-3 py-1 text-[10px] uppercase tracking-wider text-[var(--text-faint)] border-b border-[var(--border-soft)] truncate" title={file.file}>
                  {file.file}
                </li>
                <li
                  className="px-3 py-1.5 hover:bg-[var(--row-hover)] cursor-pointer text-[var(--success)]"
                  onClick={() => { void bulkMarkFileTranslated(file, true); setCtxMenu(null); }}
                >
                  ✓ Позначити увесь файл перекладеним
                </li>
                <li
                  className={`px-3 py-1.5 hover:bg-[var(--row-hover)] cursor-pointer ${isFullyMarked ? "text-[var(--text)]" : "text-[var(--text-faint)]"}`}
                  onClick={() => { void bulkMarkFileTranslated(file, false); setCtxMenu(null); }}
                >
                  ✗ Зняти позначку з усього файлу
                </li>
                <li className="border-t border-[var(--border-soft)] my-1" />
                <li
                  className="px-3 py-1.5 hover:bg-[var(--row-hover)] cursor-pointer"
                  onClick={() => { restoreFileFromBak(file); setCtxMenu(null); }}
                >
                  {t("hbr.ctx.restoreFromBak")}
                </li>
                <li
                  className="px-3 py-1.5 hover:bg-[var(--row-hover)] cursor-pointer"
                  onClick={() => { restoreFileFromOriginal(file); setCtxMenu(null); }}
                >
                  {t("hbr.ctx.restoreOriginal")}
                </li>
                <li
                  className="px-3 py-1.5 hover:bg-[var(--row-hover)] cursor-pointer"
                  onClick={async () => {
                    const w = window.dp2 as unknown as { openFolder?: (p: string) => void };
                    if (w.openFolder) w.openFolder(file.donePath.replace(/[\\/][^\\/]+$/, ""));
                    setCtxMenu(null);
                  }}
                >
                  {t("hbr.ctx.openFolder")}
                </li>
              </>
            );
          })()}
        </ul>
      )}

      {phase === "ready" && (
        <div className="flex-1 flex min-h-0">
          {/* Left: file list — sidebar 2.0 з пошуком/sort/tabs + resizable. */}
          <HbrFileSidebar
            files={files.map((f) => ({ file: f.file, donePath: f.donePath, origPath: f.origPath, size: f.size }))}
            activeKey={activeFile?.donePath ?? null}
            fileStats={(() => {
              const m: Record<string, { total: number; translated: number }> = {};
              for (const [k, v] of Object.entries(fileStats)) m[k] = { total: v.total, translated: v.translated };
              return m;
            })()}
            extraTranslated={markedTranslatedByFile}
            globalQuery={globalQuery}
            onGlobalQueryChange={setGlobalQuery}
            onGlobalSearch={runGlobalSearch}
            globalSearching={globalSearching}
            globalHits={globalHits}
            onClearGlobal={() => { setGlobalHits(null); setGlobalQuery(""); }}
            onJumpToHit={(h) => jumpToHit(h as unknown as GlobalHit)}
            onPick={(sf) => {
              const full = files.find((x) => x.donePath === sf.donePath);
              if (full) void openFile(full);
            }}
            onFileContextMenu={(e, sf) => {
              const full = files.find((x) => x.donePath === sf.donePath);
              if (full) setCtxMenu({ kind: "file", x: e.clientX, y: e.clientY, file: full });
            }}
          />

          {/* Right: editor */}
          <section className="flex-1 flex flex-col min-w-0">
            {!parsed && (
              <div className="flex-1 flex items-center justify-center text-[13px] text-[var(--text-muted)]">
                {t("hbr.editor.pickFile")}
              </div>
            )}
            {parsed && (
              <>
                <div className="px-3 py-2 border-b border-[var(--border-soft)] flex flex-col gap-2">
                  <div className="flex items-center gap-2">
                    <input
                      className="dp-input flex-1"
                      placeholder={t("hbr.editor.searchPh")}
                      value={searchDraft}
                      onChange={(e) => setSearchDraft(e.target.value)}
                    />
                    <span className="text-[11px] text-[var(--text-faint)] tabular-nums">
                      {(() => {
                        const tr = activeTranslatedCount;
                        return `${tr}/${parsed.totalItems} · ${parsed.totalItems > 0 ? ((tr / parsed.totalItems) * 100).toFixed(1) : "0.0"}%`;
                      })()}
                    </span>
                  </div>
                  <div className="flex gap-1 text-[11px]">
                    {([
                      ["all",             t("hbr.filter.all")],
                      ["untranslated",    t("hbr.filter.untranslated")],
                      ["translated",      t("hbr.filter.translated")],
                      ["samesAsOriginal", t("hbr.filter.same")],
                    ] as Array<[RowFilter, string]>).map(([k, lab]) => (
                      <button
                        key={k}
                        onClick={() => setRowFilter(k)}
                        className={`dp-btn ${rowFilter === k ? "dp-btn--primary" : ""}`}
                      >
                        {lab}
                      </button>
                    ))}
                    <span className="ml-auto text-[var(--text-faint)] self-center">
                      {t("hbr.filter.shown", { n: filteredItems.length })}
                    </span>
                  </div>
                </div>
                <div className="flex-1 overflow-y-auto">
                  <table className="w-full text-[12px] table-fixed">
                    <thead className="sticky top-0 z-10 bg-[var(--bg-surface)] text-[10px] uppercase tracking-wider text-[var(--text-faint)] border-b border-[var(--border-soft)]">
                      <tr>
                        <th className="text-left px-2 py-1.5 w-[180px]">_TextId</th>
                        <th className="text-left px-2 py-1.5 w-[36px]">#</th>
                        <th className="text-left px-2 py-1.5 w-1/2">{t("hbr.editor.original")}</th>
                        <th className="text-left px-2 py-1.5 w-1/2">{t("hbr.editor.translation")}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {filteredItems.map((it) => {
                        const realIdx = idxMap.get(it) ?? -1;
                        const sk = activeFile ? statusKey(activeFile.file, it.textId, it.variantIdx) : "";
                        const entry = sk ? statusFile.entries[sk] : undefined;
                        return (
                          <HbrRow
                            key={realIdx}
                            it={it}
                            realIdx={realIdx}
                            active={activeItemIndex === realIdx}
                            status={entry?.status}
                            bookmark={entry?.bookmark}
                            markedTranslated={entry?.markedTranslated}
                            onSelect={handleRowSelect}
                            onContextMenu={handleRowContextMenu}
                          />
                        );
                      })}
                    </tbody>
                  </table>
                </div>
                <EditorFooter
                  fileName={activeFile?.file}
                  stats={[
                    {
                      label: t("hbr.filter.shownLabel"),
                      value: filteredItems.length,
                      tone: "default",
                    },
                    {
                      label: t("hbr.footer.total"),
                      value: parsed.totalItems,
                    },
                    (() => {
                      const tr = activeTranslatedCount;
                      return {
                        label: t("hbr.footer.translated"),
                        value: `${tr} (${parsed.totalItems > 0
                          ? ((tr / parsed.totalItems) * 100).toFixed(1)
                          : "0.0"}%)`,
                        tone: "success" as const,
                      };
                    })(),
                    ...(activeItemIndex !== null && parsed.items[activeItemIndex]
                      ? [{
                          label: t("hbr.footer.position"),
                          value: `${activeItemIndex + 1}/${parsed.totalItems}`,
                          tone: "accent" as const,
                        }]
                      : []),
                  ]}
                />
              </>
            )}
          </section>

          {/* Right: Monaco editor для активного рядка */}
          <CorpusStatsModal
            open={statsOpen}
            onClose={() => setStatsOpen(false)}
            mode="hbr"
            computeCustomStats={async () => {
              // HBR parser-based stats з IPC + бонус manual markedTranslated
              // (інакше Огляд готовності не збігається з % у хедері — header
              // додає manual marks, IPC ні).
              const r = await window.dp2.hbrCorpusStats();
              if (!r.ok) return null;
              const base: CorpusStats = {
                files: r.files ?? 0,
                totalEntries: r.totalEntries ?? 0,
                translatedEntries: (r.translatedEntries ?? 0) + totalMarkedTranslated,
                percent: 0,
                uaWords: r.uaWords ?? 0,
                enWords: r.enWords ?? 0,
                uaChars: r.uaChars ?? 0,
                enChars: r.enChars ?? 0,
                topFiles: (r.topFiles ?? []).map((tf) => {
                  const extra = markedTranslatedByFile.get(tf.fileName) ?? 0;
                  const total = tf.total ?? 0;
                  const translated = (tf.translated ?? 0) + extra;
                  return {
                    ...tf,
                    translated,
                    percent: total > 0 ? +((translated / total) * 100).toFixed(2) : 0,
                  };
                }),
              };
              base.percent = base.totalEntries > 0
                ? +((base.translatedEntries / base.totalEntries) * 100).toFixed(2)
                : 0;
              return base;
            }}
          />
          <HbrFindReplaceModal
            open={findReplaceOpen}
            items={parsed?.items ?? null}
            onApply={(updates) => {
              if (!parsed) return;
              const items = parsed.items.slice();
              for (const u of updates) {
                items[u.idx] = { ...items[u.idx], current: u.next };
              }
              setParsed({ ...parsed, items });
              setDirty(true);
            }}
            onClose={() => setFindReplaceOpen(false)}
          />
          {!monacoCollapsed && (
            <HbrItemEditor
              item={activeItemIndex !== null && parsed ? parsed.items[activeItemIndex] : null}
              prev={activeItemIndex !== null && parsed && activeItemIndex > 0 ? parsed.items[activeItemIndex - 1] : null}
              next={activeItemIndex !== null && parsed && activeItemIndex < parsed.items.length - 1 ? parsed.items[activeItemIndex + 1] : null}
              onChange={(v) => activeItemIndex !== null && patchItem(activeItemIndex, v)}
              onJumpPrev={() => activeItemIndex !== null && activeItemIndex > 0 && setActiveItemIndex(activeItemIndex - 1)}
              onJumpNext={() => activeItemIndex !== null && parsed && activeItemIndex < parsed.items.length - 1 && setActiveItemIndex(activeItemIndex + 1)}
              onClose={() => setActiveItemIndex(null)}
            />
          )}
          {monacoCollapsed && (
            <button
              className="w-7 shrink-0 border-l border-[var(--border-soft)] text-[var(--text-faint)] hover:bg-[var(--row-hover)] hover:text-[var(--text)] flex flex-col items-center justify-center gap-1"
              onClick={() => setMonacoCollapsed(false)}
              title="Розгорнути pane редактора"
            >
              <span aria-hidden>◀</span>
              <span className="text-[9px] [writing-mode:vertical-rl] tracking-wider uppercase">Editor</span>
            </button>
          )}
        </div>
      )}

      {/* Стилізована модалка результату Pack — замість простого showAlert.
         Для tone використовуємо warning (жовтий) коли totalFields=0 чи є fails;
         success (зелений) для чистого pack'у. Steam appId 2286600 = HBR. */}
      {importDone && (() => {
        // Точно той самий формат, що в "Огляді готовності" (CorpusStatsModal):
        // pctNum для бара (з точкою), pctText для відображення.
        const pctNum = importDone.overall.total > 0
          ? +((importDone.overall.translated / importDone.overall.total) * 100).toFixed(2)
          : 0;
        const pctText = pctNum.toFixed(2).replace(".", ",");
        const tone = importDone.errors.length > 0 ? "warning" : "success";
        const accentRgba = tone === "warning" ? "217,119,6" : "34,197,94";
        const accentVar = tone === "warning" ? "var(--warning,#d97706)" : "var(--success)";
        return (
          <div
            className="fixed inset-0 z-40 bg-black/60 flex items-center justify-center p-6"
            onClick={() => setImportDone(null)}
          >
            <div
              className="w-full max-w-[600px] bg-[var(--bg-surface)] border border-[var(--border-soft)] rounded-xl shadow-2xl overflow-hidden"
              onClick={(e) => e.stopPropagation()}
            >
              <div
                className="relative px-8 pt-7 pb-6 text-center"
                style={{
                  background: `linear-gradient(135deg, rgba(${accentRgba},0.18) 0%, rgba(${accentRgba},0.05) 60%, transparent 100%)`,
                  borderBottom: "1px solid var(--border-soft)",
                }}
              >
                <div
                  className="inline-flex items-center justify-center w-14 h-14 rounded-full mb-3"
                  style={{
                    background: `radial-gradient(circle, rgba(${accentRgba},0.30), rgba(${accentRgba},0.05))`,
                    boxShadow: `0 0 22px -4px rgba(${accentRgba},0.45)`,
                  }}
                >
                  <svg className="w-7 h-7" fill="none" viewBox="0 0 24 24" stroke={accentVar} strokeWidth={2.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                  </svg>
                </div>
                <h2 className="text-[22px] font-bold text-[var(--text-strong)] mb-1" style={{ fontFamily: "'Playfair Display', Georgia, serif" }}>
                  {t("hbr.importDone.title")}
                </h2>
                <p className="text-[12.5px] text-[var(--text-muted)]">
                  {t("hbr.importDone.subtitle", { records: importDone.records, files: importDone.files.length })}
                </p>
              </div>

              {/* Overall progress */}
              <div className="px-6 py-5">
                <div className="rounded-lg border border-[var(--border-soft)] bg-[var(--bg)] px-4 py-3">
                  <div className="flex items-end justify-between mb-1.5">
                    <p className="text-[10px] uppercase tracking-wider text-[var(--text-faint)]">
                      {t("hbr.importDone.overall")}
                    </p>
                    <p className="text-[22px] font-bold tabular-nums leading-none text-[var(--success)]">
                      {pctText}%
                    </p>
                  </div>
                  <div className="h-2 rounded-full bg-[var(--bg-elevated)] overflow-hidden border border-[var(--border-soft)]">
                    <div className="h-full bg-[var(--success)] transition-all" style={{ width: `${Math.min(100, pctNum)}%` }} />
                  </div>
                  <p className="text-[11px] text-[var(--text-muted)] mt-1.5 tabular-nums">
                    {importDone.overall.translated.toLocaleString("uk-UA")} / {importDone.overall.total.toLocaleString("uk-UA")}
                  </p>
                </div>
              </div>

              {/* Updated files list */}
              <div className="px-6 pb-5">
                <p className="text-[10px] uppercase tracking-wider text-[var(--text-faint)] mb-2">
                  {t("hbr.importDone.filesUpdated", { n: importDone.files.length })}
                </p>
                {importDone.files.length === 0 ? (
                  <p className="text-[11.5px] text-[var(--text-muted)] italic">{t("hbr.importDone.empty")}</p>
                ) : (
                  <ul className="max-h-[200px] overflow-auto rounded-md border border-[var(--border-soft)] bg-[var(--bg)] divide-y divide-[var(--border-soft)]">
                    {importDone.files.map((f, i) => (
                      <li key={i} className="px-3 py-1.5 flex items-center justify-between gap-2 text-[11.5px]">
                        <span className="font-mono text-[var(--text)] truncate min-w-0 flex-1" title={f.name}>{f.name}</span>
                        <span className="tabular-nums text-[var(--success)] font-semibold shrink-0">
                          +{f.updated.toLocaleString("uk-UA")}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}

                {importDone.errors.length > 0 && (
                  <details className="mt-2 text-[11px]">
                    <summary className="cursor-pointer text-[var(--warning,#d97706)]">
                      {t("hbr.importDone.errorsSummary", { n: importDone.errors.length })}
                    </summary>
                    <ul className="mt-1.5 ml-4 list-disc text-[var(--text-muted)] space-y-0.5 max-h-[160px] overflow-auto">
                      {importDone.errors.slice(0, 30).map((e, i) => <li key={i}>{e}</li>)}
                    </ul>
                  </details>
                )}
              </div>

              <div className="px-6 pb-5 flex items-center justify-end gap-2 border-t border-[var(--border-soft)] pt-4">
                <button className="dp-btn dp-btn--primary" onClick={() => setImportDone(null)}>{t("btn.close")}</button>
              </div>
            </div>
          </div>
        );
      })()}

      {packSuccess && (() => {
        const hasFailures = packSuccess.failed > 0 || packSuccess.totalFields === 0;
        const accent = hasFailures ? "warning" : "success";
        const accentRgba = hasFailures ? "217,119,6" : "34,197,94";
        const accentVar = hasFailures ? "var(--warning,#d97706)" : "var(--success)";
        const sizeMb = packSuccess.bundleSize
          ? `${(packSuccess.bundleSize / 1024 / 1024).toFixed(1)} MB` : "—";
        return (
          <div
            className="fixed inset-0 z-40 bg-black/60 flex items-center justify-center p-6"
            onClick={() => setPackSuccess(null)}
          >
            <div
              className="w-full max-w-[600px] bg-[var(--bg-surface)] border border-[var(--border-soft)] rounded-xl shadow-2xl overflow-hidden"
              onClick={(e) => e.stopPropagation()}
            >
              {/* Hero band */}
              <div
                className="relative px-8 pt-7 pb-6 text-center"
                style={{
                  background: `linear-gradient(135deg, rgba(${accentRgba},0.18) 0%, rgba(${accentRgba},0.05) 60%, transparent 100%)`,
                  borderBottom: "1px solid var(--border-soft)",
                }}
              >
                <div
                  className="inline-flex items-center justify-center w-14 h-14 rounded-full mb-3"
                  style={{
                    background: `radial-gradient(circle, rgba(${accentRgba},0.30), rgba(${accentRgba},0.05))`,
                    boxShadow: `0 0 22px -4px rgba(${accentRgba},0.45)`,
                  }}
                >
                  {hasFailures ? (
                    <svg className="w-7 h-7" fill="none" viewBox="0 0 24 24" stroke={accentVar} strokeWidth={2.5}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01M10.29 3.86l-8.18 14.18A2 2 0 003.84 21h16.32a2 2 0 001.73-2.96L13.71 3.86a2 2 0 00-3.42 0z" />
                    </svg>
                  ) : (
                    <svg className="w-7 h-7" fill="none" viewBox="0 0 24 24" stroke={accentVar} strokeWidth={2.5}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                    </svg>
                  )}
                </div>
                <h2 className="text-[22px] font-bold text-[var(--text-strong)] mb-1" style={{ fontFamily: "'Playfair Display', Georgia, serif" }}>
                  {t(hasFailures ? "hbr.pack.success.titleWarn" : "hbr.pack.success.title")}
                </h2>
                <p className="text-[12.5px] text-[var(--text-muted)]">
                  {t(hasFailures ? "hbr.pack.success.subtitleWarn" : "hbr.pack.success.subtitle")}
                </p>
              </div>

              {/* Metrics grid 3-up */}
              <div className="grid grid-cols-3 gap-3 px-6 py-5">
                <div className="rounded-lg border border-[var(--border-soft)] bg-[var(--bg)] px-4 py-3">
                  <p className="text-[10px] uppercase tracking-wider text-[var(--text-faint)] mb-1">
                    {t("hbr.pack.success.metric.applied")}
                  </p>
                  <p className="text-[22px] font-bold text-[var(--success)] tabular-nums leading-none">
                    {packSuccess.applied.toLocaleString("uk-UA")}
                  </p>
                  <p className="text-[10.5px] text-[var(--text-muted)] mt-1.5">{t("hbr.pack.success.metric.mb")}</p>
                </div>
                <div className="rounded-lg border border-[var(--border-soft)] bg-[var(--bg)] px-4 py-3">
                  <p className="text-[10px] uppercase tracking-wider text-[var(--text-faint)] mb-1">
                    {t("hbr.pack.success.metric.fields")}
                  </p>
                  <p className="text-[22px] font-bold text-[var(--text-strong)] tabular-nums leading-none">
                    {packSuccess.totalFields.toLocaleString("uk-UA")}
                  </p>
                  <p className="text-[10.5px] text-[var(--text-muted)] mt-1.5">{t("hbr.pack.success.metric.fieldsHint")}</p>
                </div>
                <div className="rounded-lg border border-[var(--border-soft)] bg-[var(--bg)] px-4 py-3">
                  <p className="text-[10px] uppercase tracking-wider text-[var(--text-faint)] mb-1">
                    {t("hbr.pack.success.metric.failed")}
                  </p>
                  <p
                    className="text-[22px] font-bold tabular-nums leading-none"
                    style={{ color: packSuccess.failed > 0 ? "var(--warning,#d97706)" : "var(--text-strong)" }}
                  >
                    {packSuccess.failed.toLocaleString("uk-UA")}
                  </p>
                  <p className="text-[10.5px] text-[var(--text-muted)] mt-1.5">{t("hbr.pack.success.metric.failedHint")}</p>
                </div>
              </div>

              {/* Paths */}
              <div className="px-6 pb-5 space-y-2.5">
                {packSuccess.bundlePath && (
                  <div className="rounded-md border border-[var(--border-soft)] bg-[var(--bg)] px-3 py-2 flex items-start gap-3">
                    <span className="text-[10px] uppercase tracking-wider text-[var(--text-faint)] shrink-0 mt-0.5">
                      {t("hbr.pack.success.bundle", { size: sizeMb })}
                    </span>
                    <p className="text-[11px] font-mono text-[var(--text)] break-all flex-1 min-w-0" title={packSuccess.bundlePath}>
                      {packSuccess.bundlePath}
                    </p>
                  </div>
                )}
                {packSuccess.bakPath && (
                  <div className="rounded-md border border-[var(--border-soft)] bg-[var(--bg)] px-3 py-2 flex items-start gap-3">
                    <span className="text-[10px] uppercase tracking-wider text-[var(--text-faint)] shrink-0 mt-0.5">
                      {t("hbr.pack.success.bak")}
                    </span>
                    <p className="text-[11px] font-mono text-[var(--text-muted)] break-all flex-1 min-w-0" title={packSuccess.bakPath}>
                      {packSuccess.bakPath}
                    </p>
                  </div>
                )}
                {packSuccess.failedRows && packSuccess.failedRows.length > 0 && (
                  <details className="text-[11px]">
                    <summary className="cursor-pointer text-[var(--warning,#d97706)]">
                      {t("hbr.pack.success.failedSummary", { n: packSuccess.failedRows.length })}
                    </summary>
                    <ul className="mt-1.5 ml-4 list-disc text-[var(--text-muted)] space-y-0.5">
                      {packSuccess.failedRows.slice(0, 20).map((f, i) => (
                        <li key={i}><span className="font-mono">{f.name}</span> — {f.reason}</li>
                      ))}
                    </ul>
                  </details>
                )}
              </div>

              {/* Actions */}
              <div className="px-6 pb-5 flex flex-wrap items-center gap-2 border-t border-[var(--border-soft)] pt-4">
                <button
                  className="dp-btn"
                  onClick={() => {
                    if (!packSuccess.bundlePath) return;
                    const dir = packSuccess.bundlePath.replace(/[\\/][^\\/]+$/, "");
                    window.dp2.openFolder?.(dir);
                  }}
                  disabled={!packSuccess.bundlePath}
                >
                  <svg className="w-4 h-4 mr-1.5 inline" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-7l-2-2H5a2 2 0 00-2 2z" />
                  </svg>
                  {t("hbr.pack.success.openFolder")}
                </button>
                <div className="flex-1" />
                <button className="dp-btn" onClick={() => setPackSuccess(null)}>
                  {t("btn.close")}
                </button>
                <button
                  className={`dp-btn dp-btn--${accent === "success" ? "success" : "primary"}`}
                  style={{ boxShadow: `0 0 18px -4px rgba(${accentRgba},0.55)` }}
                  onClick={async () => {
                    try {
                      const w = window.dp2 as unknown as { launchSteamGame?: (id: string) => Promise<{ ok: boolean; error?: string }> };
                      if (w.launchSteamGame) await w.launchSteamGame("2286600");
                    } catch {}
                    setPackSuccess(null);
                  }}
                >
                  <svg className="w-4 h-4 mr-1.5 inline" fill="currentColor" viewBox="0 0 24 24">
                    <path d="M8 5v14l11-7z" />
                  </svg>
                  {t("hbr.pack.success.launchGame")}
                </button>
              </div>
            </div>
          </div>
        );
      })()}

      {/* Universal Ctrl+K palette + ? cheatsheet + migrate diff modal. */}
      <CommandPalette open={cmdOpen} onClose={() => setCmdOpen(false)} items={commandItems} />
      <HbrShortcutsModal open={shortcutsOpen} onClose={() => setShortcutsOpen(false)} />
      <HbrMigrateDiffModal
        open={diffOpen}
        onClose={() => setDiffOpen(false)}
        entries={diffEntries}
        oldBundle={migrateInfo?.oldBundle}
        newBundle={migrateInfo?.newBundle}
      />
      <GlossaryModal
        open={glossaryOpen}
        folder={status?.doneDir ?? null}
        onClose={() => setGlossaryOpen(false)}
      />
    </div>
  );
}
