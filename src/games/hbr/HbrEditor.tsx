import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useT } from "../../lib/i18n";
import { alert as showAlert } from "../../lib/dialogs";
import { applyCombinedToParsed, applyHbrEdits, formatHbrCombinedTxt, parseHbrCombinedTxt, parseHbrJson, validatePlaceholders, type HbrParsedFile, type HbrTextItem } from "./parser";
import { confirm as showConfirm } from "../../lib/dialogs";
import hbrHero from "../../ui-v2/assets/hbr-hero.jpg";

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
  const [search, setSearch] = useState("");
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
  const [fileStats, setFileStats] = useState<Record<string, { total: number; translated: number }>>({});
  // Фільтри для рядків — як у DP2 («не перекл / перекл / збігаються»).
  type RowFilter = "all" | "untranslated" | "translated" | "samesAsOriginal";
  const [rowFilter, setRowFilter] = useState<RowFilter>("all");
  // ПКМ-меню над рядком АБО файлом.
  type CtxRow = { kind: "row"; x: number; y: number; itemIndex: number };
  type CtxFile = { kind: "file"; x: number; y: number; file: FileItem };
  const [ctxMenu, setCtxMenu] = useState<CtxRow | CtxFile | null>(null);
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

  // Прогрес паку у гру — той же файл-лог + live.
  useEffect(() => {
    const w = window.dp2 as unknown as { onHbrPackProgress?: (cb: (l: string) => void) => () => void };
    if (!w.onHbrPackProgress) return;
    const off = w.onHbrPackProgress((line) => setPackLog((p) => [...p.slice(-300), line]));
    return () => { if (typeof off === "function") off(); };
  }, []);

  async function refreshFiles() {
    const w = window.dp2 as unknown as { hbrTextList: () => Promise<{ ok: boolean; items: FileItem[] }> };
    const r = await w.hbrTextList();
    if (r.ok) setFiles(r.items);
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
      setPhase("preparing");
      let s = await w.hbrTextPrepStatus();
      setStatus(s);
      if (!s.ok) { setErrorMsg(s.error || "status fail"); setPhase("error"); return; }

      // Якщо текст уже витягнуто з минулого запуску — позначаємо перші три
      // кроки як skipped і одразу йдемо у mirroring/ready.
      if (s.originalCount) {
        setSteps({
          tool: "skipped", catalog: "skipped",
          extract: "skipped",
          mirror: ((s.doneCount ?? 0) >= (s.originalCount ?? 0)) ? "skipped" : "pending",
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
    if (dirty) {
      const ok = await new Promise<boolean>((resolve) => {
        showAlert(t("hbr.editor.unsavedTitle"), t("hbr.editor.unsavedBody"), { tone: "danger" }).then(() => resolve(true));
      });
      if (!ok) return;
    }
    setActiveFile(f);
    setParsed(null);
    setDirty(false);
    try {
      const w = window.dp2 as unknown as { hbrTextRead: (p: string) => Promise<{ ok: boolean; raw?: string; error?: string }> };
      const doneRes = await w.hbrTextRead(f.donePath);
      if (!doneRes.ok || !doneRes.raw) throw new Error(doneRes.error || "read fail");
      const origRes = await w.hbrTextRead(f.origPath);
      const p = parseHbrJson(doneRes.raw, origRes.ok ? origRes.raw! : null, f.donePath, f.origPath);
      setParsed(p);
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
      setDirty(false);
    } catch (e: unknown) {
      await showAlert(t("hbr.editor.saveErrTitle"), String((e as Error)?.message ?? e), { tone: "danger" });
    } finally {
      setSaving(false);
    }
  }

  // Ctrl+S
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        saveActive();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [parsed, activeFile, saving]);

  // Загальні лічильники по всьому проекту (Done vs Original).
  const [projectStats, setProjectStats] = useState<{ files: number; total: number; translated: number } | null>(null);
  const [packLog, setPackLog] = useState<string[]>([]);
  const [packing, setPacking] = useState(false);
  async function refreshProjectStats() {
    if (!files.length) { setProjectStats(null); setFileStats({}); return; }
    const w = window.dp2 as unknown as { hbrTextRead: (p: string) => Promise<{ ok: boolean; raw?: string }> };
    let total = 0, translated = 0;
    const perFile: Record<string, { total: number; translated: number }> = {};
    for (const f of files) {
      try {
        const doneRes = await w.hbrTextRead(f.donePath);
        const origRes = await w.hbrTextRead(f.origPath);
        if (!doneRes.ok || !doneRes.raw) continue;
        const p = parseHbrJson(doneRes.raw, origRes.ok ? origRes.raw! : null, f.donePath, f.origPath);
        total += p.totalItems;
        translated += p.translatedItems;
        perFile[f.file] = { total: p.totalItems, translated: p.translatedItems };
      } catch {}
    }
    setProjectStats({ files: files.length, total, translated });
    setFileStats(perFile);
  }
  useEffect(() => { if (phase === "ready") refreshProjectStats();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, files.length]);

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
      let okFiles = 0, totalUpdated = 0;
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
          const newRaw = applyHbrEdits(doneRes.raw, parsedFile.items);
          const wr = await w.hbrTextWrite({ fullPath: fileItem.donePath, raw: newRaw });
          if (!wr.ok) { errors.push(`Не вдалося записати ${block.fileName}: ${wr.error}`); continue; }
          okFiles++;
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
      const tone: "danger" | "success" = errors.length > 0 ? "danger" : "success";
      const body = `${t("hbr.combined.importDoneBody", { files: okFiles, records: totalUpdated })}${errors.length ? "\n\n" + errors.slice(0, 30).join("\n") : ""}`;
      await showAlert(t("hbr.combined.importDoneTitle"), body, { tone });
    } catch (e: unknown) {
      await showAlert(t("hbr.combined.importErrTitle"), String((e as Error)?.message ?? e), { tone: "danger" });
    } finally { setSaving(false); }
  }

  async function packIntoGame() {
    const ok = await showConfirm(t("hbr.pack.confirmTitle"), t("hbr.pack.confirmBody"), { tone: "danger", okLabel: t("hbr.pack.confirmOk") });
    if (!ok) return;
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
      };
      const r = await w.hbrPackIntoGame();
      if (!r.ok) {
        const logHint = r.logPath ? `\n\n${t("hbr.pack.logSaved", { path: r.logPath })}` : "";
        await showAlert(t("hbr.pack.errTitle"), (r.error ?? "?") + logHint, { tone: "danger" });
        return;
      }
      const applied = r.summary?.applied ?? 0;
      const failed = r.summary?.failed?.length ?? 0;
      const totalFields = r.totalFields ?? 0;
      const sizeKb = r.bundleSize ? `${(r.bundleSize / 1024 / 1024).toFixed(1)} MB` : "—";
      const lines: string[] = [];
      lines.push(t("hbr.pack.doneBody", { applied, failed }));
      lines.push("");
      lines.push(t("hbr.pack.summary.fields", { n: totalFields }));
      if (r.bundlePath) lines.push(t("hbr.pack.summary.bundle", { path: r.bundlePath, size: sizeKb }));
      if (r.bakPath) lines.push(t("hbr.pack.summary.bak", { path: r.bakPath }));
      if (r.logPath) lines.push(t("hbr.pack.logSaved", { path: r.logPath }));
      if (totalFields === 0) {
        lines.push("");
        lines.push(t("hbr.pack.warn.noFields"));
      }
      if (failed > 0) {
        lines.push("");
        lines.push(...r.summary!.failed!.slice(0, 10).map((f) => `• ${f.name}: ${f.reason}`));
      }
      await showAlert(
        t("hbr.pack.doneTitle"),
        lines.join("\n"),
        { tone: failed > 0 || totalFields === 0 ? "danger" : "success" }
      );
    } finally {
      setSaving(false);
      setPacking(false);
    }
  }

  const filteredItems = useMemo(() => {
    if (!parsed) return [];
    const q = search.trim().toLowerCase();
    return parsed.items.filter((it) => {
      // Статус-фільтр: визначаємо isTranslated як у parseHbrJson:
      // current !== original AND current не порожній.
      const isSame = it.current === it.original;
      const isEmpty = !it.current || it.current.trim().length === 0;
      const isTranslated = !isSame && !isEmpty;
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
  }, [parsed, search, rowFilter]);

  return (
    <div className="flex-1 flex flex-col bg-[var(--bg)] min-h-0">
      <header className="h-12 px-4 border-b border-[var(--border-soft)] bg-[var(--bg-surface)] flex items-center gap-2 shrink-0">
        <button className="dp-btn dp-btn--ghost" onClick={onHome} title={t("header.home")}>←</button>
        <span className="text-[13px] font-semibold text-[var(--text-strong)] truncate">Hotel Barcelona · Text</span>
        {projectStats && (
          <span className="text-[11px] text-[var(--text-faint)] font-mono tabular-nums">
            {projectStats.translated.toLocaleString("uk-UA")}/{projectStats.total.toLocaleString("uk-UA")}
            {projectStats.total > 0 && (
              <span className="ml-1 text-[var(--text-muted)]">
                · {((projectStats.translated / projectStats.total) * 100).toFixed(1)}%
              </span>
            )}
          </span>
        )}
        <div className="flex-1" />
        {phase === "ready" && (
          <>
            <button className="dp-btn dp-btn--ghost" disabled={saving || !files.length} onClick={exportCombined} title={t("hbr.combined.exportBtnHint")}>
              {t("hbr.combined.exportBtn")}
            </button>
            <button className="dp-btn dp-btn--ghost" disabled={saving || !files.length} onClick={importCombined} title={t("hbr.combined.importBtnHint")}>
              {t("hbr.combined.importBtn")}
            </button>
            <button className="dp-btn dp-btn--success" disabled={saving || !files.length} onClick={packIntoGame} title={t("hbr.pack.btnHint")}>
              {t("hbr.pack.btn")}
            </button>
          </>
        )}
        {parsed && (
          <>
            <span className="text-[11px] text-[var(--text-faint)] font-mono truncate max-w-[280px]">{parsed.fileName}</span>
            <button
              className={`dp-btn ${dirty ? "dp-btn--primary" : ""}`}
              onClick={saveActive}
              disabled={!dirty || saving}
              title="Ctrl+S"
            >
              {saving ? t("hbr.editor.saving") : t("hbr.editor.save")}
            </button>
          </>
        )}
      </header>

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

      {packing && (
        <div className="fixed inset-0 z-40 bg-black/60 flex items-center justify-center p-6">
          <div className="w-full max-w-[720px] bg-[var(--bg-surface)] border border-[var(--border-soft)] rounded-lg shadow-xl">
            <div className="px-5 py-3 border-b border-[var(--border-soft)] flex items-center gap-3">
              <span className="inline-block h-3 w-3 rounded-full border-2 border-[var(--accent)] border-t-transparent animate-spin" />
              <p className="text-[13px] font-semibold text-[var(--text-strong)]">{t("hbr.pack.runningTitle")}</p>
              <span className="ml-auto text-[10.5px] tabular-nums text-[var(--text-faint)]">
                {packLog.filter((l) => l.startsWith("[PATCHED]")).length} {t("hbr.pack.patched")}
              </span>
            </div>
            <div className="p-3">
              <pre className="text-[10.5px] font-mono text-[var(--text-faint)] bg-[var(--bg)] border border-[var(--border-soft)] rounded p-2 max-h-[300px] overflow-y-auto whitespace-pre-wrap break-all">
                {packLog.slice(-30).join("\n") || t("hbr.pack.starting")}
              </pre>
            </div>
          </div>
        </div>
      )}

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
          {ctxMenu.kind === "row" && parsed && (
            <>
              <li
                className="px-3 py-1.5 hover:bg-[var(--row-hover)] cursor-pointer"
                onClick={() => {
                  const it = parsed.items[ctxMenu.itemIndex];
                  if (it) patchItem(ctxMenu.itemIndex, it.original);
                  setCtxMenu(null);
                }}
              >
                {t("hbr.ctx.restoreOriginal")}
              </li>
              <li
                className="px-3 py-1.5 hover:bg-[var(--row-hover)] cursor-pointer"
                onClick={() => {
                  const it = parsed.items[ctxMenu.itemIndex];
                  if (it) patchItem(ctxMenu.itemIndex, "");
                  setCtxMenu(null);
                }}
              >
                {t("hbr.ctx.clearTranslation")}
              </li>
              <li
                className="px-3 py-1.5 hover:bg-[var(--row-hover)] cursor-pointer"
                onClick={async () => {
                  const it = parsed.items[ctxMenu.itemIndex];
                  if (it) { try { await navigator.clipboard.writeText(it.original); } catch {} }
                  setCtxMenu(null);
                }}
              >
                {t("hbr.ctx.copyOriginal")}
              </li>
            </>
          )}
          {ctxMenu.kind === "file" && (
            <>
              <li className="px-3 py-1 text-[10px] uppercase tracking-wider text-[var(--text-faint)] border-b border-[var(--border-soft)] truncate" title={ctxMenu.file.file}>
                {ctxMenu.file.file}
              </li>
              <li
                className="px-3 py-1.5 hover:bg-[var(--row-hover)] cursor-pointer"
                onClick={() => { restoreFileFromBak(ctxMenu.file); setCtxMenu(null); }}
              >
                {t("hbr.ctx.restoreFromBak")}
              </li>
              <li
                className="px-3 py-1.5 hover:bg-[var(--row-hover)] cursor-pointer"
                onClick={() => { restoreFileFromOriginal(ctxMenu.file); setCtxMenu(null); }}
              >
                {t("hbr.ctx.restoreOriginal")}
              </li>
              <li
                className="px-3 py-1.5 hover:bg-[var(--row-hover)] cursor-pointer"
                onClick={async () => {
                  const w = window.dp2 as unknown as { openFolder?: (p: string) => void };
                  if (w.openFolder) w.openFolder(ctxMenu.file.donePath.replace(/[\\/][^\\/]+$/, ""));
                  setCtxMenu(null);
                }}
              >
                {t("hbr.ctx.openFolder")}
              </li>
            </>
          )}
        </ul>
      )}

      {phase === "ready" && (
        <div className="flex-1 flex min-h-0">
          {/* Left: file list */}
          <aside className="w-[300px] shrink-0 border-r border-[var(--border-soft)] flex flex-col">
            <div className="px-3 py-2 border-b border-[var(--border-soft)] text-[10px] uppercase tracking-wider text-[var(--text-faint)] font-semibold">
              {t("hbr.editor.fileTree")} · {files.length}
            </div>
            <div className="flex-1 overflow-y-auto">
              {files.map((f) => {
                const st = fileStats[f.file];
                const pct = st && st.total > 0 ? Math.round((st.translated / st.total) * 100) : 0;
                const isActive = activeFile?.donePath === f.donePath;
                return (
                  <button
                    key={f.donePath}
                    onClick={() => openFile(f)}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      setCtxMenu({ kind: "file", x: e.clientX, y: e.clientY, file: f });
                    }}
                    className={`w-full text-left px-3 py-2 border-b border-[var(--border-soft)] hover:bg-[var(--row-hover)] ${
                      isActive ? "bg-[var(--row-active)]" : ""
                    }`}
                  >
                    <p className="text-[11.5px] font-mono text-[var(--text)] truncate" title={f.file}>{f.file}</p>
                    {st && (
                      <div className="flex items-center gap-2 mt-1">
                        <div className="flex-1 h-1 bg-[var(--bg-elevated)] rounded overflow-hidden">
                          <div
                            className="h-full bg-[var(--success)]"
                            style={{ width: `${pct}%` }}
                          />
                        </div>
                        <span className="text-[10px] font-mono tabular-nums text-[var(--text-faint)] shrink-0">
                          {st.translated}/{st.total} · {pct}%
                        </span>
                      </div>
                    )}
                  </button>
                );
              })}
            </div>
          </aside>

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
                      value={search}
                      onChange={(e) => setSearch(e.target.value)}
                    />
                    <span className="text-[11px] text-[var(--text-faint)] tabular-nums">
                      {parsed.translatedItems}/{parsed.totalItems} · {parsed.totalItems > 0 ? ((parsed.translatedItems / parsed.totalItems) * 100).toFixed(1) : "0.0"}%
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
                  <table className="w-full text-[12px]">
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
                        const realIdx = parsed.items.indexOf(it);
                        const isSame = it.current === it.original;
                        const isEmpty = !it.current || it.current.trim().length === 0;
                        const isTranslated = !isSame && !isEmpty;
                        // Підсвічування: перекладено — м'який зелений лівий border;
                        // збігається з оригіналом — жовтий; порожній — червоний.
                        const borderClass = isEmpty
                          ? "border-l-2 border-l-[var(--danger)]"
                          : isTranslated
                          ? "border-l-2 border-l-[var(--success)]"
                          : "border-l-2 border-l-[var(--warning)]";
                        return (
                          <tr
                            key={realIdx}
                            className={`border-b border-[var(--border-soft)] align-top ${borderClass}`}
                            onContextMenu={(e) => {
                              e.preventDefault();
                              e.stopPropagation();
                              setCtxMenu({ kind: "row", x: e.clientX, y: e.clientY, itemIndex: realIdx });
                            }}
                          >
                            <td className="px-2 py-1 font-mono text-[11px] text-[var(--text-muted)]">
                              {it.textId}
                            </td>
                            <td className="px-2 py-1 font-mono text-[11px] text-[var(--text-faint)] tabular-nums">{it.variantIdx}</td>
                            <td className="px-2 py-1 text-[var(--text-muted)] whitespace-pre-wrap">{it.original}</td>
                            <td className="px-2 py-1">
                              <textarea
                                className="w-full bg-[var(--bg)] border border-[var(--border-soft)] rounded px-2 py-1 text-[12px] text-[var(--text)] resize-vertical min-h-[56px] whitespace-pre-wrap break-words leading-snug"
                                style={{ fieldSizing: "content" } as React.CSSProperties}
                                value={it.current}
                                onChange={(e) => patchItem(realIdx, e.target.value)}
                                onInput={(e) => {
                                  // Fallback auto-resize якщо field-sizing не підтримується.
                                  const el = e.currentTarget;
                                  el.style.height = "auto";
                                  el.style.height = Math.max(56, Math.min(400, el.scrollHeight)) + "px";
                                }}
                                ref={(el) => {
                                  // Підлаштовуємо висоту при першому рендері.
                                  if (!el) return;
                                  el.style.height = "auto";
                                  el.style.height = Math.max(56, Math.min(400, el.scrollHeight)) + "px";
                                }}
                              />
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </section>
        </div>
      )}
    </div>
  );
}
