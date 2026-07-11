import { useEffect, useMemo, useRef, useState } from "react";
import { useT, localizeBackendError } from "../../lib/i18n";
import { confirm as showConfirm } from "../../lib/dialogs";
import { HBR_TEXTURES, type HbrTextureEntry } from "./textures-list";
import { Dp2TextureBusyModal, type BusyKind, type BusyTarget } from "../dp2/Dp2TextureBusyModal";

// Hotel Barcelona — Texture Editor.
//
// Архітектура майже 1:1 з Dp2TexturesEditor, але іде через HBR-IPC
// (window.dp2.hbrTextures*) і працює з .bundle, а не з .assets/.resS:
//   - PathID — int64 (string), не number — JS Number втрачає precision на 19 цифрах.
//   - Replace передає весь список одним PowerShell-викликом (batch),
//     щоб уникнути перезаписів .bak і повторного відкриття/закриття bundle.
//   - Розпаковані PNG живуть у toolsDir/HBR/Textures/Unpack — окремо від
//     самого bundle, щоб випадково не потрапили у Steam Cloud.

interface HbrTexturesEditorProps {
  onHome: () => void;
}

type Status = "idle" | "exporting" | "replacing";
type Preview = { src: string; mtime: number };

function pickStatusFromLine(ln: string): string | null {
  const m = ln.match(/^\[STEP\]\s*(.+)$/);
  if (m) return m[1].trim();
  if (/^\[EXPORTED\]\s/.test(ln)) return ln.trim();
  if (/^\[PATCHED\]\s/.test(ln)) return ln.trim();
  return null;
}

export function HbrTexturesEditor({ onHome }: HbrTexturesEditorProps) {
  const t = useT();

  const [status, setStatus] = useState<Status>("idle");
  const [previews, setPreviews] = useState<Record<string, Preview>>({});
  const [exportedDir, setExportedDir] = useState<string | null>(null);
  const [busyIds, setBusyIds] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState("");
  const [groupFilter, setGroupFilter] = useState<string>("all");

  // Стан модалки прогресу.
  const [modalOpen, setModalOpen] = useState(false);
  const [modalKind, setModalKind] = useState<BusyKind | null>(null);
  const [modalTarget, setModalTarget] = useState<BusyTarget>({});
  const [modalLines, setModalLines] = useState<string[]>([]);
  const [modalStatus, setModalStatus] = useState<string>("");
  const [modalDone, setModalDone] = useState(false);
  const [modalError, setModalError] = useState<string | null>(null);
  const [modalCurrent, setModalCurrent] = useState<number | undefined>(undefined);
  const [modalTotal, setModalTotal] = useState<number | undefined>(undefined);
  const [modalResult, setModalResult] = useState<{
    mode?: string; output?: string; outDir?: string; exportedCount?: number;
  } | undefined>(undefined);
  const exportedSoFarRef = useRef(0);
  const patchedSoFarRef = useRef(0);

  function resetModal() {
    setModalLines([]);
    setModalStatus("");
    setModalDone(false);
    setModalError(null);
    setModalCurrent(undefined);
    setModalTotal(undefined);
    setModalResult(undefined);
    exportedSoFarRef.current = 0;
    patchedSoFarRef.current = 0;
  }

  function openModal(kind: BusyKind, target: BusyTarget, total?: number) {
    resetModal();
    setModalKind(kind);
    setModalTarget(target);
    if (typeof total === "number") {
      setModalTotal(total);
      setModalCurrent(0);
    }
    setModalOpen(true);
  }

  function pushLine(ln: string) {
    setModalLines((prev) => (prev.length > 500 ? [...prev.slice(-500), ln] : [...prev, ln]));
    const s = pickStatusFromLine(ln);
    if (s) setModalStatus(s);
    if (/^\[EXPORTED\]\s/.test(ln)) {
      exportedSoFarRef.current += 1;
      setModalCurrent(exportedSoFarRef.current);
    }
    if (/^\[PATCHED\]\s/.test(ln)) {
      patchedSoFarRef.current += 1;
      setModalCurrent(patchedSoFarRef.current);
    }
  }

  const groups = useMemo(() => {
    const s = new Set<string>();
    for (const tx of HBR_TEXTURES) if (tx.group) s.add(tx.group);
    return ["all", ...Array.from(s).sort()];
  }, []);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return HBR_TEXTURES.filter((tx) => {
      if (groupFilter !== "all" && tx.group !== groupFilter) return false;
      if (!q) return true;
      return (
        tx.name.toLowerCase().includes(q) ||
        tx.id.toLowerCase().includes(q) ||
        tx.pathId.includes(q)
      );
    });
  }, [search, groupFilter]);

  // Витягуємо PathID з імені файлу формату `<name>-<CAB-…>-<pathId>.png`.
  // PathID — int64 як string, тому НЕ використовуємо parseInt (втрата
  // precision на 19-цифрових negative IDs типу "-5904940313933730409").
  function pathIdFromFileName(name: string): string | null {
    const m = name.match(/-(-?\d+)\.png$/i);
    return m ? m[1] : null;
  }

  // На монтуванні: підвантажити локальні PNG, якщо є.
  useEffect(() => {
    (async () => {
      const list = await window.dp2.hbrTexturesList();
      if (!list || !list.files?.length) return;
      if (list.dir) setExportedDir(list.dir);
      // Індексуємо файли за PathID — назва файла містить CAB-hash, який
      // ми не дублюємо в textures-list.ts (CAB однаковий для всіх).
      const byPathId = new Map<string, string>();
      for (const f of list.files) {
        const pid = pathIdFromFileName(f.name);
        if (pid) byPathId.set(pid, f.path);
      }
      const tasks = HBR_TEXTURES.map(async (tx): Promise<[string, Preview] | null> => {
        const filePath = byPathId.get(tx.pathId);
        if (!filePath) return null;
        const b64 = await window.dp2.hbrTexturesReadBase64(filePath);
        if (!b64) return null;
        return [tx.id, { src: `data:image/png;base64,${b64}`, mtime: Date.now() }];
      });
      const results = await Promise.all(tasks);
      const map: Record<string, Preview> = {};
      for (const r of results) if (r) map[r[0]] = r[1];
      if (Object.keys(map).length) setPreviews(map);
    })().catch(() => {});
  }, []);

  useEffect(() => {
    if (!modalOpen) return;
    const offExp = window.dp2.onHbrTexturesExportProgress(pushLine);
    const offRep = window.dp2.onHbrTexturesReplaceProgress(pushLine);
    return () => { offExp?.(); offRep?.(); };
  }, [modalOpen]);

  async function refreshOnePreviewFromUnpack(tx: HbrTextureEntry) {
    // Підтягуємо PNG з Unpack-теки, не з UI-стану — щоб уникнути collision
    // mtime, коли той самий пагнгляд кешується браузером.
    const list = await window.dp2.hbrTexturesList();
    if (!list || !list.files) return;
    const hit = list.files.find((f) => pathIdFromFileName(f.name) === tx.pathId);
    if (!hit) return;
    const b64 = await window.dp2.hbrTexturesReadBase64(hit.path);
    if (!b64) return;
    setPreviews((p) => ({ ...p, [tx.id]: { src: `data:image/png;base64,${b64}`, mtime: Date.now() } }));
  }

  async function exportTexture(tx: HbrTextureEntry) {
    if (status !== "idle") return;
    setBusyIds((s) => new Set(s).add(tx.id));
    setStatus("exporting");
    openModal("exportOne", { name: tx.name, pathId: tx.pathId }, 1);
    try {
      const res = await window.dp2.hbrTexturesExport({ pathIds: [tx.pathId] });
      if (!res.success) {
        setModalError(localizeBackendError(res.error) || "?");
        setModalDone(true);
        return;
      }
      await refreshOnePreviewFromUnpack(tx);
      if (res.outDir) setExportedDir(res.outDir);
      setModalCurrent(1);
      setModalResult({ outDir: res.outDir, exportedCount: res.summary?.total ?? 0 });
      setModalDone(true);
    } catch (e: unknown) {
      setModalError(e instanceof Error ? e.message : String(e));
      setModalDone(true);
    } finally {
      setBusyIds((s) => { const n = new Set(s); n.delete(tx.id); return n; });
      setStatus("idle");
    }
  }

  async function exportAll() {
    setStatus("exporting");
    openModal("exportAll", { total: HBR_TEXTURES.length }, HBR_TEXTURES.length);
    try {
      const allPathIds = HBR_TEXTURES.map((tx) => tx.pathId);
      const res = await window.dp2.hbrTexturesExport({ pathIds: allPathIds });
      if (!res.success) {
        setModalError(localizeBackendError(res.error) || "?");
        setModalDone(true);
        return;
      }
      const outDir = res.outDir ?? null;
      const exportedCount = res.summary?.total ?? 0;
      setModalCurrent(exportedCount);

      // Перевантажуємо всі прев'ю після exportAll. Маємо актуальний список
      // з IPC — швидше, ніж пройтись по HBR_TEXTURES і дзвонити N разів.
      const list = await window.dp2.hbrTexturesList();
      if (list && list.files) {
        const byPathId = new Map<string, string>();
        for (const f of list.files) {
          const pid = pathIdFromFileName(f.name);
          if (pid) byPathId.set(pid, f.path);
        }
        const tasks = HBR_TEXTURES.map(async (tx): Promise<[string, Preview] | null> => {
          const fp = byPathId.get(tx.pathId);
          if (!fp) return null;
          const b64 = await window.dp2.hbrTexturesReadBase64(fp);
          if (!b64) return null;
          return [tx.id, { src: `data:image/png;base64,${b64}`, mtime: Date.now() }];
        });
        const results = await Promise.all(tasks);
        const nextPrev: Record<string, Preview> = { ...previews };
        for (const r of results) if (r) nextPrev[r[0]] = r[1];
        setPreviews(nextPrev);
      }

      if (outDir) setExportedDir(outDir);
      setModalResult({ outDir: outDir ?? undefined, exportedCount });
      setModalDone(true);
    } catch (e: unknown) {
      setModalError(e instanceof Error ? e.message : String(e));
      setModalDone(true);
    } finally {
      setStatus("idle");
    }
  }

  async function replaceTexture(tx: HbrTextureEntry) {
    const picked = await window.dp2.pickFile({
      title: t("textures.replace.pickTitle", { name: tx.name }),
      filters: [{ name: "PNG", extensions: ["png"] }],
    });
    if (!picked) return;

    const ok = await showConfirm(
      t("textures.replace.confirmTitle"),
      t("textures.replace.confirmBody", { name: tx.name, pathId: tx.pathId, file: picked }),
      { okLabel: t("textures.replace.confirmOk"), cancelLabel: t("btn.cancel") }
    );
    if (!ok) return;

    setBusyIds((s) => new Set(s).add(tx.id));
    setStatus("replacing");
    openModal("replace", { name: tx.name, pathId: tx.pathId });
    try {
      const res = await window.dp2.hbrTexturesReplace({
        items: [{ pathId: tx.pathId, pngPath: picked }],
      });
      if (!res.success) {
        setModalError(localizeBackendError(res.error) || "?");
        setModalDone(true);
        return;
      }
      // Оновити прев'ю — підвантажуємо PNG, який щойно патчили в гру.
      const b64 = await window.dp2.hbrTexturesReadBase64(picked);
      if (b64) setPreviews((p) => ({ ...p, [tx.id]: { src: `data:image/png;base64,${b64}`, mtime: Date.now() } }));

      setModalResult({ mode: "bundle-inplace", output: res.bundle });
      setModalDone(true);
    } catch (e: unknown) {
      setModalError(e instanceof Error ? e.message : String(e));
      setModalDone(true);
    } finally {
      setBusyIds((s) => { const n = new Set(s); n.delete(tx.id); return n; });
      setStatus("idle");
    }
  }

  return (
    <div className="flex-1 flex flex-col bg-[var(--bg)] min-h-0">
      <header className="min-h-12 px-4 py-1.5 border-b border-[var(--border-soft)] bg-[var(--bg-surface)] flex flex-wrap items-center gap-3 shrink-0">
        <button className="dp-btn dp-btn--ghost shrink-0" onClick={onHome} title={t("header.home")}>
          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M10 19l-7-7m0 0l7-7m-7 7h18" />
          </svg>
        </button>
        <span className="text-[13px] text-[var(--text-muted)] shrink-0">{t("hbr.textures.brand")}</span>
        <span className="text-[11px] text-[var(--text-faint)] tabular-nums shrink-0">
          {HBR_TEXTURES.length} {t("textures.count")}
        </span>
        <div className="flex-1 min-w-0" />
        {exportedDir && (
          <button
            className="dp-btn dp-btn--ghost shrink-0"
            onClick={() => window.dp2.openFolder(exportedDir)}
            title={t("textures.openDir")}
          >
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M3 7h4l2 2h12v9a2 2 0 01-2 2H3V7z" />
            </svg>
            {t("textures.openDir")}
          </button>
        )}
        <button
          className="dp-btn dp-btn--primary shrink-0"
          disabled={status !== "idle"}
          onClick={exportAll}
        >
          {status === "exporting" ? t("textures.busy.exporting") : t("textures.exportAll")}
        </button>
      </header>

      <div className="px-4 py-3 border-b border-[var(--border-soft)] flex flex-wrap items-center gap-2 shrink-0">
        <input
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={t("textures.search.placeholder")}
          className="dp-input flex-1 max-w-md"
        />
        <div className="flex gap-1 ml-2 flex-wrap">
          {groups.map((g) => (
            <button
              key={g}
              onClick={() => setGroupFilter(g)}
              className={`dp-btn ${groupFilter === g ? "dp-btn--primary" : ""}`}
            >
              {g === "all" ? t("textures.group.all") : g}
            </button>
          ))}
        </div>
      </div>

      <div className="flex-1 min-h-0 overflow-auto p-4">
        {filtered.length === 0 ? (
          <p className="py-10 text-center text-[13px] text-[var(--text-muted)]">
            {t("textures.empty")}
          </p>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
            {filtered.map((tx) => {
              const prev = previews[tx.id];
              const busy = busyIds.has(tx.id);
              return (
                <div
                  key={tx.id}
                  className="rounded-lg border border-[var(--border-soft)] bg-[var(--bg-surface)] overflow-hidden flex flex-col"
                >
                  <div className="relative bg-[var(--bg-elevated)] aspect-square flex items-center justify-center overflow-hidden">
                    {prev ? (
                      <img
                        src={prev.src}
                        alt={tx.name}
                        className="w-full h-full object-contain"
                        style={{ imageRendering: "auto" }}
                      />
                    ) : (
                      <div className="text-center text-[11px] text-[var(--text-faint)] px-3">
                        <svg className="w-8 h-8 mx-auto mb-2 opacity-40" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M4 16l4-4a3 3 0 014 0l4 4M14 14l1.5-1.5a3 3 0 014 0L21 14M4 4h16a2 2 0 012 2v12a2 2 0 01-2 2H4a2 2 0 01-2-2V6a2 2 0 012-2z" />
                          <circle cx="9" cy="9" r="1.5" fill="currentColor" />
                        </svg>
                        {t("textures.noPreview")}
                      </div>
                    )}
                    {busy && (
                      <div className="absolute inset-0 bg-[var(--bg)]/70 backdrop-blur-[1px] flex flex-col items-center justify-center gap-2 text-[var(--text)]">
                        <span className="inline-block w-6 h-6 rounded-full border-2 border-[var(--text-faint)] border-t-[var(--accent,#3b82f6)] animate-spin" aria-hidden />
                      </div>
                    )}
                  </div>
                  <div className="p-3 flex flex-col gap-2">
                    <div className="min-w-0">
                      <p className="text-[13px] font-semibold text-[var(--text-strong)] truncate" title={tx.name}>
                        {tx.name}
                      </p>
                      <p className="text-[11px] font-mono text-[var(--text-faint)]">
                        PathID {tx.pathId}
                        {tx.group ? ` · ${tx.group}` : ""}
                      </p>
                    </div>
                    <div className="flex gap-2">
                      <button
                        className="dp-btn flex-1"
                        disabled={busy || status !== "idle"}
                        onClick={() => exportTexture(tx)}
                        title={t("textures.card.export")}
                      >
                        <svg className="w-3 h-3 mr-1 inline" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M4 16v2a2 2 0 002 2h12a2 2 0 002-2v-2M7 10l5 5 5-5M12 15V3" />
                        </svg>
                        {t("textures.card.export")}
                      </button>
                      <button
                        className="dp-btn dp-btn--success flex-1"
                        disabled={busy || status !== "idle"}
                        onClick={() => replaceTexture(tx)}
                        title={t("textures.card.replace")}
                      >
                        <svg className="w-3 h-3 mr-1 inline" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h5M20 20v-5h-5M4 9a8 8 0 0114-3M20 15a8 8 0 01-14 3" />
                        </svg>
                        {t("textures.card.replace")}
                      </button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <Dp2TextureBusyModal
        open={modalOpen}
        kind={modalKind}
        target={modalTarget}
        current={modalCurrent}
        total={modalTotal}
        statusLine={modalStatus}
        lines={modalLines}
        done={modalDone}
        error={modalError}
        result={modalResult}
        onClose={() => setModalOpen(false)}
      />
    </div>
  );
}
