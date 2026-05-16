import { useEffect, useMemo, useState } from "react";
import { useTglStore } from "./store";
import { isTglTranslated, tglStats } from "./parser";
import { useT } from "../../lib/i18n";
import { alert as showAlert, confirm as showConfirm } from "../../lib/dialogs";
import heroImage from "./assets/tgl-hero.png";

interface TglEditorProps {
  onHome: () => void;
}

function shortPath(p: string | null): string {
  if (!p) return "—";
  const parts = p.split(/[\\/]/);
  return parts.slice(-3).join("/");
}

export function TglEditor({ onHome }: TglEditorProps) {
  const t = useT();
  const init = useTglStore((s) => s.init);
  const binPath = useTglStore((s) => s.binPath);
  const entries = useTglStore((s) => s.entries);
  const pack = useTglStore((s) => s.pack);
  const loading = useTglStore((s) => s.loading);
  const error = useTglStore((s) => s.error);
  const loadBin = useTglStore((s) => s.loadBin);
  const exportTxt = useTglStore((s) => s.exportTxt);
  const importTxtContent = useTglStore((s) => s.importTxtContent);

  const [busy, setBusy] = useState<"idle" | "exporting" | "importing" | "packing">("idle");

  useEffect(() => { init(); }, [init]);

  const stats = useMemo(() => tglStats(entries), [entries]);
  const translatedCount = useMemo(() => entries.filter(isTglTranslated).length, [entries]);

  async function pickBin() {
    const f = await window.dp2.pickFile({
      title: t("tgl.empty.pickTitle"),
      filters: [{ name: "All", extensions: ["*"] }],
    });
    if (f) await loadBin(f);
  }

  async function handleExportTxt() {
    const r = exportTxt();
    if (!r) return;
    const dest = await window.dp2.pickSaveFile({
      title: t("tgl.txt.exportTitle"),
      defaultPath: r.fileName,
      filters: [{ name: "Text", extensions: ["txt"] }],
    });
    if (!dest) return;
    setBusy("exporting");
    try {
      await window.dp2.writeFile(dest, r.content);
      await showAlert(t("dialog.exportSuccess"), t("tgl.txt.exported", { path: dest }), { tone: "success" });
    } finally {
      setBusy("idle");
    }
  }

  async function handleImportTxt() {
    const src = await window.dp2.pickFile({
      title: t("tgl.txt.importTitle"),
      filters: [{ name: "Text", extensions: ["txt"] }],
    });
    if (!src) return;
    setBusy("importing");
    try {
      const raw = await window.dp2.readFile(src);
      const res = await importTxtContent(raw);
      if (res.mismatch) {
        await showAlert(
          t("dialog.importResult"),
          t("tgl.txt.mismatch", { txt: res.mismatch.txtLines, bin: res.mismatch.binLines }),
          { tone: "danger" }
        );
        return;
      }
      await showAlert(t("dialog.importResult"), t("tgl.txt.imported", { applied: res.applied }), { tone: "success" });
    } finally {
      setBusy("idle");
    }
  }

  async function runPack() {
    if (!binPath) return;
    const ok = await showConfirm(
      t("tgl.pack.confirmTitle"),
      t("tgl.pack.confirmBody", { path: binPath }),
      { okLabel: t("tgl.pack.confirmOk"), cancelLabel: t("btn.cancel") }
    );
    if (!ok) return;
    setBusy("packing");
    try {
      const res = await pack();
      if (res.error) {
        await showAlert(t("tgl.pack.errorTitle"), res.error, { tone: "danger" });
        return;
      }
      await showAlert(
        t("tgl.pack.successTitle"),
        t("tgl.pack.successBody", {
          path: res.outputPath ?? binPath,
          bak: res.bakPath ?? "(існував)",
          translated: res.translated ?? 0,
        }),
        { tone: "success" }
      );
    } finally {
      setBusy("idle");
    }
  }

  if (!binPath) {
    return (
      <div className="flex-1 flex flex-col bg-[var(--bg)] min-h-0">
        <header className="h-12 px-4 border-b border-[var(--border-soft)] bg-[var(--bg-surface)] flex items-center gap-3 shrink-0">
          <button className="dp-btn dp-btn--ghost" onClick={onHome} title={t("header.home")}>
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M10 19l-7-7m0 0l7-7m-7 7h18" />
            </svg>
          </button>
          <span className="text-[13px] text-[var(--text-muted)]">{t("tgl.brand")}</span>
        </header>
        <div className="flex-1 flex items-center justify-center p-8 min-h-0">
          <div className="max-w-[520px] text-center">
            <h2 className="text-[18px] font-bold text-[var(--text-strong)] mb-2">{t("tgl.empty.title")}</h2>
            <p className="text-[13px] text-[var(--text-muted)] mb-4 leading-relaxed whitespace-pre-line">
              {t("tgl.empty.hint")}
            </p>
            <button className="dp-btn dp-btn--primary" onClick={pickBin}>{t("tgl.empty.pickBtn")}</button>
            {error && (
              <p className="mt-3 text-[12px] text-[var(--danger)] whitespace-pre-wrap">{error}</p>
            )}
          </div>
        </div>
      </div>
    );
  }

  const pct = entries.length > 0 ? (translatedCount / entries.length) * 100 : 0;

  return (
    <div className="flex-1 flex flex-col min-h-0 relative" style={{ background: "#0d1117" }}>
      {/* Hero background — атмосферне фото гри з затемненням */}
      <div
        aria-hidden
        style={{
          position: "absolute",
          inset: 0,
          backgroundImage: `url(${heroImage})`,
          backgroundSize: "cover",
          backgroundPosition: "center top",
          filter: "blur(2px) brightness(0.45) saturate(1.1)",
          opacity: 0.6,
          zIndex: 0,
        }}
      />
      <div
        aria-hidden
        style={{
          position: "absolute",
          inset: 0,
          background: "linear-gradient(180deg, rgba(13,17,23,0.4) 0%, rgba(13,17,23,0.85) 60%, rgba(13,17,23,0.98) 100%)",
          zIndex: 0,
        }}
      />
      <header className="h-12 px-4 border-b border-[var(--border-soft)] flex items-center gap-3 shrink-0 relative" style={{ background: "rgba(13,17,23,0.7)", backdropFilter: "blur(8px)", zIndex: 2 }}>
        <button className="dp-btn dp-btn--ghost" onClick={onHome} title={t("header.home")}>
          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M10 19l-7-7m0 0l7-7m-7 7h18" />
          </svg>
        </button>
        <span className="text-[13px] text-[var(--text-muted)]">{t("tgl.brand")}</span>
        <div className="flex-1" />
        <button className="dp-btn dp-btn--ghost" onClick={pickBin}>{t("btn.open")}</button>
      </header>

      <div className="flex-1 overflow-auto min-h-0 relative" style={{ zIndex: 1 }}>
        <div className="max-w-[820px] mx-auto px-6 py-10">
          <div className="text-center mb-8">
            <p className="text-[10px] uppercase tracking-[0.3em] text-[var(--text-faint)] mb-2">Swery65 · Rainy Woods Productions</p>
            <h1 style={{ fontFamily: "'Playfair Display', Georgia, serif", fontSize: 42, fontWeight: 700, color: "#f0ead2", letterSpacing: "-0.02em", marginBottom: 8 }}>
              The Good Life
            </h1>
            <p className="text-[13px] text-[var(--text-muted)]">{t("tgl.brand")}</p>
          </div>
          {/* File card */}
          <div className="rounded-lg border border-[var(--border-soft)] bg-[var(--bg-surface)] px-5 py-4 mb-6">
            <p className="text-[10px] uppercase tracking-wider text-[var(--text-faint)] mb-1">
              {t("tgl.file.label")}
            </p>
            <p className="text-[13px] font-mono text-[var(--text)] break-all" title={binPath}>
              {shortPath(binPath)}
            </p>
            <div className="mt-3 flex items-center gap-4 text-[12px] text-[var(--text-muted)]">
              <span>
                {t("tgl.stats.records")}:{" "}
                <span className="text-[var(--text)] font-semibold tabular-nums">
                  {entries.length.toLocaleString("uk-UA")}
                </span>
              </span>
              <span>
                {t("tgl.stats.translated")}:{" "}
                <span className="text-[var(--success)] font-semibold tabular-nums">
                  {translatedCount.toLocaleString("uk-UA")}
                </span>{" "}
                <span className="text-[var(--text-faint)]">({pct.toFixed(2).replace(".", ",")}%)</span>
              </span>
              <span>
                {t("tgl.stats.words")}:{" "}
                <span className="text-[var(--text)] font-semibold tabular-nums">{stats.uaWords}</span>
                {" / "}
                <span className="text-[var(--text)] font-semibold tabular-nums">{stats.enWords}</span>
              </span>
            </div>
          </div>

          {/* Workflow */}
          <h3 className="text-[11px] font-semibold uppercase tracking-wider text-[var(--text-muted)] mb-3">
            {t("tgl.flow.title")}
          </h3>
          <ol className="space-y-3 mb-6">
            {[
              { n: 1, key: "tgl.flow.step1" },
              { n: 2, key: "tgl.flow.step2" },
              { n: 3, key: "tgl.flow.step3" },
              { n: 4, key: "tgl.flow.step4" },
            ].map((s) => (
              <li key={s.n} className="flex items-start gap-3 text-[13px] text-[var(--text-muted)] leading-relaxed">
                <span className="inline-flex items-center justify-center w-6 h-6 rounded-full bg-[var(--bg-elevated)] border border-[var(--border-soft)] text-[11px] font-semibold text-[var(--text)] shrink-0">
                  {s.n}
                </span>
                <span className="flex-1 pt-0.5">{t(s.key)}</span>
              </li>
            ))}
          </ol>

          {/* Actions */}
          <div className="flex flex-wrap gap-3">
            <button
              className="dp-btn dp-btn--primary"
              onClick={handleExportTxt}
              disabled={busy !== "idle" || loading}
            >
              <svg className="w-4 h-4 mr-1.5 inline" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M9 5h-3a2 2 0 00-2 2v12a2 2 0 002 2h12a2 2 0 002-2v-3" />
                <path strokeLinecap="round" strokeLinejoin="round" d="M16 3l5 5m0 0v-5m0 5h-5M9 14l11-11" />
              </svg>
              {busy === "exporting" ? t("tgl.busy.exporting") : t("tgl.txt.export")}
            </button>
            <button
              className="dp-btn"
              onClick={handleImportTxt}
              disabled={busy !== "idle" || loading}
            >
              <svg className="w-4 h-4 mr-1.5 inline" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M15 5h3a2 2 0 012 2v12a2 2 0 01-2 2H6a2 2 0 01-2-2V7a2 2 0 012-2h3" />
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 3v12m0 0l-4-4m4 4l4-4" />
              </svg>
              {busy === "importing" ? t("tgl.busy.importing") : t("tgl.txt.import")}
            </button>
            <div className="flex-1" />
            <button
              className="dp-btn dp-btn--success"
              onClick={runPack}
              disabled={busy !== "idle" || loading}
            >
              {busy === "packing" ? t("tgl.busy.packing") : t("tgl.pack")}
            </button>
          </div>

          {error && (
            <p className="mt-4 text-[12px] text-[var(--danger)] whitespace-pre-wrap">{error}</p>
          )}
        </div>
      </div>
    </div>
  );
}
