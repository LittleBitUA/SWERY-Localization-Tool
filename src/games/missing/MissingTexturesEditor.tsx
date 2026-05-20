// THE MISSING — textures editor. Робота з двома цільовими текстурами:
//   - NPC05_signboard_al  (sharedassets25.assets, pathId 21)
//   - OBJ_Graffiti_01     (sharedassets44.assets, pathId 69)
// Перевикористовуємо DP2-PowerShell-скрипти textures-export.ps1 та
// textures-replace.ps1 — вони працюють per-pathId і не залежать від гри.
// Прев'ю PNG — звичайний <img src="data:image/png;base64,…">.

import { useEffect, useState } from "react";
import { useT } from "../../lib/i18n";
import { alert as dpAlert, confirm as dpConfirm } from "../../lib/dialogs";

interface Props { onHome: () => void; }

interface TexItem {
  name: string;
  pathId: number;
  assets: string;
  fileName: string;
  origPath: string;
  replacePath: string;
  hasOrig: boolean;
  hasReplace: boolean;
  replaceSize: number;
}

interface MissingTexturesApi {
  missingTexturesStatus: () => Promise<{ ok: boolean; assetsOk?: boolean; items: TexItem[]; error?: string; assetsPath?: string }>;
  missingTexturesExport: () => Promise<{ ok: boolean; error?: string; summary?: { total: number } }>;
  missingTexturesPickReplace: (p: { item: TexItem }) => Promise<{ ok: boolean; error?: string }>;
  missingTexturesClearReplace: (p: { item: TexItem }) => Promise<{ ok: boolean; error?: string }>;
  missingTexturesPack: () => Promise<{ ok: boolean; error?: string; summary?: { applied: number; failed: Array<{ name: string; reason: string }>; changedAssets: string[] } }>;
  onMissingTexturesProgress: (cb: (line: string) => void) => () => void;
  onMissingTexturesPackProgress: (cb: (line: string) => void) => () => void;
  missingTextRead: (path: string) => Promise<{ ok: boolean; base64?: string }>;
  openFolder?: (path: string) => void;
}
const W = window.dp2 as unknown as MissingTexturesApi;

type Phase = "loading" | "needs-export" | "ready" | "exporting" | "error";

export function MissingTexturesEditor({ onHome }: Props) {
  const t = useT();
  const [phase, setPhase] = useState<Phase>("loading");
  const [errMsg, setErrMsg] = useState<string | null>(null);
  const [items, setItems] = useState<TexItem[]>([]);
  const [exportLog, setExportLog] = useState<string[]>([]);
  const [packLog, setPackLog] = useState<string[]>([]);
  const [packing, setPacking] = useState(false);

  async function refreshStatus() {
    const s = await W.missingTexturesStatus();
    if (!s.ok) { setPhase("error"); setErrMsg(s.error || "?"); return; }
    if (!s.assetsOk) { setPhase("error"); setErrMsg(`sharedassets*.assets не знайдено у ${s.assetsPath ? s.assetsPath.replace(/[\\/][^\\/]+$/, "") : "?"}`); return; }
    setItems(s.items);
    const exportedCount = s.items.filter((i) => i.hasOrig).length;
    if (exportedCount === 0) setPhase("needs-export");
    else setPhase("ready");
  }

  useEffect(() => {
    refreshStatus();
    const offX = W.onMissingTexturesProgress((line) => setExportLog((prev) => [...prev.slice(-40), line]));
    const offP = W.onMissingTexturesPackProgress((line) => setPackLog((prev) => [...prev.slice(-40), line]));
    return () => { offX?.(); offP?.(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function runExport() {
    setPhase("exporting"); setExportLog([]);
    const r = await W.missingTexturesExport();
    if (!r.ok) { setPhase("error"); setErrMsg(r.error || "export fail"); return; }
    await refreshStatus();
    await dpAlert(t("missing.textures.exportDoneTitle"), t("missing.textures.exportDoneBody", { n: String(r.summary?.total ?? 0) }), { tone: "success" });
  }

  async function pickReplace(it: TexItem) {
    const r = await W.missingTexturesPickReplace({ item: it });
    if (r.ok) await refreshStatus();
    else if (r.error && r.error !== "cancelled") await dpAlert(t("missing.textures.pickErr"), r.error, { tone: "danger" });
  }

  async function clearReplace(it: TexItem) {
    const ok = await dpConfirm(t("missing.textures.clearTitle"), t("missing.textures.clearBody", { name: it.name }), { tone: "warning" });
    if (!ok) return;
    await W.missingTexturesClearReplace({ item: it });
    await refreshStatus();
  }

  async function runPack() {
    if (packing) return;
    const replaceCount = items.filter((i) => i.hasReplace).length;
    if (replaceCount === 0) {
      await dpAlert(t("missing.textures.nothingTitle"), t("missing.textures.nothingBody"), { tone: "warning" });
      return;
    }
    setPacking(true); setPackLog([]);
    try {
      const r = await W.missingTexturesPack();
      if (!r.ok) { await dpAlert(t("missing.textures.packErrTitle"), r.error || "?", { tone: "danger" }); return; }
      const applied = r.summary?.applied ?? 0;
      const failed = (r.summary?.failed?.length ?? 0);
      const changed = (r.summary?.changedAssets ?? []) as string[];
      await dpAlert(
        failed > 0 ? t("missing.textures.packDoneWarnTitle") : t("missing.textures.packDoneTitle"),
        t("missing.textures.packDoneBody", { applied: String(applied), failed: String(failed), files: changed.join(", ") || "—" }),
        { tone: failed > 0 ? "warning" : "success" }
      );
    } finally {
      setPacking(false);
    }
  }

  const replaceCount = items.filter((i) => i.hasReplace).length;

  const [search, setSearch] = useState("");
  const filtered = items.filter((it) => {
    const q = search.trim().toLowerCase();
    if (!q) return true;
    return it.name.toLowerCase().includes(q) || String(it.pathId).includes(q) || it.assets.toLowerCase().includes(q);
  });

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <header className="h-12 px-4 border-b border-[var(--border-soft)] bg-[var(--bg)] flex items-center gap-3 shrink-0">
        <button className="dp-btn dp-btn--ghost" onClick={onHome}>← {t("btn.home")}</button>
        <span className="text-[13px] font-semibold text-[var(--text-strong)]">THE MISSING</span>
        <span className="text-[11px] text-[var(--text-faint)]">— {t("missing.textures.title")} · {items.length}</span>
        <div className="flex-1" />
        {phase === "ready" && (
          <>
            <span className="text-[11px] text-[var(--text-muted)] mr-1">{replaceCount} / {items.length}</span>
            <button
              className="dp-btn dp-btn--ghost"
              onClick={() => {
                const sample = items[0];
                if (sample?.origPath) {
                  const dir = sample.origPath.replace(/[\\/][^\\/]+$/, "");
                  W.openFolder?.(dir);
                }
              }}
              title={t("missing.textures.openFolderHint")}
            >
              <svg className="w-3.5 h-3.5 mr-1 inline" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-7l-2-2H5a2 2 0 00-2 2z" />
              </svg>
              {t("missing.textures.openFolder")}
            </button>
            <button className="dp-btn dp-btn--ghost" onClick={runExport}>{t("missing.textures.reExport")}</button>
            <button className="dp-btn dp-btn--success" disabled={packing || replaceCount === 0} onClick={runPack}>
              {packing ? "…" : t("missing.textures.pack")}
            </button>
          </>
        )}
      </header>

      {phase === "loading" && <div className="flex-1 flex items-center justify-center text-[var(--text-muted)]">{t("missing.editor.loading")}</div>}

      {phase === "error" && (
        <div className="flex-1 flex flex-col items-center justify-center p-8 gap-3">
          <div className="text-[14px] font-semibold text-[var(--danger)]">{t("missing.editor.errorTitle")}</div>
          <div className="text-[12px] text-[var(--text-muted)] max-w-xl text-center">{errMsg}</div>
        </div>
      )}

      {phase === "needs-export" && (
        <div className="flex-1 flex flex-col items-center justify-center p-8 gap-3">
          <svg className="w-12 h-12 text-[var(--text-faint)]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
          </svg>
          <div className="text-[14px] font-semibold text-[var(--text-strong)]">{t("missing.textures.exportTitle")}</div>
          <div className="text-[12px] text-[var(--text-muted)] max-w-xl text-center mb-4">{t("missing.textures.exportBody")}</div>
          <button className="dp-btn dp-btn--primary" onClick={runExport}>{t("missing.textures.exportBtn")}</button>
        </div>
      )}

      {phase === "exporting" && (
        <div className="fixed inset-0 z-40 bg-black/60 flex items-center justify-center p-6">
          <div className="w-full max-w-[560px] bg-[var(--bg-surface)] border border-[var(--border-soft)] rounded-lg shadow-xl">
            <div className="px-5 py-3 border-b border-[var(--border-soft)] flex items-center gap-3">
              <span className="inline-block h-3 w-3 rounded-full border-2 border-[var(--accent)] border-t-transparent animate-spin" />
              <p className="text-[13px] font-semibold text-[var(--text-strong)]">{t("missing.textures.exporting")}</p>
            </div>
            <div className="px-5 py-3 text-[10.5px] font-mono bg-[var(--bg)] max-h-[260px] overflow-y-auto whitespace-pre-wrap">
              {exportLog.length === 0 ? <span className="text-[var(--text-faint)]">{t("missing.pack.starting")}</span> : exportLog.map((l, i) => <div key={i} className={l.startsWith("Exported") ? "text-[var(--success)]" : l.startsWith("[STEP]") ? "text-[var(--accent)]" : "text-[var(--text-muted)]"}>{l}</div>)}
            </div>
          </div>
        </div>
      )}

      {phase === "ready" && (
        <>
          <div className="px-4 py-3 border-b border-[var(--border-soft)] flex flex-wrap items-center gap-2 shrink-0">
            <input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t("missing.textures.searchPlaceholder")}
              className="dp-input flex-1 max-w-md"
            />
            <span className="text-[11px] text-[var(--text-faint)] tabular-nums">{filtered.length}/{items.length}</span>
          </div>
          <div className="flex-1 min-h-0 overflow-auto p-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
              {filtered.map((it) => (
                <MissingTextureCard
                  key={it.pathId}
                  item={it}
                  onPickReplace={() => pickReplace(it)}
                  onClearReplace={() => clearReplace(it)}
                />
              ))}
            </div>
          </div>
        </>
      )}

      {packing && (
        <div className="fixed inset-0 z-40 bg-black/60 flex items-center justify-center p-6">
          <div className="w-full max-w-[560px] bg-[var(--bg-surface)] border border-[var(--border-soft)] rounded-lg shadow-xl">
            <div className="px-5 py-3 border-b border-[var(--border-soft)] flex items-center gap-3">
              <span className="inline-block h-3 w-3 rounded-full border-2 border-[var(--accent)] border-t-transparent animate-spin" />
              <p className="text-[13px] font-semibold text-[var(--text-strong)]">{t("missing.textures.packing")}</p>
            </div>
            <div className="px-5 py-3 text-[10.5px] font-mono bg-[var(--bg)] max-h-[260px] overflow-y-auto whitespace-pre-wrap">
              {packLog.length === 0 ? <span className="text-[var(--text-faint)]">{t("missing.pack.starting")}</span> : packLog.map((l, i) => <div key={i} className={/PathID|Encoded|Wrote|Output|DONE/i.test(l) ? "text-[var(--success)]" : "text-[var(--text-muted)]"}>{l}</div>)}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function MissingTextureCard({ item, onPickReplace, onClearReplace }: { item: TexItem; onPickReplace: () => void; onClearReplace: () => void }) {
  const t = useT();
  // Прев'ю: показуємо ЗАМІНУ якщо є, інакше оригінал — користувач одразу
  // бачить що з'явиться у грі. Такий же підхід як DP2 fonts (FontFace) і
  // DP2 textures.
  const [previewUrl, setPreviewUrl] = useState<string>("");

  useEffect(() => {
    let cancelled = false;
    const target = item.hasReplace ? item.replacePath : (item.hasOrig ? item.origPath : "");
    if (!target) { setPreviewUrl(""); return; }
    W.missingTextRead(target).then((r) => {
      if (!cancelled && r.ok && r.base64) setPreviewUrl(`data:image/png;base64,${r.base64}`);
    });
    return () => { cancelled = true; };
  }, [item.origPath, item.replacePath, item.hasOrig, item.hasReplace, item.replaceSize]);

  return (
    <div className={`rounded-lg border bg-[var(--bg-surface)] overflow-hidden flex flex-col ${item.hasReplace ? "border-[var(--success)]/40" : "border-[var(--border-soft)]"}`}>
      <div className="relative bg-[var(--bg-elevated)] aspect-square flex items-center justify-center overflow-hidden">
        {previewUrl ? (
          <img src={previewUrl} alt={item.name} className="w-full h-full object-contain" style={{ imageRendering: "auto" }} />
        ) : (
          <div className="text-center text-[11px] text-[var(--text-faint)] px-3">
            <svg className="w-8 h-8 mx-auto mb-2 opacity-40" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M4 16l4-4a3 3 0 014 0l4 4M14 14l1.5-1.5a3 3 0 014 0L21 14M4 4h16a2 2 0 012 2v12a2 2 0 01-2 2H4a2 2 0 01-2-2V6a2 2 0 012-2z" />
              <circle cx="9" cy="9" r="1.5" fill="currentColor" />
            </svg>
            {t("missing.textures.noPreview")}
          </div>
        )}
        {item.hasReplace && (
          <span className="absolute top-2 right-2 dp-pill dp-pill--success">
            {t("missing.textures.card.replaced")}
          </span>
        )}
      </div>
      <div className="p-3 flex flex-col gap-2">
        <div className="min-w-0">
          <p className="text-[13px] font-semibold text-[var(--text-strong)] truncate" title={item.name}>{item.name}</p>
          <p className="text-[11px] font-mono text-[var(--text-faint)] truncate">
            PathID {item.pathId} · {item.assets}
          </p>
        </div>
        <div className="flex gap-2">
          {item.hasReplace ? (
            <>
              <button className="dp-btn flex-1" onClick={onPickReplace} title={t("missing.textures.replaceAgain")}>
                ↺ {t("missing.textures.replaceAgain")}
              </button>
              <button className="dp-btn dp-btn--ghost" onClick={onClearReplace} title={t("missing.textures.clearReplace")}>✕</button>
            </>
          ) : (
            <button className="dp-btn dp-btn--success flex-1" onClick={onPickReplace}>
              <svg className="w-3 h-3 mr-1 inline" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M4 16v2a2 2 0 002 2h12a2 2 0 002-2v-2M7 14l5 5 5-5M12 19V3" transform="rotate(180 12 12)" />
              </svg>
              {t("missing.textures.pickReplace")}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
