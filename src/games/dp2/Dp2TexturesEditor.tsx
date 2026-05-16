import { useEffect, useMemo, useState } from "react";
import { useT } from "../../lib/i18n";
import { alert as showAlert, confirm as showConfirm } from "../../lib/dialogs";
import { DP2_TEXTURES, type TextureEntry } from "./textures-list";

interface Dp2TexturesEditorProps {
  onHome: () => void;
}

type Status = "idle" | "exporting" | "replacing";
type Preview = { src: string; mtime: number };

export function Dp2TexturesEditor({ onHome }: Dp2TexturesEditorProps) {
  const t = useT();

  const [status, setStatus] = useState<Status>("idle");
  const [globalMsg, setGlobalMsg] = useState<string>("");
  const [previews, setPreviews] = useState<Record<string, Preview>>({});
  const [exportedDir, setExportedDir] = useState<string | null>(null);
  const [busyIds, setBusyIds] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState("");
  const [groupFilter, setGroupFilter] = useState<string>("all");

  const groups = useMemo(() => {
    const s = new Set<string>();
    for (const tx of DP2_TEXTURES) if (tx.group) s.add(tx.group);
    return ["all", ...Array.from(s).sort()];
  }, []);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return DP2_TEXTURES.filter((tx) => {
      if (groupFilter !== "all" && tx.group !== groupFilter) return false;
      if (!q) return true;
      return (
        tx.name.toLowerCase().includes(q) ||
        tx.id.toLowerCase().includes(q) ||
        String(tx.pathId).includes(q)
      );
    });
  }, [search, groupFilter]);

  // На монтуванні: спробувати підвантажити локальні PNG, якщо є.
  // Виконуємо паралельно (Promise.all) — раніше було послідовно, для 20+
  // текстур це додавало 20× IPC roundtrip + base64 decode.
  useEffect(() => {
    (async () => {
      const list = await window.dp2.texturesList();
      if (!list || !list.files?.length) return;
      if (list.dir) setExportedDir(list.dir);
      const tasks = DP2_TEXTURES.map(async (tx): Promise<[string, Preview] | null> => {
        const f = list.files.find((x) =>
          x.name === `${tx.name}-${tx.assetsFile}-${tx.pathId}.png`
        );
        if (!f) return null;
        const b64 = await window.dp2.texturesReadBase64(f.path);
        if (!b64) return null;
        return [tx.id, { src: `data:image/png;base64,${b64}`, mtime: Date.now() }];
      });
      const results = await Promise.all(tasks);
      const map: Record<string, Preview> = {};
      for (const r of results) if (r) map[r[0]] = r[1];
      if (Object.keys(map).length) setPreviews(map);
    })().catch(() => {});
  }, []);

  async function exportTexture(tx: TextureEntry) {
    if (status !== "idle") return; // глобальний lock — два паралельні Replace на одне .assets зруйнують offset table.
    setBusyIds((s) => new Set(s).add(tx.id));
    setStatus("exporting");
    try {
      const res = await window.dp2.texturesExport({
        assetsFile: tx.assetsFile,
        pathIds: [tx.pathId],
      });
      if (!res.success) {
        await showAlert(t("textures.export.errTitle"), res.error ?? "?", { tone: "danger" });
        return;
      }
      const exported = res.exported?.find((e) => e.pathId === tx.pathId);
      if (exported) {
        const b64 = await window.dp2.texturesReadBase64(exported.file);
        if (b64) setPreviews((p) => ({ ...p, [tx.id]: { src: `data:image/png;base64,${b64}`, mtime: Date.now() } }));
      }
      if (res.outDir) setExportedDir(res.outDir);
    } finally {
      setBusyIds((s) => { const n = new Set(s); n.delete(tx.id); return n; });
    }
  }

  async function exportAll() {
    setStatus("exporting");
    setGlobalMsg(t("textures.export.running", { n: DP2_TEXTURES.length }));
    try {
      // Групуємо за assetsFile (зараз один resources.assets, але архітектурно правильно)
      const byFile = new Map<string, number[]>();
      for (const tx of DP2_TEXTURES) {
        if (!byFile.has(tx.assetsFile)) byFile.set(tx.assetsFile, []);
        byFile.get(tx.assetsFile)!.push(tx.pathId);
      }
      const allExported: Array<{ pathId: number; file: string }> = [];
      let firstDir: string | null = null;
      for (const [assetsFile, pathIds] of byFile) {
        const res = await window.dp2.texturesExport({ assetsFile, pathIds });
        if (!res.success) {
          await showAlert(t("textures.export.errTitle"), res.error ?? "?", { tone: "danger" });
          return;
        }
        if (res.outDir && !firstDir) firstDir = res.outDir;
        if (res.exported) {
          for (const e of res.exported) allExported.push({ pathId: e.pathId, file: e.file });
        }
      }
      // Завантажити прев'ю паралельно (Promise.all) — 20+ файлів × 1MB кожен,
      // послідовно це 5-10 сек, паралельно 1-2 сек.
      const previewTasks = DP2_TEXTURES.map(async (tx): Promise<[string, Preview] | null> => {
        const hit = allExported.find((e) => e.pathId === tx.pathId);
        if (!hit) return null;
        const b64 = await window.dp2.texturesReadBase64(hit.file);
        if (!b64) return null;
        return [tx.id, { src: `data:image/png;base64,${b64}`, mtime: Date.now() }];
      });
      const previewResults = await Promise.all(previewTasks);
      const nextPrev: Record<string, Preview> = { ...previews };
      for (const r of previewResults) if (r) nextPrev[r[0]] = r[1];
      setPreviews(nextPrev);
      if (firstDir) setExportedDir(firstDir);
      setGlobalMsg(t("textures.export.done", { n: allExported.length }));
      await showAlert(t("textures.export.successTitle"), t("textures.export.successBody", { n: allExported.length, dir: firstDir ?? "—" }), { tone: "success" });
    } finally {
      setStatus("idle");
      setTimeout(() => setGlobalMsg(""), 6000);
    }
  }

  async function replaceTexture(tx: TextureEntry) {
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
    setGlobalMsg(t("textures.replace.running", { name: tx.name }));
    try {
      const res = await window.dp2.texturesReplace({
        pathId: tx.pathId,
        newPngPath: picked,
        assetsFile: tx.assetsFile,
      });
      if (!res.success) {
        await showAlert(t("textures.replace.errTitle"), res.error ?? "?", { tone: "danger" });
        return;
      }
      // Оновити прев'ю — підвантажуємо PNG, який щойно патчили в гру
      const b64 = await window.dp2.texturesReadBase64(picked);
      if (b64) setPreviews((p) => ({ ...p, [tx.id]: { src: `data:image/png;base64,${b64}`, mtime: Date.now() } }));

      const where = res.mode === "resS-inplace"
        ? t("textures.replace.successInplace", { resS: res.resS ?? "", offset: res.offset ?? 0, size: res.size ?? 0 })
        : t("textures.replace.successAssets", { output: res.output ?? "" });
      await showAlert(t("textures.replace.successTitle"), where, { tone: "success" });
      setGlobalMsg(t("textures.replace.done", { name: tx.name }));
    } finally {
      setBusyIds((s) => { const n = new Set(s); n.delete(tx.id); return n; });
      setStatus("idle");
      setTimeout(() => setGlobalMsg(""), 6000);
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
        <span className="text-[13px] text-[var(--text-muted)] shrink-0">{t("textures.brand")}</span>
        <span className="text-[11px] text-[var(--text-faint)] tabular-nums shrink-0">
          {DP2_TEXTURES.length} {t("textures.count")}
        </span>
        <div className="flex-1 min-w-0" />
        {globalMsg && (
          <span className={`text-[11px] font-mono px-2.5 py-1 rounded shrink-0 ${
            status === "exporting" || status === "replacing" ? "dp-pill" : "dp-pill--success"
          }`}>
            {globalMsg}
          </span>
        )}
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
                      <div className="absolute inset-0 bg-[var(--bg)]/70 flex items-center justify-center text-[12px] text-[var(--text)]">
                        ⏳ {t("textures.busy.short")}
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
    </div>
  );
}
