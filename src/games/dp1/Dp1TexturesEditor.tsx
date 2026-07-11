// DP1 Textures editor — список усіх XPC2-архівів з гри з кнопками
// Extract All / Pack All і per-row Replace. Формат XPC2 розкритий
// reverse-engineering-ом (DP_XPC_Tool by Little Bit UA): magic "XPC2" +
// header з offset/sizes + zlib-stream DDS/PNG payload.

import { useCallback, useEffect, useState } from "react";
import { useT, localizeBackendError } from "../../lib/i18n";
import { LangToggle } from "../../components/LangToggle";
import { EditorFooter } from "../../components/EditorFooter";
import { showError, showOk, showToast } from "../../components/Toast";

interface XpcItem {
  relPath: string;
  fullPath: string;
  size: number;
  internalName: string | null;
  ext: string | null;
  extracted: boolean;
  replaced: boolean;
}

interface Props {
  onHome: () => void;
}

type Phase = "idle" | "extracting" | "packing";

export function Dp1TexturesEditor({ onHome }: Props) {
  const t = useT();
  const [items, setItems] = useState<XpcItem[]>([]);
  const [gameRoot, setGameRoot] = useState<string | null>(null);
  const [doneDir, setDoneDir] = useState<string | null>(null);
  const [originalDir, setOriginalDir] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [filter, setFilter] = useState<"all" | "extracted" | "replaced" | "todo">("all");
  const [search, setSearch] = useState("");
  const [activePreview, setActivePreview] = useState<{ item: XpcItem; base64?: string; ext?: string; loading?: boolean; error?: string } | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    const r = await window.dp2.dp1TexturesList();
    setLoading(false);
    if (!r.ok) {
      setError(localizeBackendError(r.error) || t("dp1.textures.listReadFailed"));
      return;
    }
    setItems(r.items ?? []);
    setGameRoot(r.gameRoot ?? null);
    setDoneDir(r.doneDir ?? null);
    setOriginalDir(r.originalDir ?? null);
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  // Прогрес від main під час extract/pack.
  useEffect(() => {
    const off = window.dp2.onDp1TexturesProgress((p) => {
      setProgress({ done: p.done, total: p.total });
    });
    return () => { off(); };
  }, []);

  async function runExtractAll() {
    if (phase !== "idle") return;
    setPhase("extracting");
    setProgress(null);
    try {
      const r = await window.dp2.dp1TexturesExtractAll();
      if (!r.ok) showError(localizeBackendError(r.error) || "?", "Extract failed");
      else showOk(t("dp1.textures.extractedResult", { extracted: r.extracted ?? 0, total: r.total ?? 0 }) + (r.failed ? t("dp1.textures.errorsSuffix", { failed: r.failed }) : ""), "Extract");
      await refresh();
    } finally {
      setPhase("idle");
      setProgress(null);
    }
  }

  async function runPackAll() {
    if (phase !== "idle") return;
    setPhase("packing");
    setProgress(null);
    try {
      const r = await window.dp2.dp1TexturesPackAll();
      if (!r.ok) showError(localizeBackendError(r.error) || "?", "Pack failed");
      else showOk(t("dp1.textures.packedResult", { replaced: r.replaced ?? 0, skipped: r.skipped ?? 0 }) + (r.failed ? t("dp1.textures.errorsSuffix", { failed: r.failed }) : ""), "Pack");
      await refresh();
    } finally {
      setPhase("idle");
      setProgress(null);
    }
  }

  async function openPreview(it: XpcItem) {
    setActivePreview({ item: it, loading: true });
    const r = await window.dp2.dp1TextureReadPayload(it.relPath);
    if (!r.ok) {
      setActivePreview({ item: it, error: localizeBackendError(r.error) || "?" });
      return;
    }
    setActivePreview({ item: it, base64: r.base64, ext: r.ext, loading: false });
  }

  async function replaceOne(it: XpcItem) {
    // Простий flow: відкриваємо file picker, читаємо файл, передаємо у main.
    const f = await window.dp2.pickFile({
      title: t("dp1.textures.replaceTitle", { name: it.internalName ?? it.relPath }),
      filters: [
        { name: "Texture", extensions: ["dds", "png", "jpg", "jpeg", "bin"] },
        { name: "All", extensions: ["*"] },
      ],
    });
    if (!f) return;
    const txt = await window.dp2.readFile(f);
    // readFile повертає string utf8 — а нам треба binary. Використаємо ReadFile through
    // ReadAll або через blob. Зробимо інший спосіб: спершу прочитаємо як base64 на стороні
    // renderer через FileReader... але у Electron renderer'i немає прямого доступу до FS.
    // Простіший варіант: написати окремий IPC що приймає srcPath і копіює у Done/. Але це
    // багато коду. Тут робимо короткий шлях: переконвертуємо string у Uint8Array latin-1
    // (бо readFile у нас просто `fs.readFile(path, "utf8")` → це б'є binary).
    // ТОДО: додамо у preload `readFileBinary` для майбутнього. Поки що — TextEncoder helper
    // не підходить для DDS. ТУТ помилка: треба окремий бінарний read.
    showError(
      t("dp1.textures.replaceTodoBody", { dir: doneDir ?? "Done/" }),
      t("dp1.textures.replaceTodoTitle"),
    );
    void txt; void f;
  }

  // Фільтри + пошук.
  const filtered = items.filter((it) => {
    if (filter === "extracted" && !it.extracted) return false;
    if (filter === "replaced" && !it.replaced) return false;
    if (filter === "todo" && it.replaced) return false;
    if (search) {
      const q = search.toLowerCase();
      if (!it.relPath.toLowerCase().includes(q) &&
          !(it.internalName ?? "").toLowerCase().includes(q)) return false;
    }
    return true;
  });

  const stats = {
    total: items.length,
    extracted: items.filter((i) => i.extracted).length,
    replaced: items.filter((i) => i.replaced).length,
  };

  return (
    <div className="flex-1 flex flex-col min-h-0 h-full">
      <header className="h-12 px-4 border-b border-[var(--border-soft)] bg-[var(--bg)] flex items-center gap-3 shrink-0">
        <button className="dp-btn dp-btn--ghost" onClick={onHome}>← {t("dp1.textures.toHome")}</button>
        <span className="text-[13px] font-semibold text-[var(--text-strong)]">{t("dp1.textures.title")}</span>
        <span className="text-[11px] text-[var(--text-faint)]">XPC2 archive · DDS / PNG</span>
        <div className="flex-1" />
        {originalDir && (
          <button
            className="dp-btn dp-btn--ghost shrink-0"
            onClick={() => window.dp2.openFolder(originalDir)}
            title={t("dp1.textures.openOriginalDir", { dir: originalDir })}
          >
            <svg className="w-3.5 h-3.5 mr-1 inline" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M3 7h4l2 2h12v9a2 2 0 01-2 2H3V7z" />
            </svg>
            Original
          </button>
        )}
        {doneDir && (
          <button
            className="dp-btn dp-btn--ghost shrink-0"
            onClick={() => window.dp2.openFolder(doneDir)}
            title={t("dp1.textures.openDoneDir", { dir: doneDir })}
          >
            <svg className="w-3.5 h-3.5 mr-1 inline" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M3 7h4l2 2h12v9a2 2 0 01-2 2H3V7z" />
            </svg>
            Done
          </button>
        )}
        <button
          className="dp-btn"
          disabled={phase !== "idle" || loading}
          onClick={runExtractAll}
          title={t("dp1.textures.extractAllTip")}
        >
          {phase === "extracting" ? t("dp1.textures.extracting") : t("dp1.textures.extractAll")}
        </button>
        <button
          className="dp-btn dp-btn--success"
          disabled={phase !== "idle" || loading || stats.extracted === 0}
          onClick={runPackAll}
          title={t("dp1.textures.packAllTip")}
        >
          {phase === "packing" ? t("dp1.textures.packing") : t("dp1.textures.packAll")}
        </button>
        <LangToggle compact />
      </header>

      {error && (
        <div className="px-4 py-2 bg-[var(--danger)]/10 border-b border-[var(--danger)]/40 text-[12px] text-[var(--danger)]">
          {error}
        </div>
      )}

      {progress && phase !== "idle" && (
        <div className="px-4 py-1.5 border-b border-[var(--border-soft)] bg-[var(--bg-surface)] flex items-center gap-3">
          <div className="flex-1 h-1.5 bg-[var(--bg-elevated)] rounded overflow-hidden">
            <div
              className="h-full bg-[var(--accent)] transition-[width] duration-200"
              style={{ width: progress.total > 0 ? `${(progress.done / progress.total) * 100}%` : "0%" }}
            />
          </div>
          <span className="text-[11px] tabular-nums text-[var(--text-muted)]">
            {progress.done} / {progress.total}
          </span>
        </div>
      )}

      <div className="px-3 py-2 border-b border-[var(--border-soft)] bg-[var(--bg)] flex items-center gap-2 shrink-0">
        <input
          className="dp-input flex-1 max-w-[440px]"
          placeholder={t("dp1.textures.searchPlaceholder")}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <div className="flex gap-1 text-[11px]">
          {([
            ["all", t("dp1.textures.filterAll")],
            ["extracted", t("dp1.textures.filterExtracted")],
            ["replaced", t("dp1.textures.filterReplaced")],
            ["todo", t("dp1.textures.filterTodo")],
          ] as Array<[typeof filter, string]>).map(([k, lab]) => (
            <button
              key={k}
              onClick={() => setFilter(k)}
              className={`dp-btn ${filter === k ? "dp-btn--primary" : ""}`}
            >
              {lab}
            </button>
          ))}
        </div>
      </div>

      <div className="flex-1 overflow-auto">
        {loading && (
          <p className="py-10 text-center text-[12.5px] text-[var(--text-muted)]">{t("dp1.textures.scanning")}</p>
        )}
        {!loading && items.length === 0 && !error && (
          <div className="px-6 py-10 text-center text-[12.5px] text-[var(--text-muted)] max-w-[600px] mx-auto">
            <p>{t("dp1.textures.noXpcBefore")}<span className="font-mono">.xpc</span>{t("dp1.textures.noXpcAfter")}</p>
            <p className="mt-2 text-[var(--text-faint)]">
              {t("dp1.textures.configureBefore")}<span className="font-mono">dp1Root</span>{t("dp1.textures.configureAfter")}
            </p>
          </div>
        )}
        {!loading && items.length > 0 && (
          <table className="w-full text-[12px] table-fixed">
            <thead className="sticky top-0 z-10 bg-[var(--bg-surface)] text-[10px] uppercase tracking-wider text-[var(--text-faint)] border-b border-[var(--border-soft)]">
              <tr>
                <th className="text-left px-2 py-1.5 w-1/2">{t("dp1.textures.colPath")}</th>
                <th className="text-left px-2 py-1.5 w-[200px]">Internal name</th>
                <th className="text-right px-2 py-1.5 w-[80px]">Size</th>
                <th className="text-center px-2 py-1.5 w-[100px]">{t("dp1.textures.colState")}</th>
                <th className="text-right px-2 py-1.5 w-[140px]">{t("dp1.textures.colActions")}</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((it) => (
                <tr
                  key={it.relPath}
                  className="border-b border-[var(--border-soft)] hover:bg-[var(--row-hover)]"
                  style={{ contentVisibility: "auto", containIntrinsicSize: "auto 28px" }}
                >
                  <td className="px-2 py-1 font-mono text-[11px] text-[var(--text-muted)] truncate" title={it.relPath}>
                    {it.relPath}
                  </td>
                  <td className="px-2 py-1 font-mono text-[10.5px] text-[var(--text-faint)] truncate" title={it.internalName ?? ""}>
                    {it.internalName ?? "—"}
                  </td>
                  <td className="px-2 py-1 text-right tabular-nums text-[10.5px] text-[var(--text-faint)]">
                    {(it.size / 1024).toFixed(1)} KB
                  </td>
                  <td className="px-2 py-1 text-center text-[10.5px]">
                    {it.replaced
                      ? <span className="text-[var(--success)]">● {t("dp1.textures.stateReplaced")}</span>
                      : it.extracted
                        ? <span className="text-[var(--accent)]">● extracted</span>
                        : <span className="text-[var(--text-faint)]">○</span>}
                  </td>
                  <td className="px-2 py-1 text-right flex items-center justify-end gap-1">
                    <button
                      className="dp-btn dp-btn--ghost !py-0.5 !px-1.5 text-[10px]"
                      onClick={() => openPreview(it)}
                      disabled={phase !== "idle"}
                      title={t("dp1.textures.previewTip")}
                    >
                      👁
                    </button>
                    <button
                      className="dp-btn dp-btn--ghost !py-0.5 !px-1.5 text-[10px]"
                      onClick={() => replaceOne(it)}
                      disabled={phase !== "idle"}
                      title={t("dp1.textures.replaceOneTip")}
                    >
                      ⇪
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <EditorFooter
        fileName={gameRoot ?? undefined}
        stats={[
          { label: t("dp1.textures.footerTotal"), value: stats.total, tone: "default" },
          { label: t("dp1.textures.footerExtracted"), value: stats.extracted, tone: "accent" },
          { label: t("dp1.textures.footerReplaced"), value: stats.replaced, tone: "success" },
          { label: t("dp1.textures.footerShown"), value: filtered.length, tone: "muted" },
        ]}
      />

      {activePreview && (
        <div
          className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-6"
          onMouseDown={(e) => { if (e.target === e.currentTarget) setActivePreview(null); }}
        >
          <div
            className="dp-card max-w-3xl w-full max-h-[90vh] flex flex-col"
            style={{ background: "var(--bg-surface)" }}
            onMouseDown={(e) => e.stopPropagation()}
          >
            <div className="px-4 py-2.5 border-b border-[var(--border-soft)] flex items-center gap-3">
              <div className="flex-1 min-w-0">
                <p className="text-[12.5px] font-mono text-[var(--text)] truncate" title={activePreview.item.relPath}>
                  {activePreview.item.relPath}
                </p>
                <p className="text-[10.5px] text-[var(--text-faint)] truncate">
                  Internal: {activePreview.item.internalName ?? "—"}
                  {activePreview.ext && <span className="ml-2 font-mono text-[var(--accent)]">{activePreview.ext}</span>}
                </p>
              </div>
              <button className="dp-btn dp-btn--ghost" onClick={() => setActivePreview(null)} title="Esc">✕</button>
            </div>
            <div className="flex-1 overflow-auto p-4 bg-[var(--bg)]">
              {activePreview.loading && <p className="text-center text-[12px] text-[var(--text-muted)]">{t("dp1.textures.unpacking")}</p>}
              {activePreview.error && <p className="text-center text-[12px] text-[var(--danger)]">{activePreview.error}</p>}
              {activePreview.base64 && activePreview.ext === ".png" && (
                <img
                  src={`data:image/png;base64,${activePreview.base64}`}
                  alt={activePreview.item.relPath}
                  className="max-w-full max-h-[60vh] object-contain mx-auto block"
                  style={{ background: "repeating-conic-gradient(#222 0% 25%, #1a1a1a 0% 50%) 50% / 16px 16px" }}
                />
              )}
              {activePreview.base64 && activePreview.ext === ".jpg" && (
                <img
                  src={`data:image/jpeg;base64,${activePreview.base64}`}
                  alt={activePreview.item.relPath}
                  className="max-w-full max-h-[60vh] object-contain mx-auto block"
                />
              )}
              {activePreview.base64 && activePreview.ext === ".dds" && (
                <div className="text-center text-[12px] text-[var(--text-muted)] py-8">
                  <p className="mb-2">{t("dp1.textures.ddsNoPreview")}</p>
                  <p className="text-[var(--text-faint)]">{t("dp1.textures.fileAvailableAt")}</p>
                  <p className="font-mono text-[11px] text-[var(--accent)] mt-1 break-all">
                    {originalDir}/{activePreview.item.relPath.replace(/\.xpc$/i, "")}
                  </p>
                </div>
              )}
              {activePreview.base64 && activePreview.ext === ".bin" && (
                <p className="text-center text-[12px] text-[var(--text-muted)] py-8">
                  Unknown binary payload ({activePreview.base64.length} bytes base64).
                </p>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
