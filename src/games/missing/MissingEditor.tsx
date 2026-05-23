// THE MISSING — текстовий редактор.
// Архітектура повторює TGL/HBR:
//   1. Перевірка prep-status (resources.assets, Original-кількість).
//   2. Extract (PowerShell, AssetsTools.NET) у Original/ — сирі m_Script.dat.
//   3. Список файлів зліва, активний у середині — таблиця рядків.
//   4. Edit рядка → Monaco/textarea, save → IPC write у Done/.
//   5. Pack → PowerShell вставляє Done/-файли назад у resources.assets.

import { useEffect, useMemo, useRef, useState } from "react";
import { useT } from "../../lib/i18n";
import { alert as dpAlert, confirm as dpConfirm } from "../../lib/dialogs";
import { parseMissingMsg, parseMissingMsgCached, invalidateMissingMsgCache, buildMissingMsg, type MissingMsgFile, type MissingMsgEntry } from "./parser";
import { parseMissingHeightInfo, buildMissingHeightInfo, buildHeightInfoIndex, type MissingHeightInfo } from "./heightinfo";
import { useLocalStorage } from "../../lib/useLocalStorage";
import { MissingItemEditor, type MissingActiveItem } from "./MissingItemEditor";
import { CorpusStatsModal } from "../../components/CorpusStatsModal";
import { MissingLintModal } from "./MissingLintModal";
import { MissingGlobalSearchModal } from "./MissingGlobalSearchModal";
import { MissingAutoFitModal } from "./MissingAutoFitModal";
import { MissingDllEditor } from "./MissingDllEditor";
import { EditorFooter } from "../../components/EditorFooter";
import { LangToggle } from "../../components/LangToggle";
import { showError, showOk, showToast } from "../../components/Toast";
import type { CorpusStats } from "../../lib/ipc";
import { MissingShortcutsModal } from "./MissingShortcutsModal";
import { HeaderProgress } from "../../components/HeaderProgress";
import { HeaderMenu, type MenuItem } from "../../components/HeaderMenu";
import { MissingFileSidebar } from "./MissingFileSidebar";
import { HighlightedText } from "../../components/HighlightedText";
import { VirtualRows } from "./VirtualRows";
import { CommandPalette, type CommandItem } from "../../components/CommandPalette";

interface Props { onHome: () => void; }

interface PrepStatus {
  ok: boolean;
  assetsPath?: string | null;
  assetsOk?: boolean;
  metaExists?: boolean;
  originalCount?: number;
  doneCount?: number;
  error?: string;
}

interface FileItem {
  name: string;
  file: string;
  pathId: string;
  scriptLen: number;
  origPath: string;
  donePath: string;
  hasOrig: boolean;
  hasDone: boolean;
}

type Phase = "loading" | "needs-extract" | "ready" | "extracting" | "error";

interface RowMeta {
  status?: "draft" | "review" | "approved";
  bookmark?: boolean;
  /** Manual override: рядок не змінювали (бо `:)` чи інший emoji не
   *  потребує перекладу), але рахуємо його як перекладений у статистиці. */
  markedTranslated?: boolean;
}

interface MissingApi {
  missingPrepStatus: () => Promise<PrepStatus>;
  missingPrepExtract: () => Promise<{ ok: boolean; error?: string; summary?: { total: number } }>;
  missingTextList: () => Promise<{ ok: boolean; items: FileItem[] }>;
  missingTextRead: (path: string) => Promise<{ ok: boolean; base64?: string; error?: string }>;
  missingTextWrite: (payload: { fullPath: string; base64: string }) => Promise<{ ok: boolean; error?: string }>;
  missingPack: () => Promise<{ ok: boolean; error?: string; summary?: { applied: number; failed: unknown[] } }>;
  missingTextMetaRead: () => Promise<{ ok: boolean; rows: Record<string, RowMeta> }>;
  missingTextMetaWrite: (payload: { rows: Record<string, RowMeta> }) => Promise<{ ok: boolean; error?: string }>;
  missingBoxsizeExtract: () => Promise<{ ok: boolean; error?: string; outFile?: string }>;
  missingBoxsizeRead: () => Promise<{ ok: boolean; error?: string; base64?: string; source?: string }>;
  missingBoxsizeSave: (payload: { base64: string }) => Promise<{ ok: boolean; error?: string; file?: string }>;
  missingBoxsizePack: () => Promise<{ ok: boolean; error?: string; skipped?: boolean }>;
  missingDllDialogFix: () => Promise<{ ok: boolean; error?: string; summary?: { applied: number } }>;
  missingDllDialogFixRevert: () => Promise<{ ok: boolean; error?: string }>;
  missingDllDialogFixStatus: () => Promise<{ ok: boolean; summary?: { patched: boolean; ballon: boolean; ballonController: boolean; wordWrap: boolean; bakExists: boolean } }>;
  missingUiTextExport: (payload?: { outFile?: string; includeNonAscii?: boolean }) => Promise<{ ok: boolean; error?: string; outFile?: string; summary?: { entries: number } }>;
  missingUiTextImport: (payload?: { inFile?: string }) => Promise<{ ok: boolean; error?: string; inFile?: string; summary?: { applied: number; skippedSame: number; missing: number } }>;
  missingUiTextImportInline: (payload: { content: string }) => Promise<{ ok: boolean; error?: string; summary?: { applied: number; skippedSame: number; missing: number } }>;
  launchUabea: () => Promise<{ success: boolean; error?: string }>;
  onMissingPrepProgress: (cb: (line: string) => void) => () => void;
  onMissingPackProgress: (cb: (line: string) => void) => () => void;
  pickSaveFile: (opts: { title?: string; defaultPath?: string; filters?: Array<{ name: string; extensions: string[] }> }) => Promise<string | null>;
  pickFile: (opts: { title?: string; filters?: Array<{ name: string; extensions: string[] }> }) => Promise<string | null>;
  readFile: (path: string) => Promise<string | null>;
  writeFile: (path: string, content: string) => Promise<boolean>;
}
const W = window.dp2 as unknown as MissingApi;

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function bytesToB64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

export function MissingEditor({ onHome }: Props) {
  const t = useT();
  const [phase, setPhase] = useState<Phase>("loading");
  const [errMsg, setErrMsg] = useState<string | null>(null);
  const [status, setStatus] = useState<PrepStatus | null>(null);
  const [files, setFiles] = useState<FileItem[]>([]);
  const [activeFile, setActiveFile] = useState<FileItem | null>(null);
  // Розпарсений активний файл — original (з Original/) + done (з Done/ або клон).
  const [origMsg, setOrigMsg] = useState<MissingMsgFile | null>(null);
  const [doneMsg, setDoneMsg] = useState<MissingMsgFile | null>(null);
  // Поточні переклади — map<index, text> поверх doneMsg.entries.
  const [edits, setEdits] = useState<Map<number, string>>(new Map());
  const [activeIdx, setActiveIdx] = useState<number | null>(null);
  const [progressLines, setProgressLines] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [packing, setPacking] = useState(false);
  // Пошук — фільтрує рядки активного файлу по тексту (Original або Translation).
  // searchDraft — миттєвий input, search — debounced на 150мс щоб не лагало.
  const [searchDraft, setSearchDraft] = useState("");
  const [search, setSearch] = useState("");
  useEffect(() => {
    if (searchDraft === search) return;
    const id = setTimeout(() => setSearch(searchDraft), 150);
    return () => clearTimeout(id);
  }, [searchDraft, search]);
  const [exporting, setExporting] = useState(false);
  const [importing, setImporting] = useState(false);
  // HBR-style row filter pills.
  type RowFilter = "all" | "untranslated" | "translated" | "same" | "placeholder" | "bookmarks";
  const [rowFilter, setRowFilter] = useState<RowFilter>("all");
  // Включити плейсхолдери (NO_TEXT_en, V_*) у total/перекладено. За замовч. —
  // false (вони не є реальними рядками для перекладу).
  const [includePlaceholders, setIncludePlaceholders] = useState(false);
  // Status + bookmark per row. Ключ = MsgEnum (стабільний глобально).
  // Зберігається у Meta/status.json через missingTextMetaRead/Write.
  const [rowMeta, setRowMeta] = useState<Record<string, RowMeta>>({});
  const rowMetaDirtyRef = useRef(false);
  // Right-click контекстне меню.
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; idx: number; msgEnum: number } | null>(null);
  // Lint + global search модалки.
  const [lintOpen, setLintOpen] = useState(false);
  const [searchAllOpen, setSearchAllOpen] = useState(false);
  // Autosave / dirty indicator.
  const [lastSavedAt, setLastSavedAt] = useState<number | null>(null);
  const dirty = edits.size > 0;
  // IMHeightInfo (box-sizes) — модифікуємо in-memory, debounced save у Done/.
  const [heightInfo, setHeightInfo] = useState<MissingHeightInfo | null>(null);
  // Окремий нерухомий snapshot з Meta — потрібен Auto-fit'у як baseline,
  // інакше повторні apply мультиплікативно нарощують W (origW стає newW
  // після save → наступний apply множить нове W на ratio*padding).
  const [heightInfoOriginal, setHeightInfoOriginal] = useState<MissingHeightInfo | null>(null);
  const [heightInfoIdx, setHeightInfoIdx] = useState<Map<number, number>>(new Map());
  const heightInfoDirtyRef = useRef(false);
  const [extractingBox, setExtractingBox] = useState(false);
  // Цільовий мовний слот — куди користувач пише переклад. За замовч. L0 (EN).
  // У грі англійська локалізація читає, ймовірно, слот 0; UA-переклад
  // підмінює EN, тож box-розміри теж пишемо у L0.
  const [targetLang, setTargetLang] = useLocalStorage<number>("missing.ui.targetLang", 0);
  const [autoFitOpen, setAutoFitOpen] = useState(false);
  const [dllOpen, setDllOpen] = useState(false);
  // DLL dialog-fix status: чи Ballon/BallonController вже патчені на
  // SizeControlType=UseTextInfo. Перевіряємо при кожному відкритті
  // редактора + після того як модалка DLL закривається (бо там можна
  // натиснути «Виправити»/«Відкотити»).
  const [dialogFixPatched, setDialogFixPatched] = useState<boolean | null>(null);
  const [dialogFixBusy, setDialogFixBusy] = useState(false);
  const [dialogFixDismissed, setDialogFixDismissed] = useLocalStorage<boolean>("missing.ui.dialogFixDismissed", false);
  // Per-file stats (для прогрес-бара у file-list).
  const [fileStats, setFileStats] = useState<Record<string, { total: number; translated: number }>>({});
  // Стрим логу від PS pack-скрипта (для прогрес-модалки).
  const [packLog, setPackLog] = useState<string[]>([]);
  // Зведена статистика по всіх файлах (для рендера у header).
  const [projectStats, setProjectStats] = useState<{ files: number; total: number; translated: number } | null>(null);
  // Stats-overview modal (HBR-style — total + 8 metric cards + top files).
  const [statsOpen, setStatsOpen] = useState(false);
  // UX-state: командна палітра (Ctrl+K) + cheatsheet (?) + collapse правого
  // pane (Monaco). LocalStorage щоб користувач не перевідкривав щоразу.
  const [cmdOpen, setCmdOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [monacoCollapsed, setMonacoCollapsed] = useLocalStorage<boolean>("missing.ui.monacoCollapsed", false);
  // Pack-success модалка (HBR-style — hero + metrics + paths + actions).
  const [packSuccess, setPackSuccess] = useState<null | {
    applied: number;
    skipped: number;      // у нашій термінології — файли без перекладу (PS-failed з reason "Done file missing")
    realFailed: number;   // справжні фейли (PathID not found тощо)
    assetsPath: string;
    bakPath: string;
    assetsSize: number;
    bakSize: number;
    failedRows: Array<{ name: string; reason: string }>;
  }>(null);

  async function refreshStatus() {
    const s = await W.missingPrepStatus();
    setStatus(s);
    if (!s.ok) { setPhase("error"); setErrMsg(s.error || "?"); return s; }
    if (!s.assetsOk) { setPhase("error"); setErrMsg(`resources.assets не знайдено: ${s.assetsPath || "missingRoot не задано у налаштуваннях"}`); return s; }
    if (!s.metaExists || (s.originalCount ?? 0) === 0) { setPhase("needs-extract"); return s; }
    return s;
  }

  async function refreshFiles() {
    const r = await W.missingTextList();
    if (r.ok) setFiles(r.items);
  }

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const s = await refreshStatus();
      if (cancelled) return;
      if (s.ok && s.assetsOk && s.metaExists && (s.originalCount ?? 0) > 0) {
        await refreshFiles();
        // Завантажуємо статуси+закладки одразу разом із файлами.
        try {
          const meta = await W.missingTextMetaRead();
          if (!cancelled && meta.ok) setRowMeta(meta.rows ?? {});
        } catch {}
        setPhase("ready");
      }
    })();
    const offPrep = W.onMissingPrepProgress((line) => setProgressLines((prev) => [...prev.slice(-40), line]));
    const offPack = W.onMissingPackProgress((line) => setPackLog((prev) => [...prev.slice(-300), line]));
    return () => { cancelled = true; offPrep?.(); offPack?.(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Autosave: тихо зберігаємо edits через 20с після останньої правки.
  // Якщо у юзера unsaved changes і він закриває файл — автозберігаємо одразу.
  useEffect(() => {
    if (edits.size === 0) return;
    const id = setTimeout(() => { saveFile(); }, 20_000);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [edits]);

  // Ctrl+Shift+F — глобальний пошук, Ctrl+B — bookmark, Ctrl+K — палітра,
  // ? — cheatsheet, Ctrl+S — save, цифри 0-3 у фокусі таблиці → row status.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const ctrl = e.ctrlKey || e.metaKey;
      const target = e.target as HTMLElement;
      const inMonaco = target.closest(".monaco-editor") !== null;
      const inInput = target.closest("input, textarea") !== null;
      // Ctrl+K — командна палітра.
      if (ctrl && !e.shiftKey && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setCmdOpen(true);
        return;
      }
      // ? — cheatsheet (без модифікаторів, поза інпутом).
      if (!ctrl && !e.shiftKey && e.key === "?" && !inMonaco && !inInput) {
        e.preventDefault();
        setShortcutsOpen(true);
        return;
      }
      // Ctrl+S — save active file.
      if (ctrl && !e.shiftKey && e.key.toLowerCase() === "s") {
        e.preventDefault();
        void saveFile();
        return;
      }
      if (ctrl && e.shiftKey && e.key.toLowerCase() === "f") {
        e.preventDefault();
        setSearchAllOpen(true);
        return;
      }
      if (ctrl && !e.shiftKey && e.key.toLowerCase() === "b" && !inMonaco && !inInput) {
        if (activeIdx !== null && origMsg && activeFile) {
          e.preventDefault();
          const enumN = origMsg.entries[activeIdx]?.msgEnum ?? -1;
          const key = getMetaKey(enumN, activeFile.name, activeIdx);
          patchRowMeta(key, { bookmark: !rowMeta[key]?.bookmark });
        }
        return;
      }
      // Цифрові clavishi у активному рядку — швидкий статус.
      if (!ctrl && !e.shiftKey && !inMonaco && !inInput && activeIdx !== null && origMsg && activeFile) {
        const map: Record<string, "draft" | "review" | "approved" | undefined> = {
          "1": "draft", "2": "review", "3": "approved", "0": undefined,
        };
        if (e.key in map) {
          e.preventDefault();
          const enumN = origMsg.entries[activeIdx]?.msgEnum ?? -1;
          const key = getMetaKey(enumN, activeFile.name, activeIdx);
          patchRowMeta(key, { status: map[e.key] });
          return;
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeIdx, origMsg, activeFile, rowMeta]);

  // Persist rowMeta (debounced 1с після правки).
  useEffect(() => {
    if (!rowMetaDirtyRef.current) return;
    const id = setTimeout(() => {
      rowMetaDirtyRef.current = false;
      W.missingTextMetaWrite({ rows: rowMeta }).catch(() => {});
    }, 1000);
    return () => clearTimeout(id);
  }, [rowMeta]);

  // Завантажуємо IMHeightInfo один раз після того, як файли готові.
  // Паралельно тягнемо нерухомий Original (Meta/heightinfo.bin) як reference
  // для Auto-fit — без нього алгоритм мультиплікативний на повторні apply.
  useEffect(() => {
    if (phase !== "ready") return;
    let cancelled = false;
    (async () => {
      const Wext = window.dp2 as unknown as {
        missingBoxsizeReadOriginal?: () => Promise<{ ok: boolean; base64?: string }>;
      };
      const [r, rOrig] = await Promise.all([
        W.missingBoxsizeRead(),
        Wext.missingBoxsizeReadOriginal ? Wext.missingBoxsizeReadOriginal() : Promise.resolve({ ok: false, base64: undefined }),
      ]);
      if (cancelled) return;
      if (r.ok && r.base64) {
        try {
          const bin = Uint8Array.from(atob(r.base64), (c) => c.charCodeAt(0));
          const info = parseMissingHeightInfo(bin);
          setHeightInfo(info);
          setHeightInfoIdx(buildHeightInfoIndex(info));
        } catch (e) {
          console.warn("Failed to parse IMHeightInfo:", e);
        }
      }
      if (rOrig.ok && rOrig.base64) {
        try {
          const binO = Uint8Array.from(atob(rOrig.base64), (c) => c.charCodeAt(0));
          setHeightInfoOriginal(parseMissingHeightInfo(binO));
        } catch (e) {
          console.warn("Failed to parse Original IMHeightInfo:", e);
        }
      }
    })();
    return () => { cancelled = true; };
  }, [phase]);

  // Перевірити стан DLL dialog-fix: чи Ballon.CheckProperties уже патчений
  // на SizeControlType=UseTextInfo. Кешуємо у dialogFixPatched: null=loading,
  // true=ok, false=ще не fixed. Перевіряємо при phase=ready (тобто коли
  // користувач реально працює з текстом) і після кожного apply/revert.
  async function refreshDialogFixStatus() {
    try {
      const r = await W.missingDllDialogFixStatus();
      if (r.ok && r.summary) setDialogFixPatched(r.summary.patched);
    } catch { /* ignore */ }
  }
  useEffect(() => {
    if (phase !== "ready") return;
    refreshDialogFixStatus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase]);

  async function applyDialogFix() {
    if (dialogFixBusy) return;
    const ok = await dpConfirm(
      "Виправити обрізання діалогів?",
      "IL-патчі в Assembly-CSharp.dll:\n• Ballon.CheckProperties → SizeControlType примусово UseTextInfo (2): чат-пухир автоматично адаптує ширину під UA-текст (інакше обрізає по character-count).\n• BallonController.CheckProperties → так само.\n• TextExGenerator.get_WordWrapType → завжди 1 (Default): wrap йде по пробілах між словами (без цього wrap посеред слова: «потре|бувала», «психологічн|ий»).\n\nСтвориться .dll.bak (один раз). Після patch перезапусти TheMISSING.exe.",
      { okLabel: "Виправити", cancelLabel: "Скасувати", tone: "warning" }
    );
    if (!ok) return;
    setDialogFixBusy(true);
    const r = await W.missingDllDialogFix();
    setDialogFixBusy(false);
    if (!r.ok) { showError(r.error || "?", "Dialog fix failed"); return; }
    showOk(`Застосовано ${r.summary?.applied ?? 0} IL-патчів. Перезапусти TheMISSING.exe.`, "Dialog fix");
    await refreshDialogFixStatus();
  }

  async function revertDialogFix() {
    if (dialogFixBusy) return;
    const ok = await dpConfirm(
      "Повернути DLL до оригіналу?",
      "Файл Assembly-CSharp.dll відновиться з .dll.bak. Усі правки (Quick Fix + Strings edits) буде втрачено.",
      { okLabel: "Відкотити", cancelLabel: "Скасувати", tone: "danger" }
    );
    if (!ok) return;
    setDialogFixBusy(true);
    const r = await W.missingDllDialogFixRevert();
    setDialogFixBusy(false);
    if (!r.ok) { showError(r.error || "?", "Revert failed"); return; }
    showOk("DLL повернено з .bak. Перезапусти гру.", "Revert");
    await refreshDialogFixStatus();
  }

  // Debounced save heightinfo назад на диск (Done/heightinfo.bin).
  useEffect(() => {
    if (!heightInfoDirtyRef.current || !heightInfo) return;
    const id = setTimeout(async () => {
      heightInfoDirtyRef.current = false;
      try {
        const bytes = buildMissingHeightInfo(heightInfo);
        let bin = ""; for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
        const r = await W.missingBoxsizeSave({ base64: btoa(bin) });
        if (!r.ok) {
          showError(r.error || "невідома помилка", "Box-sizes: не вдалося зберегти");
        }
      } catch (e) {
        showError(e, "Box-sizes: помилка серіалізації");
      }
    }, 1000);
    return () => clearTimeout(id);
  }, [heightInfo]);

  // Користувацький trigger — кнопка у header'і "Extract box-sizes".
  async function runBoxsizeExtract() {
    setExtractingBox(true);
    try {
      const r = await W.missingBoxsizeExtract();
      if (!r.ok) { await dpAlert("Box-sizes", r.error ?? "extract failed", { tone: "danger" }); return; }
      // Reload after extract.
      const lr = await W.missingBoxsizeRead();
      if (lr.ok && lr.base64) {
        try {
          const bin = Uint8Array.from(atob(lr.base64), (c) => c.charCodeAt(0));
          const info = parseMissingHeightInfo(bin);
          setHeightInfo(info);
          setHeightInfoIdx(buildHeightInfoIndex(info));
          await dpAlert("Box-sizes", `Витягнуто IMHeightInfo: ${info.entries.length} записів × 4 мови.`, { tone: "success" });
        } catch (e) {
          await dpAlert("Box-sizes", `Витягнуто, але парс провалився: ${(e as Error).message}`, { tone: "warning" });
        }
      }
    } finally { setExtractingBox(false); }
  }

  // Legacy quick auto-fit (без превʼю) — зараз UI використовує MissingAutoFitModal.
  // Лишаю на випадок майбутнього "швидкого режиму". eslint-disable-next-line
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async function _runAutoFitLegacy() {
    if (!heightInfo || files.length === 0) return;
    const padding = 1.08; // 8% запас на варіативність шрифту/гліфів
    const ok = await dpConfirm(
      "Auto-fit box-sizes",
      `Підлаштувати ширину слота L${targetLang} під довжину перекладу для всіх перекладених рядків (×${padding} запас)?\n\nЦе перепише розміри в IMHeightInfo. Збереження до Done/heightinfo.bin відбудеться автоматично.`,
      { tone: "warning", okLabel: "Підлаштувати" }
    );
    if (!ok) return;

    let scanned = 0, applied = 0, skipped = 0;
    const nextEntries = heightInfo.entries.slice();
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
          scanned++;
          // Тільки реальні переклади (відрізняється від оригіналу, не плейсхолдер).
          if (d.text === o.text || !d.text || /^[A-Z_0-9]+_en$/.test(o.text) || /^V_[A-Z]{2}_\d{3}$/.test(o.text)) {
            skipped++; continue;
          }
          const enumN = o.msgEnum;
          if (enumN < 0) { skipped++; continue; }
          const hIdx = heightInfoIdx.get(enumN);
          if (hIdx === undefined) { skipped++; continue; }
          const cur = nextEntries[hIdx].sizes[targetLang];
          if (!cur) { skipped++; continue; }

          const enLen = o.text.length || 1;
          const uaLen = d.text.length;
          const ratio = uaLen / enLen;
          if (ratio <= 1) { skipped++; continue; } // не звужуємо
          // Враховуємо також line-count різницю (для багаторядкових діалогів).
          const enLines = (o.text.match(/\n/g) || []).length + 1;
          const uaLines = (d.text.match(/\n/g) || []).length + 1;

          const newW = Math.ceil(cur.w * ratio * padding);
          const newH = uaLines > enLines ? Math.ceil(cur.h * (uaLines / enLines)) : cur.h;
          if (newW === cur.w && newH === cur.h) { skipped++; continue; }

          const sizes = nextEntries[hIdx].sizes.slice();
          sizes[targetLang] = { w: newW, h: newH };
          nextEntries[hIdx] = { ...nextEntries[hIdx], sizes };
          applied++;
        }
      } catch {}
    }
    setHeightInfo({ ...heightInfo, entries: nextEntries });
    heightInfoDirtyRef.current = true;
    await dpAlert(
      "Готово",
      `Перевірено: ${scanned}\nПодігнано: ${applied}\nПропущено: ${skipped} (без перекладу / плейсхолдери / коротший UA)\n\nЗміни збережуться у Done/heightinfo.bin через секунду. Пакування у гру — як зазвичай.`,
      { tone: "success" }
    );
  }

  // Handler для зміни розміру одного слоту мови у активному рядку.
  function handleSizeChange(langIdx: number, w: number, h: number) {
    if (!heightInfo || activeIdx === null || !origMsg) return;
    const enumN = origMsg.entries[activeIdx]?.msgEnum ?? -1;
    if (enumN < 0) return;
    const idx = heightInfoIdx.get(enumN);
    if (idx === undefined) return;
    const cur = heightInfo.entries[idx].sizes[langIdx];
    if (!cur || (cur.w === w && cur.h === h)) return;
    const nextEntries = heightInfo.entries.slice();
    const nextSizes = nextEntries[idx].sizes.slice();
    nextSizes[langIdx] = { w, h };
    nextEntries[idx] = { ...nextEntries[idx], sizes: nextSizes };
    setHeightInfo({ ...heightInfo, entries: nextEntries });
    heightInfoDirtyRef.current = true;
  }

  // ── Row meta helpers ─────────────────────────────────────────
  function getMetaKey(msgEnum: number, fileName: string, idx: number): string {
    // MsgEnum стабільний globально, але якщо рядок не у length-table
    // (рідкісно, або section 2) — fallback на <file>::<idx>.
    return msgEnum >= 0 ? String(msgEnum) : `${fileName}::${idx}`;
  }
  function patchRowMeta(key: string, patch: Partial<RowMeta> | null) {
    setRowMeta((m) => {
      const next = { ...m };
      if (patch === null) { delete next[key]; }
      else {
        const cur = next[key] ?? {};
        const merged = { ...cur, ...patch };
        // Видаляємо запис тільки якщо ЖОДНОЇ ознаки не лишилось.
        if (!merged.status && !merged.bookmark && !merged.markedTranslated) delete next[key];
        else next[key] = merged;
      }
      rowMetaDirtyRef.current = true;
      return next;
    });
  }

  // Пробігаємо по всіх файлах → рахуємо total + translated по section 1.
  // System-рядки (типу NO_TEXT_en) виключаємо з total.
  // Counts words: tokens separated by whitespace, filter empty.
  const countWords = (s: string) => s.trim() ? s.trim().split(/\s+/).filter(Boolean).length : 0;

  // Будує повну CorpusStats: total/translated по entries + UA/EN words+chars + top files.
  async function computeMissingCorpusStats(): Promise<CorpusStats | null> {
    if (!files.length) return null;
    // Паралельно: ~100 файлів водночас замість послідовно. На повний corpus
    // це різниця між 8с (sequential) і ~1с (parallel) на NVMe.
    const results = await Promise.all(files.map(async (f) => {
      try {
        const sourcePath = f.hasDone ? f.donePath : f.origPath;
        const [oR, dR] = await Promise.all([
          W.missingTextRead(f.origPath),
          W.missingTextRead(sourcePath),
        ]);
        if (!oR.ok || !oR.base64) return null;
        const orig = parseMissingMsgCached(f.origPath, b64ToBytes(oR.base64));
        const done = dR.ok && dR.base64 ? parseMissingMsgCached(sourcePath, b64ToBytes(dR.base64)) : orig;
        let fTotal = 0, fTranslated = 0;
        let uaW = 0, enW = 0, uaC = 0, enC = 0;
        for (let i = 0; i < orig.entries.length; i++) {
          const e = orig.entries[i];
          const o = e?.text ?? "";
          if (o === "" || /^[A-Z_0-9]+_en$/.test(o)) continue;
          fTotal++;
          const d = done.entries[i]?.text ?? "";
          // Manual ПКМ-mark теж рахується як translated (інакше Огляд готовності
          // показує менше %, ніж header — користувач справедливо плутається).
          const key = e && e.msgEnum >= 0 ? String(e.msgEnum) : `${f.name}::${i}`;
          const marked = !!rowMeta[key]?.markedTranslated;
          if ((d !== "" && d !== o) || marked) {
            fTranslated++;
            const counted = d || o;
            uaW += countWords(counted);
            uaC += counted.length;
          } else {
            enW += countWords(o);
            enC += o.length;
          }
        }
        const niceName = f.name.replace(/_EN$/i, "");
        return {
          file: f,
          fTotal, fTranslated, uaW, enW, uaC, enC,
          row: {
            fileName: niceName,
            filePath: f.donePath,
            total: fTotal,
            translated: fTranslated,
            percent: fTotal ? +(fTranslated / fTotal * 100).toFixed(2) : 0,
          },
        };
      } catch { return null; }
    }));
    let total = 0, translated = 0, uaWords = 0, enWords = 0, uaChars = 0, enChars = 0;
    const topFiles: CorpusStats["topFiles"] = [];
    for (const r of results) {
      if (!r) continue;
      total += r.fTotal; translated += r.fTranslated;
      uaWords += r.uaW; enWords += r.enW;
      uaChars += r.uaC; enChars += r.enC;
      topFiles.push(r.row);
    }
    topFiles.sort((a, b) => b.total - a.total);
    return {
      files: files.length,
      totalEntries: total,
      translatedEntries: translated,
      percent: total ? +(translated / total * 100).toFixed(2) : 0,
      uaWords, enWords, uaChars, enChars,
      topFiles: topFiles.slice(0, 30),
    };
  }

  async function refreshProjectStats() {
    if (!files.length) { setProjectStats(null); setFileStats({}); return; }
    // Раніше: послідовно по ~100 файлах × parseMissingMsg на main thread.
    // 5-10s UI-freeze при найменшій зміні rowMeta. Тепер усі read+parse
    // паралельно через Promise.all — обмежує лише IPC concurrency у main.
    const perFile: Record<string, { total: number; translated: number }> = {};
    const results = await Promise.all(files.map(async (f) => {
      try {
        const sourcePath = f.hasDone ? f.donePath : f.origPath;
        const [oR, dR] = await Promise.all([
          W.missingTextRead(f.origPath),
          W.missingTextRead(sourcePath),
        ]);
        if (!oR.ok || !oR.base64) return null;
        const orig = parseMissingMsgCached(f.origPath, b64ToBytes(oR.base64));
        const done = dR.ok && dR.base64 ? parseMissingMsgCached(sourcePath, b64ToBytes(dR.base64)) : orig;
        let fTotal = 0, fTranslated = 0;
        for (let i = 0; i < orig.entries.length; i++) {
          const e = orig.entries[i];
          const o = e?.text ?? "";
          if (o === "" || /^[A-Z_0-9]+_en$/.test(o)) continue;
          fTotal++;
          const d = done.entries[i]?.text ?? "";
          const key = e && e.msgEnum >= 0 ? String(e.msgEnum) : `${f.name}::${i}`;
          const marked = !!rowMeta[key]?.markedTranslated;
          if ((d !== "" && d !== o) || marked) fTranslated++;
        }
        return { file: f.file, total: fTotal, translated: fTranslated };
      } catch { return null; }
    }));
    let total = 0, translated = 0;
    for (const r of results) {
      if (!r) continue;
      total += r.total; translated += r.translated;
      perFile[r.file] = { total: r.total, translated: r.translated };
    }
    setProjectStats({ files: files.length, total, translated });
    setFileStats(perFile);
  }
  useEffect(() => {
    if (phase !== "ready") return;
    // Debounce 400ms — щоб кілька швидких ПКМ-toggle не запускали повний
    // re-scan усіх msg-файлів кожен раз.
    const id = setTimeout(() => { void refreshProjectStats(); }, 400);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, files.length, rowMeta]);

  async function runExtract() {
    setPhase("extracting");
    setProgressLines([]);
    const r = await W.missingPrepExtract();
    if (!r.ok) { setPhase("error"); setErrMsg(r.error || "extract fail"); return; }
    await refreshStatus();
    await refreshFiles();
    // Одразу витягуємо box-sizes таблицю — silent fail, якщо нема прав/файла.
    let boxNote = "";
    try {
      const br = await W.missingBoxsizeExtract();
      if (br.ok) {
        const lr = await W.missingBoxsizeRead();
        if (lr.ok && lr.base64) {
          try {
            const bin = Uint8Array.from(atob(lr.base64), (c) => c.charCodeAt(0));
            const info = parseMissingHeightInfo(bin);
            setHeightInfo(info);
            setHeightInfoIdx(buildHeightInfoIndex(info));
            boxNote = `\nBox-sizes: ${info.entries.length} записів × 4 мови.`;
          } catch {}
        }
      }
    } catch {}
    setPhase("ready");
    await dpAlert(
      t("missing.extract.doneTitle"),
      t("missing.extract.doneBody", { n: String(r.summary?.total ?? 0) }) + boxNote,
      { tone: "success" }
    );
  }

  async function openFile(f: FileItem) {
    setActiveFile(f);
    setActiveIdx(null);
    setEdits(new Map());
    try {
      const origRes = await W.missingTextRead(f.origPath);
      if (!origRes.ok || !origRes.base64) throw new Error(origRes.error || "read orig fail");
      const origBytes = b64ToBytes(origRes.base64);
      const orig = parseMissingMsg(origBytes);
      setOrigMsg(orig);

      let done = orig;
      if (f.hasDone) {
        const doneRes = await W.missingTextRead(f.donePath);
        if (doneRes.ok && doneRes.base64) {
          try { done = parseMissingMsg(b64ToBytes(doneRes.base64)); } catch {}
        }
      }
      setDoneMsg(done);
    } catch (e) {
      setErrMsg(`openFile fail: ${(e as Error).message}`);
    }
  }

  async function saveFile() {
    if (!activeFile || !origMsg || !doneMsg) return;
    if (edits.size === 0) return;
    setSaving(true);
    try {
      const built = buildMissingMsg(origMsg, edits);
      const r = await W.missingTextWrite({ fullPath: activeFile.donePath, base64: bytesToB64(built) });
      if (!r.ok) throw new Error(r.error || "write fail");
      // Інвалідуємо кеш для цього шляху — fingerprint зміниться після write,
      // але краще явно скинути запис, щоб refreshProjectStats нижче точно
      // перепарсував свіжі байти (а не повертав застарілий entry з sig'ом
      // що випадково збігся).
      invalidateMissingMsgCache(activeFile.donePath);
      const fresh = parseMissingMsg(built);
      setDoneMsg(fresh);
      setEdits(new Map());
      setLastSavedAt(Date.now());
      await refreshFiles();
      await refreshProjectStats();
    } catch (e) {
      const msg = (e as Error).message;
      // Якщо overflow з конкретним id — даємо клік-action, який стрибає на рядок.
      const idMatch = msg.match(/рядок #(\d+)/);
      if (idMatch) {
        const targetIdx = Number(idMatch[1]);
        showError(msg, "Збереження неможливе");
        showToast(`Перейти до рядка #${targetIdx} →`, {
          tone: "warning",
          durationMs: 12000,
          action: {
            label: "Перейти",
            onClick: () => setActiveIdx(targetIdx),
          },
        });
      } else {
        setErrMsg(`save fail: ${msg}`);
        showError(msg, "Збереження не вдалося");
      }
    } finally {
      setSaving(false);
    }
  }

  async function packAll() {
    if (packing) return;
    const status = await W.missingPrepStatus();
    if (!status.ok) {
      await dpAlert(t("missing.pack.errTitle"), status.error || "?", { tone: "danger" });
      return;
    }
    if ((status.doneCount ?? 0) === 0) {
      await dpAlert(t("missing.pack.nothingTitle"), t("missing.pack.nothingBody"), { tone: "warning" });
      return;
    }
    setPacking(true);
    setProgressLines([]);
    setPackLog([]);
    try {
      // Спочатку пакуємо box-sizes, якщо є модифіковані. Це окремий PS-скрипт,
      // який підмінює IMHeightInfo MonoBehaviour у resources.assets.
      if (heightInfo) {
        const br = await W.missingBoxsizePack();
        if (!br.ok && !br.skipped) {
          await dpAlert("Box-sizes pack failed", br.error || "?", { tone: "danger" });
          return;
        }
      }
      const r = await W.missingPack();
      if (!r.ok) {
        await dpAlert(t("missing.pack.errTitle"), r.error || "?", { tone: "danger" });
        return;
      }
      const applied = r.summary?.applied ?? 0;
      const failedArr = (r.summary?.failed ?? []) as Array<{ name: string; reason: string }>;
      const skipped = failedArr.filter((f) => /Done file missing/i.test(f.reason || "")).length;
      const realFailed = failedArr.length - skipped;
      setPackSuccess({
        applied,
        skipped,
        realFailed,
        assetsPath: (status.assetsPath as string) || "",
        bakPath: ((status.assetsPath as string) || "") + ".bak",
        assetsSize: 0,
        bakSize: 0,
        failedRows: failedArr.filter((f) => !/Done file missing/i.test(f.reason || "")),
      });
    } catch (e) {
      await dpAlert(t("missing.pack.errTitle"), (e as Error).message, { tone: "danger" });
    } finally {
      setPacking(false);
    }
  }

  // Плейсхолдер = "NO_TEXT_en" або voice-refs (V_EM_001, V_JM_183 і т.д.)
  // Це службові рядки, які не перекладаються — за замовч. ховаємо з UI/статистики.
  const isPlaceholderText = (s: string) => s === "NO_TEXT_en" || /^[A-Z_0-9]+_en$/.test(s) || /^V_[A-Z]{2}_\d{3}$/.test(s);

  const rows: Array<{ idx: number; entry: MissingMsgEntry; translated: boolean; isSame: boolean; isEmpty: boolean; isPlaceholder: boolean; metaKey: string; meta?: RowMeta }> = useMemo(() => {
    if (!origMsg || !doneMsg) return [];
    const out: typeof rows = [];
    const q = search.trim().toLowerCase();
    const fileName = activeFile?.name ?? "";
    for (let i = 0; i < origMsg.entries.length; i++) {
      const cur = edits.has(i) ? (edits.get(i) ?? "") : (doneMsg.entries[i]?.text ?? "");
      const orig = origMsg.entries[i].text;
      const entry = origMsg.entries[i];
      const isEmpty = !cur || cur.trim().length === 0;
      const isSame = !isEmpty && cur === orig;
      const isPlaceholder = isPlaceholderText(orig);
      const metaKey = getMetaKey(entry.msgEnum, fileName, i);
      const meta = rowMeta[metaKey];
      // Manual override "markedTranslated" перекриває is-same heuristic:
      // для рядків типу ":)" / "..." переклад === оригіналу, але користувач
      // натиснув ПКМ → Позначити перекладеним.
      const translated = (!isEmpty && !isSame) || !!meta?.markedTranslated;

      // Плейсхолдери ховаємо за замовч. (показуємо лише при rowFilter=placeholder
      // або коли увімкнено `includePlaceholders`).
      if (isPlaceholder && rowFilter !== "placeholder" && !includePlaceholders) continue;
      if (!isPlaceholder && rowFilter === "placeholder") continue;
      if (rowFilter === "untranslated" && translated) continue;
      if (rowFilter === "translated" && !translated) continue;
      if (rowFilter === "same" && !isSame) continue;
      if (rowFilter === "bookmarks" && !meta?.bookmark) continue;
      if (q && !orig.toLowerCase().includes(q) && !cur.toLowerCase().includes(q)) continue;
      out.push({ idx: i, entry: { ...entry, text: cur }, translated, isSame, isEmpty, isPlaceholder, metaKey, meta });
    }
    return out;
  }, [origMsg, doneMsg, edits, search, rowFilter, includePlaceholders, rowMeta, activeFile]);

  // Активний рядок для правого pane — будуємо MissingActiveItem обʼєкт.
  const activeItem: MissingActiveItem | null = useMemo(() => {
    if (activeIdx === null || !origMsg || !doneMsg) return null;
    const orig = origMsg.entries[activeIdx]?.text ?? "";
    const cur = edits.has(activeIdx) ? (edits.get(activeIdx) ?? "") : (doneMsg.entries[activeIdx]?.text ?? "");
    const msgEnum = origMsg.entries[activeIdx]?.msgEnum ?? -1;
    const hIdx = msgEnum >= 0 ? heightInfoIdx.get(msgEnum) : undefined;
    const sizes = hIdx !== undefined && heightInfo ? heightInfo.entries[hIdx].sizes : undefined;
    return {
      offset: origMsg.entries[activeIdx]?.offset ?? 0,
      original: orig,
      current: cur,
      index: activeIdx,
      msgEnum,
      sizes,
    };
  }, [activeIdx, origMsg, doneMsg, edits, heightInfo, heightInfoIdx]);

  const prevNext = useMemo(() => {
    if (activeIdx === null || rows.length === 0) return { prev: null, next: null };
    const pos = rows.findIndex((r) => r.idx === activeIdx);
    if (pos < 0) return { prev: null, next: null };
    const pRow = pos > 0 ? rows[pos - 1] : null;
    const nRow = pos < rows.length - 1 ? rows[pos + 1] : null;
    const mk = (r: typeof rows[0] | null): MissingActiveItem | null => r ? {
      offset: r.entry.offset, original: origMsg!.entries[r.idx].text,
      current: r.entry.text, index: r.idx,
    } : null;
    return { prev: mk(pRow), next: mk(nRow) };
  }, [activeIdx, rows, origMsg]);

  // ── Export combined TXT ────────────────────────────────────────
  // Формат: HBR-style, секції-заголовки + рядки `# 0x<offset>` + текст.
  // Файл всередині [...] — це m_Name (без .dat-суфікса і pathId), щоб імпорт
  // міг знайти потрібний msg-файл за іменем.
  async function exportCombined() {
    if (exporting) return;
    setExporting(true);
    try {
      const target = await W.pickSaveFile({
        title: "Експортувати combined.txt",
        defaultPath: "missing-combined.txt",
        filters: [{ name: "Text", extensions: ["txt"] }],
      });
      if (!target) return;
      const lines: string[] = [];
      lines.push("# THE MISSING — combined TXT export");
      lines.push("# Не міняй заголовки [...] і \"# enum <N>\". Редагуй лише текст під ними.");
      lines.push("# enum — стабільний глобальний ідентифікатор рядка (msgBase*10000 + i).");
      lines.push("");
      for (const f of files) {
        // Беремо Done якщо є, інакше Original.
        const sourcePath = f.hasDone ? f.donePath : f.origPath;
        const r = await W.missingTextRead(sourcePath);
        if (!r.ok || !r.base64) continue;
        const parsed = parseMissingMsg(b64ToBytes(r.base64));
        lines.push(`[${f.name}]`);
        lines.push("");
        for (const e of parsed.entries) {
          // Канонічний ідентифікатор — enum (стабільний). Fallback на offset
          // для рідкісних рядків без enum-запису у length-table.
          if (e.msgEnum >= 0) {
            lines.push(`# enum ${e.msgEnum}`);
          } else {
            lines.push(`# 0x${e.offset.toString(16).padStart(6, "0")}`);
          }
          lines.push(e.text);
          lines.push("");
        }
      }
      // Окрема секція [__Interface__] — UI.Text MonoBehaviour'и з sharedassets
      // (YES/NO/OPTION/Settings/...). Експорт PS-скрипта пише у Documents-теку;
      // ми його зчитуємо і додаємо у combined.txt окремими записами `# ui
      // <file>:<pathId>`. Так перекладач у ОДНОМУ файлі редагує і msg.dat
      // тексти, і UI labels.
      let uiEntries = 0;
      try {
        const uiR = await W.missingUiTextExport();
        if (uiR.ok && uiR.outFile) {
          const uiTxt = await W.readFile(uiR.outFile);
          if (uiTxt) {
            // PS-format: коментарі (# ...) + блоки `[file:pathId]\ntext\n\n`.
            // Перетворюємо у наш combined-style: `[__Interface__]` + записи
            // `# ui file:pathId\n<text>`.
            lines.push("");
            lines.push("[__Interface__]");
            lines.push("");
            lines.push("# UI.Text MonoBehaviour'и з sharedassets (YES/NO/OPTION/...).");
            lines.push("# Не міняй \"# ui <file>:<pathId>\" — за ними import знаходить позиції.");
            lines.push("");
            const blockRe = /^\[([^\]\n:]+):(\d+)\]\s*$\n([\s\S]*?)(?=^\[[^\]\n:]+:\d+\]\s*$|\Z)/gm;
            const norm = uiTxt.replace(/\r\n/g, "\n");
            let m: RegExpExecArray | null;
            while ((m = blockRe.exec(norm)) != null) {
              const file = m[1].trim();
              const pid = m[2].trim();
              const text = (m[3] || "").replace(/^\n/, "").replace(/\n+$/, "");
              if (!text) continue;
              lines.push(`# ui ${file}:${pid}`);
              lines.push(text);
              lines.push("");
              uiEntries++;
            }
          }
        }
      } catch { /* ігноруємо — UI export опціональний */ }

      const ok = await W.writeFile(target, lines.join("\n"));
      if (!ok) await dpAlert(t("missing.export.errTitle"), t("missing.export.errBody"), { tone: "danger" });
      else await dpAlert(
        t("missing.export.doneTitle"),
        t("missing.export.doneBody", { n: String(files.length), path: target }) + (uiEntries > 0 ? `\n\n+ Interface: ${uiEntries} UI-надписів у секції [__Interface__]` : ""),
        { tone: "success" }
      );
    } finally {
      setExporting(false);
    }
  }

  // ── Import combined TXT ────────────────────────────────────────
  // Парсимо назад: для кожної секції [m_Name] йдемо по записах "# 0x<offset>"
  // → текст, мапимо у entries за offset і пишемо Done через buildMissingMsg.
  async function importCombined() {
    if (importing) return;
    setImporting(true);
    try {
      const src = await W.pickFile({ title: "Імпортувати combined.txt", filters: [{ name: "Text", extensions: ["txt"] }] });
      if (!src) return;
      const txt = await W.readFile(src);
      if (txt === null) {
        await dpAlert(t("missing.import.errTitle"), t("missing.import.errReadBody"), { tone: "danger" });
        return;
      }
      const proceed = await dpConfirm(
        t("missing.import.confirmTitle"),
        t("missing.import.confirmBody"),
        { tone: "warning", okLabel: t("missing.import.confirmOk") }
      );
      if (!proceed) return;
      // Нормалізуємо лінії та парсимо.
      // Підтримуємо два формати:
      //   1. `# enum <N>`  — новий, стабільний (рекомендовано)
      //   2. `# 0x<hex>`   — старий, по offset (fallback для legacy-файлів)
      // Парсимо обидва і складаємо у дві мапи: enumMap і offsetMap.
      const norm = txt.replace(/\r\n/g, "\n");
      interface SectionMaps { enumMap: Map<number, string>; offsetMap: Map<number, string> }
      const sections: Map<string, SectionMaps> = new Map();
      const sectionRe = /^\[([^\]\n]+)\]\s*$/gm;
      const headers: Array<{ name: string; start: number; end: number }> = [];
      let m: RegExpExecArray | null;
      while ((m = sectionRe.exec(norm)) != null) headers.push({ name: m[1].trim(), start: m.index, end: m.index + m[0].length });
      for (let i = 0; i < headers.length; i++) {
        const cur = headers[i];
        const next = i + 1 < headers.length ? headers[i + 1].start : norm.length;
        const body = norm.slice(cur.end, next);
        // Об'єднаний regex: ловить як "# enum N", так і "# 0xHEX".
        const recRe = /^#\s+(?:enum\s+(\d+)|0x([0-9a-fA-F]+))\s*$/gm;
        const recMatches: Array<{ kind: "enum" | "offset"; value: number; start: number; end: number }> = [];
        let rm: RegExpExecArray | null;
        while ((rm = recRe.exec(body)) != null) {
          if (rm[1] != null) recMatches.push({ kind: "enum", value: parseInt(rm[1], 10), start: rm.index, end: rm.index + rm[0].length });
          else recMatches.push({ kind: "offset", value: parseInt(rm[2], 16), start: rm.index, end: rm.index + rm[0].length });
        }
        const enumMap = new Map<number, string>();
        const offsetMap = new Map<number, string>();
        for (let j = 0; j < recMatches.length; j++) {
          const r = recMatches[j];
          const rNext = j + 1 < recMatches.length ? recMatches[j + 1].start : body.length;
          let text = body.slice(r.end, rNext);
          text = text.replace(/^\r?\n/, "").replace(/\n+$/, "");
          if (r.kind === "enum") enumMap.set(r.value, text);
          else offsetMap.set(r.value, text);
        }
        sections.set(cur.name, { enumMap, offsetMap });
      }
      // Застосовуємо до кожного файлу.
      let touchedFiles = 0, totalCells = 0;
      for (const f of files) {
        const maps = sections.get(f.name);
        if (!maps || (maps.enumMap.size === 0 && maps.offsetMap.size === 0)) continue;
        const sourcePath = f.hasDone ? f.donePath : f.origPath;
        const r = await W.missingTextRead(sourcePath);
        if (!r.ok || !r.base64) continue;
        const parsed = parseMissingMsg(b64ToBytes(r.base64));
        const edits2 = new Map<number, string>();
        const norm = (s: string) => (s ?? "")
          .replace(/^﻿/, "")
          .replace(/\r\n/g, "\n")
          .replace(/\r/g, "\n")
          .replace(/[ \t]+\n/g, "\n")
          .replace(/\s+$/, "");
        let firstDiff: { offset: number; orig: string; imported: string } | null = null;
        for (let i = 0; i < parsed.entries.length; i++) {
          const e = parsed.entries[i];
          // Пріоритет: enum (стабільний) → offset (fallback).
          let imported: string | undefined;
          if (e.msgEnum >= 0 && maps.enumMap.has(e.msgEnum)) imported = maps.enumMap.get(e.msgEnum);
          else if (maps.offsetMap.has(e.offset)) imported = maps.offsetMap.get(e.offset);
          if (imported === undefined) continue;
          if (norm(imported) === norm(e.text)) continue;
          if (!firstDiff) firstDiff = { offset: e.offset, orig: e.text, imported };
          edits2.set(i, imported);
        }
        // Раніше тут збирали debug-`firstDiff` і показували модалку
        // «Імпорт: знайдено різницю (debug)». Для legit UA-перекладу
        // різниця довжин (UTF-8 байт) між orig і imported — нормальне явище,
        // не помилка. Перевірку прибрали; reference на firstDiff лишається
        // лише для майбутньої діагностики, але alert не викликається.
        void firstDiff;
        if (edits2.size === 0) continue;
        const built = buildMissingMsg(parsed, edits2);
        await W.missingTextWrite({ fullPath: f.donePath, base64: bytesToB64(built) });
        invalidateMissingMsgCache(f.donePath);
        touchedFiles++;
        totalCells += edits2.size;
      }
      // Секція [__Interface__] — UI.Text MonoBehaviour'и (sharedassets).
      // Парсимо записи `# ui file:pathId\n<text>`, перетворюємо у format
      // PS-скрипта (`[file:pathId]\ntext\n\n`) і викликаємо UI import inline.
      let uiApplied = 0, uiSkipped = 0, uiMissing = 0;
      const ifaceHeader = headers.find((h) => h.name === "__Interface__");
      if (ifaceHeader) {
        const idx = headers.indexOf(ifaceHeader);
        const next = idx + 1 < headers.length ? headers[idx + 1].start : norm.length;
        const body = norm.slice(ifaceHeader.end, next);
        const uiRecRe = /^#\s+ui\s+(\S+?):(\d+)\s*$/gm;
        const recs: Array<{ file: string; pid: string; start: number; end: number }> = [];
        let urm: RegExpExecArray | null;
        while ((urm = uiRecRe.exec(body)) != null) {
          recs.push({ file: urm[1].trim(), pid: urm[2].trim(), start: urm.index, end: urm.index + urm[0].length });
        }
        if (recs.length > 0) {
          const outLines: string[] = [];
          outLines.push("# Inline interface import from combined.txt");
          for (let i = 0; i < recs.length; i++) {
            const r = recs[i];
            const rNext = i + 1 < recs.length ? recs[i + 1].start : body.length;
            let text = body.slice(r.end, rNext);
            text = text.replace(/^\r?\n/, "").replace(/\n+$/, "");
            outLines.push("");
            outLines.push(`[${r.file}:${r.pid}]`);
            outLines.push(text);
          }
          const uiR = await W.missingUiTextImportInline({ content: outLines.join("\n") });
          if (uiR.ok && uiR.summary) {
            uiApplied = uiR.summary.applied;
            uiSkipped = uiR.summary.skippedSame;
            uiMissing = uiR.summary.missing;
          }
        }
      }

      await refreshFiles();
      await refreshProjectStats();
      if (activeFile) await openFile(activeFile);
      {
        const uiTail = (uiApplied + uiSkipped + uiMissing) > 0
          ? `\n\n+ Interface: applied ${uiApplied} · same ${uiSkipped} · missing ${uiMissing}`
          : "";
        await dpAlert(
          t("missing.import.doneTitle"),
          t("missing.import.doneBody", { files: String(touchedFiles), cells: String(totalCells) }) + uiTail,
          { tone: "success" }
        );
      }
    } finally {
      setImporting(false);
    }
  }

  const stats = useMemo(() => {
    let translated = 0, total = 0;
    for (const r of rows) {
      const orig = origMsg?.entries[r.idx]?.text ?? "";
      if (orig === "" || /^[A-Z_0-9]+_en$/.test(orig)) continue; // system
      total++;
      if (r.translated) translated++;
    }
    return { translated, total };
  }, [rows, origMsg]);

  // Командний список для Ctrl+K. Категорії: Дії · Перегляд · Файли · Перехід.
  const commandItems = useMemo<CommandItem[]>(() => {
    const out: CommandItem[] = [];
    // Дії
    out.push({
      id: "save", category: "Дії", icon: "💾", label: "Зберегти файл",
      shortcut: "Ctrl+S", hint: `${edits.size} незбережених`,
      keywords: "save зберегти збер", disabled: edits.size === 0 || saving,
      run: () => { void saveFile(); },
    });
    out.push({
      id: "pack", category: "Дії", icon: "📦", label: "Запакувати у гру (Pack)",
      keywords: "pack запакувати", disabled: packing,
      run: () => { void packAll(); },
    });
    out.push({
      id: "export", category: "Дії", icon: "↓", label: "Експортувати combined.txt",
      keywords: "export експорт txt", disabled: exporting || files.length === 0,
      run: () => { void exportCombined(); },
    });
    out.push({
      id: "import", category: "Дії", icon: "↑", label: "Імпортувати з combined.txt",
      keywords: "import імпорт txt", disabled: importing || files.length === 0,
      run: () => { void importCombined(); },
    });
    // Інструменти
    out.push({
      id: "lint", category: "Інструменти", icon: "⚠", label: "Перевірка цілісності (Lint)",
      keywords: "lint перевірка цілісність теги",
      disabled: files.length === 0, run: () => setLintOpen(true),
    });
    out.push({
      id: "stats", category: "Інструменти", icon: "📊", label: "Статистика проєкту",
      keywords: "stats статистика прогрес",
      disabled: files.length === 0, run: () => setStatsOpen(true),
    });
    out.push({
      id: "dll", category: "Інструменти", icon: "🔧", label: "Редактор Assembly-CSharp.dll",
      keywords: "dll assembly csharp strings",
      run: () => setDllOpen(true),
    });
    if (heightInfo) {
      out.push({
        id: "autofit", category: "Інструменти", icon: "📏", label: "Auto-fit box-sizes",
        keywords: "autofit box розмір ширина", hint: `слот L${targetLang}`,
        run: () => setAutoFitOpen(true),
      });
    } else {
      out.push({
        id: "boxextract", category: "Інструменти", icon: "📐", label: "Витягнути box-sizes",
        keywords: "box розмір extract heightinfo",
        disabled: extractingBox, run: () => { void runBoxsizeExtract(); },
      });
    }
    out.push({
      id: "dialogfix",
      category: "Інструменти",
      icon: dialogFixPatched === true ? "✓" : "🪄",
      label: dialogFixPatched === true ? "DLL dialog-fix: вже застосовано" : "Виправити обрізання діалогів",
      keywords: "dialog ballon діалог чат пухир wordwrap",
      disabled: dialogFixBusy || dialogFixPatched === true,
      run: () => { void applyDialogFix(); },
    });
    out.push({
      id: "search-global", category: "Перегляд", icon: "🔍", label: "Глобальний пошук у всіх msg-файлах",
      keywords: "search пошук глобальний", shortcut: "Ctrl+Shift+F",
      run: () => setSearchAllOpen(true),
    });
    out.push({
      id: "toggle-monaco", category: "Перегляд", icon: monacoCollapsed ? "▶" : "◀",
      label: monacoCollapsed ? "Показати редактор справа" : "Сховати редактор справа",
      keywords: "monaco pane редактор сховати collapse",
      run: () => setMonacoCollapsed(!monacoCollapsed),
    });
    out.push({
      id: "shortcuts", category: "Перегляд", icon: "⌨", label: "Гарячі клавіші",
      keywords: "shortcuts cheatsheet гарячі клавіші довідка", shortcut: "?",
      run: () => setShortcutsOpen(true),
    });
    // Фільтри
    const filters: Array<[RowFilter, string]> = [
      ["all", "Усі рядки"],
      ["untranslated", "Лиш неперекладені"],
      ["translated", "Лиш перекладені"],
      ["same", "Однакові з оригіналом"],
      ["bookmarks", "Закладки"],
      ["placeholder", "Плейсхолдери"],
    ];
    for (const [k, lab] of filters) {
      out.push({
        id: `filter-${k}`, category: "Фільтр рядків",
        icon: rowFilter === k ? "●" : "○",
        label: lab, keywords: `filter ${k}`,
        run: () => setRowFilter(k),
      });
    }
    // Файли — швидкий перехід.
    for (const f of files) {
      const st = fileStats[f.file];
      const pct = st && st.total > 0 ? Math.round((st.translated / st.total) * 100) : 0;
      out.push({
        id: `file-${f.file}`, category: "Перехід до файлу", icon: "📄",
        label: f.name, hint: st ? `${st.translated}/${st.total} · ${pct}%` : undefined,
        keywords: f.file, run: () => { void openFile(f); },
      });
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    edits.size, saving, packing, exporting, importing, files, fileStats,
    rowFilter, monacoCollapsed, heightInfo, targetLang, dialogFixBusy,
    dialogFixPatched, extractingBox,
  ]);

  return (
    <div className="flex-1 flex flex-col min-h-0 h-full">
      <header className="h-12 px-4 border-b border-[var(--border-soft)] bg-[var(--bg)] flex items-center gap-3 shrink-0">
        <button className="dp-btn dp-btn--ghost" onClick={onHome}>← {t("btn.home")}</button>
        <span className="text-[13px] font-semibold text-[var(--text-strong)]">THE MISSING</span>
        <span className="text-[11px] text-[var(--text-faint)]">— J.J. Macfield and the Island of Memories</span>
        <div className="flex-1" />
        {phase === "ready" && (
          <>
            {projectStats && projectStats.total > 0 && (
              <HeaderProgress
                translated={projectStats.translated}
                total={projectStats.total}
                title={`Загальний прогрес проєкту · ${projectStats.files} файлів`}
              />
            )}
            {/* Autosave / dirty indicator */}
            {dirty && (
              <span className="text-[10.5px] text-[var(--warning,#d97706)] tabular-nums" title="Незбережені правки — автозбереження за 20с">
                ● незбережено ({edits.size})
              </span>
            )}
            {!dirty && lastSavedAt && (
              <span className="text-[10.5px] text-[var(--text-faint)] tabular-nums" title={`Збережено о ${new Date(lastSavedAt).toLocaleTimeString()}`}>
                ● збережено
              </span>
            )}
            <button
              className="dp-btn dp-btn--ghost"
              onClick={() => setCmdOpen(true)}
              title="Командна палітра — пошук усіх дій, файлів, enum (Ctrl+K)"
            >
              <svg className="w-3.5 h-3.5 inline" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
              </svg>
              <span className="ml-1 text-[10px] font-mono px-1 py-0.5 border border-[var(--border-soft)] rounded">⌘K</span>
            </button>
            <HeaderMenu
              trigger={<span className="flex items-center gap-1"><span aria-hidden>🛠</span> Інструменти</span>}
              items={(() => {
                const items: MenuItem[] = [
                  { icon: "⚠", label: "Lint", title: "Перевірка цілісності перекладу (теги, плейсхолдери)", disabled: files.length === 0, onClick: () => setLintOpen(true) },
                  { icon: "📊", label: t("missing.stats.btn"), title: t("missing.stats.btnHint"), disabled: files.length === 0, onClick: () => setStatsOpen(true) },
                  { icon: "🔍", label: "Глобальний пошук", shortcut: "Ctrl+Shift+F", onClick: () => setSearchAllOpen(true) },
                  {},
                ];
                if (heightInfo) {
                  items.push({ icon: "📏", label: `Auto-fit (L${targetLang})`, title: "Підлаштувати ширину box-sizes під переклад", onClick: () => setAutoFitOpen(true) });
                } else {
                  items.push({ icon: "📐", label: "Витягнути box-sizes", disabled: extractingBox, onClick: () => { void runBoxsizeExtract(); } });
                }
                items.push({});
                items.push({
                  icon: dialogFixPatched === true ? "✓" : "🪄",
                  label: dialogFixPatched === true ? "Dialog-fix (вже застосовано)" : "Виправити діалоги",
                  tone: dialogFixPatched === true ? "success" : "default",
                  disabled: dialogFixBusy || dialogFixPatched === true,
                  onClick: () => { void applyDialogFix(); },
                });
                items.push({ icon: "🔧", label: "Редактор DLL-рядків", onClick: () => setDllOpen(true) });
                return items;
              })()}
            />
            <HeaderMenu
              trigger={<span className="flex items-center gap-1"><span aria-hidden>📁</span> Файл</span>}
              items={[
                { icon: "↓", label: t("missing.editor.exportAll"), disabled: exporting || files.length === 0, onClick: exportCombined, title: "Експортувати все у combined.txt" },
                { icon: "↑", label: t("missing.editor.importAll"), disabled: importing || files.length === 0, onClick: importCombined, title: "Імпортувати з combined.txt у всі файли" },
                {},
                { icon: "⌨", label: "Гарячі клавіші", shortcut: "?", onClick: () => setShortcutsOpen(true) },
                { icon: monacoCollapsed ? "▶" : "◀", label: monacoCollapsed ? "Показати pane редактора" : "Сховати pane редактора", onClick: () => setMonacoCollapsed(!monacoCollapsed) },
              ]}
            />
            {heightInfo && (
              <div
                className="flex items-center gap-1 text-[10.5px] text-[var(--text-muted)] px-2 py-1 rounded border border-[var(--border-soft)] bg-[var(--bg)]"
                title="Цільовий мовний слот у IMHeightInfo"
              >
                <span>UA →</span>
                <select
                  className="bg-transparent text-[var(--text)] outline-none cursor-pointer"
                  value={targetLang}
                  onChange={(e) => setTargetLang(parseInt(e.target.value, 10))}
                >
                  <option value={0}>L0 (EN)</option>
                  <option value={1}>L1 (JP)</option>
                  <option value={2}>L2 (CN?)</option>
                  <option value={3}>L3 (KR?)</option>
                </select>
              </div>
            )}
            {activeFile && (
              <button className="dp-btn dp-btn--primary" disabled={saving || edits.size === 0} onClick={saveFile} title="Зберегти (Ctrl+S)">
                {saving ? "…" : t("missing.editor.save")} {edits.size > 0 ? `(${edits.size})` : ""}
              </button>
            )}
            <button className="dp-btn dp-btn--success" disabled={packing} onClick={packAll}>
              {packing ? "…" : t("missing.editor.pack")}
            </button>
          </>
        )}
        <LangToggle compact />
      </header>

      {phase === "loading" && (
        <div className="flex-1 flex items-center justify-center p-8">
          <div className="w-full max-w-[440px] flex flex-col gap-5">
            <div className="text-center">
              <h2 className="text-[18px] font-bold text-[var(--text-strong)] mb-1">Підготовка редактора…</h2>
              <p className="text-[12px] text-[var(--text-muted)]">Перевіряємо файли та парсимо meta. Зазвичай це частка секунди.</p>
            </div>
            <div className="dp-card p-5 flex items-center gap-3">
              <span className="inline-block w-3.5 h-3.5 rounded-full border-2 border-[var(--text-faint)] border-t-[var(--accent)] animate-spin" aria-hidden />
              <p className="text-[12.5px] text-[var(--text-muted)]">{t("missing.editor.loading")}</p>
            </div>
          </div>
        </div>
      )}

      {phase === "error" && (
        <div className="flex-1 flex flex-col items-center justify-center p-8 gap-3">
          <div className="text-[14px] font-semibold text-[var(--danger)]">{t("missing.editor.errorTitle")}</div>
          <div className="text-[12px] text-[var(--text-muted)] max-w-xl text-center">{errMsg}</div>
        </div>
      )}

      {phase === "needs-extract" && (
        <div className="flex-1 flex flex-col items-center justify-center p-8 gap-3">
          <div className="text-[14px] font-semibold text-[var(--text-strong)]">{t("missing.editor.needsExtractTitle")}</div>
          <div className="text-[12px] text-[var(--text-muted)] max-w-xl text-center mb-4">{t("missing.editor.needsExtractBody")}</div>
          <button className="dp-btn dp-btn--primary" onClick={runExtract}>{t("missing.editor.extractBtn")}</button>
        </div>
      )}

      {phase === "extracting" && (
        <div className="flex-1 flex flex-col p-6 gap-3">
          <div className="text-[13px] font-semibold text-[var(--text-strong)]">{t("missing.editor.extracting")}</div>
          <div className="flex-1 bg-[var(--bg)] border border-[var(--border-soft)] rounded p-3 text-[11px] font-mono overflow-auto whitespace-pre-wrap">
            {progressLines.join("\n")}
          </div>
        </div>
      )}

      {phase === "ready" && dialogFixPatched === false && !dialogFixDismissed && (
        <div className="px-4 py-2.5 bg-[var(--warning,#d97706)]/10 border-b border-[var(--warning,#d97706)]/30 flex items-center gap-3">
          <span className="text-[16px]" aria-hidden>🪄</span>
          <div className="flex-1 min-w-0 text-[12px] text-[var(--text)]">
            <span className="font-semibold">UA-текст обрізається у чат-пухирях?</span>{" "}
            <span className="text-[var(--text-muted)]">
              Single-click патч у Assembly-CSharp.dll: chat-bubble буде автоматично розширюватися під переклад. Створиться .dll.bak. Перезапусти гру.
            </span>
          </div>
          <button className="dp-btn dp-btn--success" disabled={dialogFixBusy} onClick={applyDialogFix}>
            {dialogFixBusy ? "…" : "Виправити"}
          </button>
          <button className="dp-btn dp-btn--ghost" onClick={() => setDialogFixDismissed(true)} title="Сховати банер (можна повернутися через header-кнопку)">
            ✕
          </button>
        </div>
      )}

      {phase === "ready" && (
        <div className="flex-1 flex min-h-0">
          {/* Left: file list — з пошуком / sort / tabs (MissingFileSidebar). */}
          <MissingFileSidebar
            files={files.map((f) => ({ name: f.name, file: f.file, scriptLen: f.scriptLen }))}
            activeKey={activeFile?.file ?? null}
            fileStats={fileStats}
            onPick={(sf) => {
              const full = files.find((x) => x.file === sf.file);
              if (full) void openFile(full);
            }}
          />

          {/* Center: rows table */}
          <main className="flex-1 flex flex-col min-w-0 min-h-0">
            {!activeFile && (
              <div className="flex-1 flex items-center justify-center text-[var(--text-muted)] text-[12px]">{t("missing.editor.pickFile")}</div>
            )}
            {activeFile && doneMsg && origMsg && (
              <>
                <div className="px-3 py-2 border-b border-[var(--border-soft)] bg-[var(--bg)] flex flex-col gap-2 shrink-0">
                  <div className="flex items-center gap-2">
                    <span className="text-[11px] text-[var(--text-faint)] font-mono">{activeFile.name}</span>
                    <span className="text-[11px] text-[var(--text-muted)]">·</span>
                    <span className="text-[11px] text-[var(--text-muted)]">{origMsg.entries.length} рядків{origMsg.entries2.length > 0 ? `, voice-keys: ${origMsg.entries2.length}` : ""}</span>
                    <input
                      className="dp-input flex-1 text-[11.5px]"
                      placeholder={t("missing.editor.searchPlaceholder")}
                      value={searchDraft}
                      onChange={(e) => setSearchDraft(e.target.value)}
                    />
                    <span className="text-[11px] text-[var(--text-faint)] tabular-nums">{rows.length}/{origMsg.entries.length}</span>
                  </div>
                  <div className="flex gap-1 text-[11px] flex-wrap">
                    {([
                      ["all",          t("missing.filter.all")],
                      ["untranslated", t("missing.filter.untranslated")],
                      ["translated",   t("missing.filter.translated")],
                      ["same",         t("missing.filter.same")],
                      ["bookmarks",    "🔖 Закладки"],
                      ["placeholder",  "Плейсхолдери"],
                    ] as Array<[RowFilter, string]>).map(([k, lab]) => (
                      <button
                        key={k}
                        onClick={() => setRowFilter(k)}
                        className={`dp-btn ${rowFilter === k ? "dp-btn--primary" : ""}`}
                      >
                        {lab}
                      </button>
                    ))}
                    <label className="flex items-center gap-1 text-[10.5px] text-[var(--text-muted)] ml-2 cursor-pointer" title="Враховувати NO_TEXT_en та voice-refs у статистиці">
                      <input type="checkbox" checked={includePlaceholders} onChange={(e) => setIncludePlaceholders(e.target.checked)} />
                      +PH
                    </label>
                  </div>
                </div>
                {/* Sticky header — той самий layout, що й рядки нижче (CSS-grid). */}
                <div
                  className="sticky-row-header grid items-center text-[10px] uppercase tracking-wider text-[var(--text-faint)] bg-[var(--bg-surface)] border-b border-[var(--border-soft)] px-1 shrink-0"
                  style={{ gridTemplateColumns: "26px 100px 90px 1fr 1fr" }}
                >
                  <div className="text-center py-1.5" title="Закладка">·</div>
                  <div className="px-2 py-1.5" title="msgBase*10000 + i">MsgEnum</div>
                  <div className="px-2 py-1.5" title="Зсув (нестабільний)">Offset</div>
                  <div className="px-2 py-1.5">{t("missing.editor.originalCol")}</div>
                  <div className="px-2 py-1.5">{t("missing.editor.translationCol")}</div>
                </div>
                <VirtualRows
                  items={rows}
                  rowHeight={64}
                  overscan={10}
                  scrollToIndex={activeIdx !== null ? rows.findIndex((r) => r.idx === activeIdx) : null}
                  renderRow={(r) => {
                    const orig = origMsg.entries[r.idx]?.text ?? "";
                    const isActive = activeIdx === r.idx;
                    const meta = r.meta;
                    const statusBorder = meta?.status === "approved"
                      ? "border-l-[3px] border-l-[var(--success)]"
                      : meta?.status === "review"
                        ? "border-l-[3px] border-l-[var(--accent)]"
                        : meta?.status === "draft"
                          ? "border-l-[3px] border-l-dashed border-l-[var(--warning,#d97706)]"
                          : meta?.markedTranslated
                            ? "border-l-2 border-l-[var(--success)]"
                            : r.isEmpty
                              ? "border-l-2 border-l-[var(--danger)]"
                              : r.isSame
                                ? "border-l-2 border-l-[var(--warning,#d97706)]"
                                : "border-l-2 border-l-[var(--success)]";
                    const enumDisplay = r.entry.msgEnum >= 0 ? String(r.entry.msgEnum) : "—";
                    return (
                      <div
                        key={r.idx}
                        className={`grid items-start border-b border-[var(--border-soft)] cursor-pointer hover:bg-[var(--bg-elev)] ${isActive ? "bg-[var(--bg-elev)]" : ""} ${statusBorder} text-[12px] px-1`}
                        style={{ gridTemplateColumns: "26px 100px 90px 1fr 1fr", minHeight: 64 }}
                        onClick={() => setActiveIdx(r.idx)}
                        onContextMenu={(ev) => {
                          ev.preventDefault();
                          setActiveIdx(r.idx);
                          setCtxMenu({ x: ev.clientX, y: ev.clientY, idx: r.idx, msgEnum: r.entry.msgEnum });
                        }}
                      >
                        <div className="text-center py-2">
                          {meta?.bookmark && <span title="Закладка (Ctrl+B)">🔖</span>}
                        </div>
                        <div
                          className="px-2 py-2 font-mono text-[10.5px] text-[var(--text)] tabular-nums"
                          title={r.entry.enumCount > 1 ? `${r.entry.enumCount} enum-слотів` : undefined}
                        >
                          {enumDisplay}
                          {r.entry.enumCount > 1 && <span className="ml-1 text-[var(--text-faint)]">×{r.entry.enumCount}</span>}
                        </div>
                        <div className="px-2 py-2 font-mono text-[10.5px] text-[var(--text-faint)]">{"0x" + r.entry.offset.toString(16).padStart(6, "0")}</div>
                        <div className="px-2 py-2 whitespace-pre-wrap break-words text-[var(--text-muted)] overflow-hidden" style={{ maxHeight: 60 }}>
                          <HighlightedText text={orig} />
                        </div>
                        <div className="px-2 py-2 whitespace-pre-wrap break-words text-[var(--text-muted)] overflow-hidden" style={{ maxHeight: 60 }}>
                          <HighlightedText text={r.entry.text} />
                        </div>
                      </div>
                    );
                  }}
                />
                <EditorFooter
                  fileName={activeFile?.name}
                  stats={[
                    { label: "Видно", value: rows.length, tone: "default" },
                    { label: "Усього", value: stats.total, tone: "default" },
                    {
                      label: "Перекладено",
                      value: `${stats.translated} (${stats.total > 0
                        ? ((stats.translated / stats.total) * 100).toFixed(1)
                        : "0.0"}%)`,
                      tone: "success",
                    },
                    ...(activeIdx !== null
                      ? [{ label: "Позиція", value: `${activeIdx + 1}/${origMsg?.entries.length ?? 0}`, tone: "accent" as const }]
                      : []),
                    ...(edits.size > 0
                      ? [{ label: "Незбережено", value: edits.size, tone: "warning" as const }]
                      : []),
                  ]}
                />
              </>
            )}
          </main>

          {/* Right: Monaco editor pane. Можна сховати через кнопку у хедері
              або command palette → отримуємо повну ширину для таблиці. */}
          {!monacoCollapsed && (
            <MissingItemEditor
              item={activeItem}
              prev={prevNext.prev}
              next={prevNext.next}
              targetLang={targetLang}
              onSizeChange={handleSizeChange}
              onChange={(v) => {
                if (activeIdx === null) return;
                const next = new Map(edits);
                next.set(activeIdx, v);
                setEdits(next);
              }}
              onJumpPrev={() => prevNext.prev && setActiveIdx(prevNext.prev.index)}
              onJumpNext={() => prevNext.next && setActiveIdx(prevNext.next.index)}
              onClose={() => setActiveIdx(null)}
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

      {/* Stats overview модалка — HBR-style з 8 метричними картками і top-files. */}
      <CorpusStatsModal
        open={statsOpen}
        onClose={() => setStatsOpen(false)}
        mode="missing"
        computeCustomStats={computeMissingCorpusStats}
      />

      <MissingLintModal
        open={lintOpen}
        onClose={() => setLintOpen(false)}
        files={files.map((f) => ({ name: f.name, file: f.file, origPath: f.origPath, donePath: f.donePath, hasDone: f.hasDone }))}
        onGoTo={async (f, idx) => {
          setLintOpen(false);
          const full = files.find((x) => x.file === f.file);
          if (full) { await openFile(full); setActiveIdx(idx); }
        }}
      />
      <MissingGlobalSearchModal
        open={searchAllOpen}
        onClose={() => setSearchAllOpen(false)}
        files={files.map((f) => ({ name: f.name, file: f.file, origPath: f.origPath, donePath: f.donePath, hasDone: f.hasDone }))}
        onGoTo={async (f, idx) => {
          const full = files.find((x) => x.file === f.file);
          if (full) { await openFile(full); setActiveIdx(idx); }
        }}
      />
      <MissingAutoFitModal
        open={autoFitOpen}
        onClose={() => setAutoFitOpen(false)}
        files={files.map((f) => ({ name: f.name, origPath: f.origPath, donePath: f.donePath, hasDone: f.hasDone }))}
        heightInfo={heightInfo}
        referenceHeightInfo={heightInfoOriginal}
        heightInfoIdx={heightInfoIdx}
        targetLang={targetLang}
        onApply={(updates) => {
          if (!heightInfo) return;
          const nextEntries = heightInfo.entries.slice();
          for (const u of updates) {
            const sizes = nextEntries[u.hIdx].sizes.slice();
            sizes[targetLang] = { w: u.w, h: u.h };
            nextEntries[u.hIdx] = { ...nextEntries[u.hIdx], sizes };
          }
          setHeightInfo({ ...heightInfo, entries: nextEntries });
          heightInfoDirtyRef.current = true;
          // Видимий feedback: користувач щойно натиснув "Підлаштувати" і чекає
          // підтвердження. Save сам спрацює через 1с debounce; toast скаже
          // що зміни прийняті у пам'ять і пише на диск.
          showOk(`Підлаштовано ${updates.length} рядків · слот L${targetLang} · зберігаю у Done/heightinfo.bin…`, "Auto-fit");
        }}
      />

      <MissingDllEditor open={dllOpen} onClose={() => setDllOpen(false)} />

      {/* Command palette (Ctrl+K) — fuzzy-search дій, файлів, фільтрів. */}
      <CommandPalette
        open={cmdOpen}
        onClose={() => setCmdOpen(false)}
        items={commandItems}
      />

      {/* Cheatsheet (?). */}
      <MissingShortcutsModal
        open={shortcutsOpen}
        onClose={() => setShortcutsOpen(false)}
      />

      {/* Контекстне меню рядка */}
      {ctxMenu && (
        <>
          <div className="fixed inset-0 z-[60]" onClick={() => setCtxMenu(null)} onContextMenu={(e) => { e.preventDefault(); setCtxMenu(null); }} />
          <div
            className="fixed z-[61] dp-card py-1.5 text-[12px] min-w-[220px] shadow-xl"
            style={{ left: Math.min(ctxMenu.x, window.innerWidth - 240), top: Math.min(ctxMenu.y, window.innerHeight - 320) }}
            onClick={(e) => e.stopPropagation()}
          >
            {(() => {
              const key = getMetaKey(ctxMenu.msgEnum, activeFile?.name ?? "", ctxMenu.idx);
              const cur = rowMeta[key];
              const idx = ctxMenu.idx;
              const close = () => setCtxMenu(null);
              const setStatus = (s?: "draft" | "review" | "approved") => { patchRowMeta(key, { status: s }); close(); };
              const item = (label: string, onClick: () => void, active = false, dim = false) => (
                <button
                  className={`w-full text-left px-3 py-1.5 hover:bg-[var(--row-hover)] flex items-center gap-2 ${active ? "text-[var(--accent)]" : dim ? "text-[var(--text-faint)]" : "text-[var(--text)]"}`}
                  onClick={onClick}
                >{label}</button>
              );
              return (
                <>
                  {item("Позначити як чернетку", () => setStatus("draft"), cur?.status === "draft")}
                  {item("Позначити на перевірку", () => setStatus("review"), cur?.status === "review")}
                  {item("Затвердити", () => setStatus("approved"), cur?.status === "approved")}
                  {item("Зняти стан", () => setStatus(undefined), !cur?.status, true)}
                  <div className="border-t border-[var(--border-soft)] my-1" />
                  {item(
                    cur?.bookmark ? "🔖 Прибрати закладку (Ctrl+B)" : "🔖 Закладка (Ctrl+B)",
                    () => { patchRowMeta(key, { bookmark: !cur?.bookmark }); close(); },
                  )}
                  {item(
                    cur?.markedTranslated ? "✓ Зняти позначку «перекладено»" : "✓ Позначити перекладеним",
                    () => { patchRowMeta(key, { markedTranslated: !cur?.markedTranslated }); close(); },
                    !!cur?.markedTranslated,
                  )}
                  <div className="border-t border-[var(--border-soft)] my-1" />
                  {item("Скопіювати оригінал у переклад", () => {
                    const o = origMsg?.entries[idx]?.text ?? "";
                    setEdits((m) => { const n = new Map(m); n.set(idx, o); return n; });
                    close();
                  })}
                  {item("Trim пробілів", () => {
                    const cur = edits.has(idx) ? (edits.get(idx) ?? "") : (doneMsg?.entries[idx]?.text ?? "");
                    setEdits((m) => { const n = new Map(m); n.set(idx, cur.trim()); return n; });
                    close();
                  })}
                </>
              );
            })()}
          </div>
        </>
      )}

      {/* Pack-progress модалка — поки PS-скрипт працює, стрим лог. */}
      {packing && (() => {
        const patched = packLog.filter((l) => l.startsWith("[PATCHED]")).length;
        const totalGuess = files.length;
        const done = patched;
        const pct = totalGuess > 0 ? Math.min(100, Math.round((done / totalGuess) * 100)) : 0;
        const isWriting = packLog.some((l) => /Writing assets/i.test(l));
        const isLoaded = packLog.some((l) => /Loading assets/i.test(l));
        const hasMeta = packLog.some((l) => /\[DIAG\] Meta items:/.test(l));
        const lastPatch = (() => {
          const lp = [...packLog].reverse().find((l) => l.startsWith("[PATCHED]"));
          const m = lp?.match(/\[PATCHED\]\s+(\S+)/);
          return m ? m[1] : "";
        })();
        const colorize = (line: string) => {
          if (line.startsWith("[PATCHED]")) return "text-[var(--success)]";
          if (line.startsWith("[FAIL]") || line.startsWith("[31;1m")) return "text-[var(--danger)]";
          if (line.startsWith("[STEP]")) return "text-[var(--accent)]";
          if (line.startsWith("[DIAG]")) return "text-[var(--text-faint)]";
          return "text-[var(--text-muted)]";
        };
        type StepKey = "meta" | "load" | "patch" | "write";
        const stepStatus = (k: StepKey): "pending" | "running" | "done" => {
          if (k === "meta") return hasMeta ? "done" : "running";
          if (k === "load") return isLoaded ? "done" : (hasMeta ? "running" : "pending");
          if (k === "patch") {
            if (!isLoaded) return "pending";
            if (totalGuess > 0 && done >= totalGuess) return "done";
            return "running";
          }
          if (k === "write") return isWriting ? "running" : "pending";
          return "pending";
        };
        const renderStep = (k: StepKey, title: string, sub?: React.ReactNode) => {
          const s = stepStatus(k);
          const icon = s === "done"
            ? <span className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-[var(--success)]/15 text-[var(--success)] border border-[var(--success)]/40 text-[10px] font-bold shrink-0">✓</span>
            : s === "running"
              ? <span className="inline-flex items-center justify-center w-5 h-5 rounded-full border border-[var(--accent)]/40 bg-[var(--accent)]/10 shrink-0"><span className="inline-block h-2.5 w-2.5 rounded-full border-2 border-[var(--accent)] border-t-transparent animate-spin" /></span>
              : <span className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-[var(--bg-elev)] border border-[var(--border-soft)] text-[var(--text-faint)] text-[10px] shrink-0">○</span>;
          const cls = s === "running" ? "text-[var(--text-strong)]" : s === "done" ? "text-[var(--text)]" : "text-[var(--text-faint)]";
          return (
            <li className="flex items-start gap-2.5 py-1.5">
              {icon}
              <div className="flex-1 min-w-0">
                <p className={`text-[12.5px] leading-snug ${cls}`}>{title}</p>
                {sub && <div className="text-[11px] text-[var(--text-muted)] mt-0.5">{sub}</div>}
              </div>
            </li>
          );
        };
        return (
          <div className="fixed inset-0 z-40 bg-black/60 flex items-center justify-center p-6">
            <div className="w-full max-w-[600px] bg-[var(--bg-surface)] border border-[var(--border-soft)] rounded-lg shadow-xl">
              <div className="px-5 py-3 border-b border-[var(--border-soft)] flex items-center gap-3">
                <span className="inline-block h-3 w-3 rounded-full border-2 border-[var(--accent)] border-t-transparent animate-spin" />
                <p className="text-[13px] font-semibold text-[var(--text-strong)]">{t("missing.pack.runningTitle")}</p>
                <span className="ml-auto text-[10.5px] tabular-nums text-[var(--text-faint)]">{done}/{totalGuess}</span>
              </div>
              <ol className="px-5 py-3">
                {renderStep("meta", t("missing.pack.step.meta"))}
                {renderStep("load", t("missing.pack.step.load"))}
                {renderStep(
                  "patch",
                  t("missing.pack.step.patch"),
                  stepStatus("patch") !== "pending" ? (
                    <div>
                      <div className="flex items-baseline justify-between mb-1 gap-2">
                        <span className="tabular-nums text-[var(--text-muted)]">{done} / {totalGuess} · {pct}%</span>
                        {lastPatch && <span className="font-mono text-[10.5px] text-[var(--text-faint)] truncate max-w-[260px]" title={lastPatch}>{lastPatch}</span>}
                      </div>
                      <div className="h-1 rounded-full bg-[var(--bg-elev)] overflow-hidden">
                        <div className="h-full bg-[var(--accent)] transition-all" style={{ width: `${pct}%` }} />
                      </div>
                    </div>
                  ) : undefined,
                )}
                {renderStep("write", t("missing.pack.step.write"))}
              </ol>
              <div className="px-5 pb-4">
                <details className="group">
                  <summary className="cursor-pointer list-none text-[11px] text-[var(--text-muted)] hover:text-[var(--text)] flex items-center gap-1 select-none">
                    <span className="inline-block transition-transform group-open:rotate-90">›</span>
                    {t("missing.pack.logToggle")} <span className="text-[var(--text-faint)]">({packLog.length})</span>
                  </summary>
                  <div className="mt-2 text-[10.5px] font-mono bg-[var(--bg)] border border-[var(--border-soft)] rounded p-2 max-h-[220px] overflow-y-auto whitespace-pre-wrap break-all">
                    {packLog.length === 0 ? (
                      <span className="text-[var(--text-faint)]">{t("missing.pack.starting")}</span>
                    ) : (
                      packLog.slice(-150).map((line, i) => (
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

      {/* Pack-success модалка — стиль HBR (hero band + metrics + paths + actions). */}
      {packSuccess && (() => {
        const hasReal = packSuccess.realFailed > 0;
        const tone = hasReal ? "warning" : "success";
        const rgba = hasReal ? "217,119,6" : "34,197,94";
        const cssVar = hasReal ? "var(--warning,#d97706)" : "var(--success)";
        return (
          <div
            className="fixed inset-0 z-40 bg-black/60 flex items-center justify-center p-6"
            onClick={() => setPackSuccess(null)}
          >
            <div
              className="w-full max-w-[600px] bg-[var(--bg-surface)] border border-[var(--border-soft)] rounded-xl shadow-2xl overflow-hidden"
              onClick={(e) => e.stopPropagation()}
            >
              <div
                className="relative px-8 pt-7 pb-6 text-center"
                style={{
                  background: `linear-gradient(135deg, rgba(${rgba},0.18) 0%, rgba(${rgba},0.05) 60%, transparent 100%)`,
                  borderBottom: "1px solid var(--border-soft)",
                }}
              >
                <div
                  className="inline-flex items-center justify-center w-14 h-14 rounded-full mb-3"
                  style={{
                    background: `radial-gradient(circle, rgba(${rgba},0.30), rgba(${rgba},0.05))`,
                    boxShadow: `0 0 22px -4px rgba(${rgba},0.45)`,
                  }}
                >
                  {hasReal ? (
                    <svg className="w-7 h-7" fill="none" viewBox="0 0 24 24" stroke={cssVar} strokeWidth={2.5}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01M10.29 3.86l-8.18 14.18A2 2 0 003.84 21h16.32a2 2 0 001.73-2.96L13.71 3.86a2 2 0 00-3.42 0z" />
                    </svg>
                  ) : (
                    <svg className="w-7 h-7" fill="none" viewBox="0 0 24 24" stroke={cssVar} strokeWidth={2.5}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                    </svg>
                  )}
                </div>
                <h2 className="text-[22px] font-bold text-[var(--text-strong)] mb-1" style={{ fontFamily: "'Playfair Display', Georgia, serif" }}>
                  {t(hasReal ? "missing.pack.success.titleWarn" : "missing.pack.success.title")}
                </h2>
                <p className="text-[12.5px] text-[var(--text-muted)]">
                  {t(hasReal ? "missing.pack.success.subtitleWarn" : "missing.pack.success.subtitle")}
                </p>
              </div>

              <div className="grid grid-cols-3 gap-3 px-6 py-5">
                <div className="rounded-lg border border-[var(--border-soft)] bg-[var(--bg)] px-4 py-3">
                  <p className="text-[10px] uppercase tracking-wider text-[var(--text-faint)] mb-1">{t("missing.pack.metric.applied")}</p>
                  <p className="text-[22px] font-bold text-[var(--success)] tabular-nums leading-none">{packSuccess.applied.toLocaleString("uk-UA")}</p>
                  <p className="text-[10.5px] text-[var(--text-muted)] mt-1.5">{t("missing.pack.metric.appliedHint")}</p>
                </div>
                <div className="rounded-lg border border-[var(--border-soft)] bg-[var(--bg)] px-4 py-3">
                  <p className="text-[10px] uppercase tracking-wider text-[var(--text-faint)] mb-1">{t("missing.pack.metric.skipped")}</p>
                  <p className="text-[22px] font-bold text-[var(--text-strong)] tabular-nums leading-none">{packSuccess.skipped.toLocaleString("uk-UA")}</p>
                  <p className="text-[10.5px] text-[var(--text-muted)] mt-1.5">{t("missing.pack.metric.skippedHint")}</p>
                </div>
                <div className="rounded-lg border border-[var(--border-soft)] bg-[var(--bg)] px-4 py-3">
                  <p className="text-[10px] uppercase tracking-wider text-[var(--text-faint)] mb-1">{t("missing.pack.metric.failed")}</p>
                  <p className="text-[22px] font-bold tabular-nums leading-none" style={{ color: packSuccess.realFailed > 0 ? "var(--warning,#d97706)" : "var(--text-strong)" }}>
                    {packSuccess.realFailed.toLocaleString("uk-UA")}
                  </p>
                  <p className="text-[10.5px] text-[var(--text-muted)] mt-1.5">{t("missing.pack.metric.failedHint")}</p>
                </div>
              </div>

              <div className="px-6 pb-5 space-y-2.5">
                {packSuccess.assetsPath && (
                  <div className="rounded-md border border-[var(--border-soft)] bg-[var(--bg)] px-3 py-2 flex items-start gap-3">
                    <span className="text-[10px] uppercase tracking-wider text-[var(--text-faint)] shrink-0 mt-0.5">{t("missing.pack.assetsLabel")}</span>
                    <p className="text-[11px] font-mono text-[var(--text)] break-all flex-1 min-w-0" title={packSuccess.assetsPath}>{packSuccess.assetsPath}</p>
                  </div>
                )}
                {packSuccess.bakPath && (
                  <div className="rounded-md border border-[var(--border-soft)] bg-[var(--bg)] px-3 py-2 flex items-start gap-3">
                    <span className="text-[10px] uppercase tracking-wider text-[var(--text-faint)] shrink-0 mt-0.5">{t("missing.pack.bakLabel")}</span>
                    <p className="text-[11px] font-mono text-[var(--text-muted)] break-all flex-1 min-w-0" title={packSuccess.bakPath}>{packSuccess.bakPath}</p>
                  </div>
                )}
                {packSuccess.failedRows.length > 0 && (
                  <details className="text-[11px]">
                    <summary className="cursor-pointer text-[var(--warning,#d97706)]">{t("missing.pack.failedSummary", { n: String(packSuccess.failedRows.length) })}</summary>
                    <ul className="mt-1.5 ml-4 list-disc text-[var(--text-muted)] space-y-0.5">
                      {packSuccess.failedRows.slice(0, 20).map((f, i) => (
                        <li key={i}><span className="font-mono">{f.name}</span> — {f.reason}</li>
                      ))}
                    </ul>
                  </details>
                )}
              </div>

              <div className="px-6 pb-5 flex flex-wrap items-center gap-2 border-t border-[var(--border-soft)] pt-4">
                <button
                  className="dp-btn"
                  onClick={() => {
                    if (!packSuccess.assetsPath) return;
                    const dir = packSuccess.assetsPath.replace(/[\\/][^\\/]+$/, "");
                    (window.dp2 as unknown as { openFolder?: (p: string) => void }).openFolder?.(dir);
                  }}
                  disabled={!packSuccess.assetsPath}
                >
                  <svg className="w-4 h-4 mr-1.5 inline" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-7l-2-2H5a2 2 0 00-2 2z" />
                  </svg>
                  {t("missing.pack.openFolder")}
                </button>
                <div className="flex-1" />
                <button className="dp-btn" onClick={() => setPackSuccess(null)}>{t("btn.close")}</button>
                <button
                  className={`dp-btn dp-btn--${tone === "success" ? "success" : "primary"}`}
                  style={{ boxShadow: `0 0 18px -4px rgba(${rgba},0.55)` }}
                  onClick={() => {
                    // The MISSING Demo на Steam — appid 1295880 (повна 932540).
                    // Запускаємо через steam:// — якщо демо, користувач сам обере.
                    (window.dp2 as unknown as { openExternal?: (u: string) => void }).openExternal?.("steam://rungameid/1295880");
                    setPackSuccess(null);
                  }}
                >
                  <svg className="w-4 h-4 mr-1.5 inline" fill="currentColor" viewBox="0 0 24 24">
                    <path d="M8 5v14l11-7z" />
                  </svg>
                  {t("missing.pack.launchGame")}
                </button>
              </div>
            </div>
          </div>
        );
      })()}
    </div>
  );
}
