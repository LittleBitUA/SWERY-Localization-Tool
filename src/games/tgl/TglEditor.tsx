import { useEffect, useMemo, useState } from "react";
import { useTglStore } from "./store";
import { isTglTranslated, tglStats } from "./parser";
import { useT, localizeBackendError } from "../../lib/i18n";
import { alert as showAlert, confirm as showConfirm } from "../../lib/dialogs";
import heroImage from "./assets/tgl-hero.png";
import { TglTextEditor } from "./TglTextEditor";

interface TglEditorProps {
  onHome: () => void;
}

function basename(p: string): string {
  const parts = p.split(/[\\/]/);
  return parts[parts.length - 1] || p;
}

function MetricCard({ label, value, hint, accent, compact }: {
  label: string;
  value: string;
  hint?: string;
  accent?: "neutral" | "success";
  compact?: boolean;
}) {
  const valueColor = accent === "success" ? "var(--success)" : "var(--text-strong)";
  return (
    <div className="rounded-lg border border-[var(--border-soft)] bg-[var(--bg-surface)] px-4 py-3">
      <p className="text-[10px] uppercase tracking-wider text-[var(--text-faint)] mb-1.5">{label}</p>
      <p
        className="font-semibold tabular-nums"
        style={{ color: valueColor, fontSize: compact ? 18 : 24, lineHeight: 1.1 }}
      >
        {value}
      </p>
      {hint && (
        <p className="text-[10.5px] text-[var(--text-muted)] mt-1 tabular-nums">{hint}</p>
      )}
    </div>
  );
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
  // Monaco-режим: коли true — рендеримо `TglTextEditor` замість list-view.
  // Прапор тримаємо у LocalStorage, щоб після reload користувач лишався у
  // тому ж вигляді.
  const [monacoMode, setMonacoMode] = useState<boolean>(() => {
    try { return localStorage.getItem("tglMonacoMode") === "1"; } catch { return false; }
  });
  useEffect(() => {
    try { localStorage.setItem("tglMonacoMode", monacoMode ? "1" : "0"); } catch {}
  }, [monacoMode]);
  const [flowOpen, setFlowOpen] = useState<boolean>(() => {
    try { return localStorage.getItem("tglFlowOpen") === "1"; } catch { return false; }
  });
  const [tglTxtChip, setTglTxtChip] = useState<string | null>(null);
  const [packSuccess, setPackSuccess] = useState<null | {
    bundlePath: string;
    bakPath: string;
    translated: number;
    fallback: number;
    bundleSize?: number;
  }>(null);

  useEffect(() => { init(); }, [init]);
  useEffect(() => {
    (async () => {
      try {
        const s: any = await window.dp2.getSettings();
        setTglTxtChip(typeof s?.tglTxtPath === "string" ? s.tglTxtPath : null);
      } catch {}
    })();
  }, [busy]);

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
    // Якщо вже експортували раніше — підставляємо той самий шлях за замовч.
    let defaultPath = r.fileName;
    try {
      const s: any = await window.dp2.getSettings();
      if (s.tglTxtPath) defaultPath = s.tglTxtPath;
    } catch {}
    const dest = await window.dp2.pickSaveFile({
      title: t("tgl.txt.exportTitle"),
      defaultPath,
      filters: [{ name: "Text", extensions: ["txt"] }],
    });
    if (!dest) return;
    setBusy("exporting");
    try {
      await window.dp2.writeFile(dest, r.content);
      try { await window.dp2.saveSettings({ tglTxtPath: dest } as any); } catch {}
      await showAlert(t("dialog.exportSuccess"), t("tgl.txt.exported", { path: dest }), { tone: "success" });
    } finally {
      setBusy("idle");
    }
  }

  async function handleImportTxt() {
    let src: string | null = null;
    // Спершу пробуємо зберігний шлях — якщо файл існує, читаємо одразу.
    try {
      const s: any = await window.dp2.getSettings();
      if (s.tglTxtPath) {
        try {
          const raw = await window.dp2.readFile(s.tglTxtPath);
          if (raw != null) src = s.tglTxtPath;
        } catch { /* file missing — fallthrough to pickFile */ }
      }
    } catch {}
    if (!src) {
      src = await window.dp2.pickFile({
        title: t("tgl.txt.importTitle"),
        filters: [{ name: "Text", extensions: ["txt"] }],
      });
    }
    if (!src) return;
    setBusy("importing");
    try {
      const raw = await window.dp2.readFile(src);
      try { await window.dp2.saveSettings({ tglTxtPath: src } as any); } catch {}
      const res = await importTxtContent(raw);
      if (res.mismatch) {
        const m = res.mismatch;
        const trim = (s: string | undefined) => {
          if (s == null) return "—";
          const one = s.replace(/\s+/g, " ");
          return one.length > 120 ? one.slice(0, 117) + "…" : one;
        };
        const samples = (m.diffSamples ?? []).map((d) => {
          return [
            `#${d.i + 1}`,
            `  .txt: ${trim(d.txt)}`,
            `  .bin: ${trim(d.bin)}`,
          ].join("\n");
        }).join("\n\n");
        const body =
          t("tgl.txt.mismatch", { txt: m.txtLines, bin: m.binLines }) +
          (samples ? `\n\n${t("tgl.txt.diffSamples")}\n\n${samples}` : "");
        await showAlert(t("dialog.importResult"), body, { tone: "danger" });
        return;
      }
      await showAlert(
        t("dialog.importResult"),
        t("tgl.txt.imported", { applied: res.applied }) + `\n\n${t("tgl.txt.fromPath", { path: src })}`,
        { tone: "success" }
      );
    } finally {
      setBusy("idle");
    }
  }

  async function handleMonoExport() {
    const w = window.dp2 as unknown as {
      pickFile: (opts: { title: string; filters?: { name: string; extensions: string[] }[] }) => Promise<string | null>;
      pickFolder: (opts?: { title?: string }) => Promise<string | null>;
      readFile: (p: string) => Promise<string>;
      tglMonoExport: (p: { bundlePath: string; outDir: string; nameFilter?: string }) => Promise<{ ok: boolean; error?: string; summary?: { total?: number; outDir?: string; availableNames?: string[]; scannedMonoCount?: number } }>;
      getSettings: () => Promise<{ tglRoot?: string; tglMonoBundlePath?: string; tglMonoOutDir?: string; tglMonoFilter?: string }>;
      saveSettings: (p: object) => Promise<void>;
      openFolder?: (p: string) => void;
    };
    const s = await w.getSettings();
    // 1. Bundle: за замовч. зашитий `007f6ddb8055ea80` (тут лежить
    //    BufferedText з "Now Loading…"). Якщо файла нема або користувач не
    //    переходив через TGL onboarding — fallback на picker.
    let bp: string | null = null;
    const fixedBundle = s.tglRoot
      ? `${s.tglRoot}/StandaloneWindows64_Data/StreamingAssets/007f6ddb8055ea80`
      : null;
    if (fixedBundle) {
      try {
        // Перевіримо існування через readFile (0 байт читаємо, але reject =
        // файла нема). Не елегантно, але уникає нового IPC.
        await w.readFile(fixedBundle);
        bp = fixedBundle;
      } catch { /* нема — pick fallback */ }
    }
    if (!bp && s.tglMonoBundlePath) {
      try { await w.readFile(s.tglMonoBundlePath); bp = s.tglMonoBundlePath; } catch {}
    }
    if (!bp) {
      bp = await w.pickFile({
        title: t("tgl.mono.pickBundle"),
        filters: [{ name: "Unity Bundle", extensions: ["*"] }],
      });
      if (!bp) return;
    }
    // 2. Out folder (запам'ятовуємо).
    const out = await w.pickFolder({ title: t("tgl.mono.pickOutDir") });
    if (!out) return;
    // 3. Filter — зашитий PathID одного конкретного BufferedText asset
    //    із "Now Loading…" текстом. У TGL є тисячі MonoBehaviour з тим самим
    //    class-name "BufferedText" (це звичайний UI Text component), тож
    //    шукати за класом — невдала ідея. PathID унікальний → 1 файл, як треба.
    //    Перезаписуємо settings, щоб запобігти випадковому використанню
    //    старого значення.
    const filter = "-5460854340675020638";
    try { await w.saveSettings({ tglMonoFilter: filter }); } catch {}
    setBusy("exporting");
    try {
      const r = await w.tglMonoExport({ bundlePath: bp, outDir: out, nameFilter: filter || undefined });
      try { await w.saveSettings({ tglMonoBundlePath: bp, tglMonoOutDir: out, tglMonoFilter: filter }); } catch {}
      if (!r.ok) {
        await showAlert(t("tgl.mono.exportErrTitle"), localizeBackendError(r.error) || "?", { tone: "danger" });
        return;
      }
      const n = r.summary?.total ?? 0;
      // Total=0 — фільтр не знайшов нічого. Покажемо діагностику: скільки
      // MonoBehaviour було сканировано і список m_Name, щоб користувач
      // правильно ввів фільтр (через settings.json/tglMonoFilter).
      if (n === 0) {
        const names = (r.summary?.availableNames ?? []).slice(0, 60);
        const scanned = r.summary?.scannedMonoCount ?? 0;
        const list = names.length ? names.join("\n• ") : "(empty)";
        await showAlert(
          t("tgl.mono.exportEmptyTitle"),
          t("tgl.mono.exportEmptyBody", { filter, scanned }) + "\n\n• " + list,
          { tone: "warning" }
        );
        return;
      }
      const ok = await showConfirm(
        t("tgl.mono.exportDoneTitle"),
        t("tgl.mono.exportDoneBody", { n, dir: out }),
        { tone: "success", okLabel: t("tgl.mono.openFolder"), cancelLabel: t("btn.close") }
      );
      if (ok && w.openFolder) w.openFolder(out);
    } finally { setBusy("idle"); }
  }

  async function handleMonoImport() {
    const w = window.dp2 as unknown as {
      pickFile: (opts: { title: string; filters?: { name: string; extensions: string[] }[] }) => Promise<string | null>;
      tglMonoImport: (p: { bundlePath: string; jsonPath: string; pathId?: string }) => Promise<{ ok: boolean; error?: string; summary?: { size?: number } }>;
      getSettings: () => Promise<{ tglMonoBundlePath?: string }>;
      saveSettings: (p: object) => Promise<void>;
    };
    const s = await w.getSettings();
    const jp = await w.pickFile({
      title: t("tgl.mono.pickJson"),
      filters: [{ name: "JSON", extensions: ["json"] }],
    });
    if (!jp) return;
    let bp = s.tglMonoBundlePath ?? "";
    if (!bp) {
      const picked = await w.pickFile({
        title: t("tgl.mono.pickBundle"),
        filters: [{ name: "Unity Bundle", extensions: ["*"] }],
      });
      if (!picked) return;
      bp = picked;
    }
    setBusy("importing");
    try {
      const r = await w.tglMonoImport({ bundlePath: bp, jsonPath: jp });
      try { await w.saveSettings({ tglMonoBundlePath: bp }); } catch {}
      if (!r.ok) {
        await showAlert(t("tgl.mono.importErrTitle"), localizeBackendError(r.error) || "?", { tone: "danger" });
        return;
      }
      await showAlert(t("tgl.mono.importDoneTitle"), t("tgl.mono.importDoneBody", { bundle: bp, json: jp }), { tone: "success" });
    } finally { setBusy("idle"); }
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
        await showAlert(t("tgl.pack.errorTitle"), localizeBackendError(res.error), { tone: "danger" });
        return;
      }
      setPackSuccess({
        bundlePath: res.outputPath ?? binPath,
        bakPath: res.bakPath ?? "",
        translated: res.translated ?? 0,
        fallback: res.fallback ?? 0,
        bundleSize: res.size,
      });
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

  // Якщо користувач увімкнув Monaco-mode і вже відкритий .bin — рендеримо
  // TglTextEditor замість list. Перемикач лишається у його header (← Back).
  if (monacoMode && binPath) {
    return (
      <div className="flex-1 flex flex-col min-h-0" style={{ background: "#0d1117" }}>
        <TglTextEditor
          binPath={binPath}
          onBack={() => setMonacoMode(false)}
          onAfterPack={() => {/* лишаємо як є — pack-success modal у Monaco-editor'і */}}
        />
      </div>
    );
  }

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
        <div className="max-w-[860px] mx-auto px-6 py-10">
          <div className="text-center mb-8">
            <p className="text-[10px] uppercase tracking-[0.3em] text-[var(--text-faint)] mb-2">Swery65 · Rainy Woods Productions</p>
            <h1 style={{ fontFamily: "'Playfair Display', Georgia, serif", fontSize: 42, fontWeight: 700, color: "#f0ead2", letterSpacing: "-0.02em", marginBottom: 0 }}>
              The Good Life
            </h1>
          </div>

          {/* File chip */}
          <div className="rounded-lg border border-[var(--border-soft)] bg-[var(--bg-surface)] px-5 py-3 mb-4">
            <div className="flex items-center gap-3">
              <span className="text-[10px] uppercase tracking-wider text-[var(--text-faint)] shrink-0">
                {t("tgl.file.label")}
              </span>
              <p className="text-[12.5px] font-mono text-[var(--text)] break-all flex-1 min-w-0 truncate" title={binPath}>
                {shortPath(binPath)}
              </p>
            </div>
          </div>

          {/* Metric cards */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mb-3">
            <MetricCard
              label={t("tgl.stats.records")}
              value={entries.length.toLocaleString("uk-UA")}
              accent="neutral"
            />
            <MetricCard
              label={t("tgl.stats.translated")}
              value={translatedCount.toLocaleString("uk-UA")}
              hint={`${pct.toFixed(2).replace(".", ",")}%`}
              accent="success"
            />
            <MetricCard
              label={t("tgl.stats.words")}
              value={`${stats.uaWords.toLocaleString("uk-UA")} / ${stats.enWords.toLocaleString("uk-UA")}`}
              hint="UA / EN"
              accent="neutral"
              compact
            />
          </div>
          {/* Progress strip */}
          <div className="mb-6 px-1">
            <div className="h-1.5 rounded-full bg-[var(--bg-elevated)] overflow-hidden">
              <div
                className="h-full bg-[var(--success)] transition-all"
                style={{ width: `${Math.min(100, pct)}%` }}
              />
            </div>
          </div>

          {/* Workflow — collapsible, state persisted in localStorage */}
          <details
            className="mb-6 group"
            open={flowOpen}
            onToggle={(e) => {
              const next = (e.target as HTMLDetailsElement).open;
              setFlowOpen(next);
              try { localStorage.setItem("tglFlowOpen", next ? "1" : "0"); } catch {}
            }}
          >
            <summary className="cursor-pointer list-none text-[11px] font-semibold uppercase tracking-wider text-[var(--text-muted)] hover:text-[var(--text)] flex items-center gap-2 select-none">
              <span className="inline-block transition-transform group-open:rotate-90">›</span>
              {t("tgl.flow.title")}
            </summary>
            <ol className="space-y-3 mt-3">
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
          </details>

          {/* Actions — pack is the primary CTA (glow), import/export are secondary. */}
          <div className="flex flex-wrap items-center gap-3">
            <button
              className="dp-btn"
              onClick={() => setMonacoMode(true)}
              disabled={loading || !binPath}
              title={t("tgl.text.openHint")}
            >
              <svg className="w-4 h-4 mr-1.5 inline" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4" />
              </svg>
              {t("tgl.text.openBtn")}
            </button>
            <button
              className="dp-btn"
              onClick={handleExportTxt}
              disabled={busy !== "idle" || loading}
              title={t("tgl.txt.exportTitle")}
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
              title={t("tgl.txt.importTitle")}
            >
              <svg className="w-4 h-4 mr-1.5 inline" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M15 5h3a2 2 0 012 2v12a2 2 0 01-2 2H6a2 2 0 01-2-2V7a2 2 0 012-2h3" />
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 3v12m0 0l-4-4m4 4l4-4" />
              </svg>
              {busy === "importing" ? t("tgl.busy.importing") : t("tgl.txt.import")}
            </button>
            {tglTxtChip && (
              <span
                className="text-[10.5px] font-mono px-2 py-1 rounded bg-[var(--bg-elevated)] text-[var(--text-muted)] border border-[var(--border-soft)] truncate max-w-[220px]"
                title={tglTxtChip}
              >
                ↺ {basename(tglTxtChip)}
              </span>
            )}
            <div className="flex-1" />
            <button
              className="dp-btn dp-btn--success"
              onClick={runPack}
              disabled={busy !== "idle" || loading}
              style={{ boxShadow: "0 0 18px -4px rgba(34,197,94,0.55)" }}
            >
              <svg className="w-4 h-4 mr-1.5 inline" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
              </svg>
              {busy === "packing" ? t("tgl.busy.packing") : t("tgl.pack")}
            </button>
          </div>

          {/* Додатковий блок для тексту, що НЕ лежить у loc/English: окремі
              рядки на кшталт "Now Loading…", "PRESS ANY KEY" зашиті у
              MonoBehaviour-asset'ах усередині StreamingAssets-bundle'ів.
              Без цього кроку гра матиме лише частково перекладений UI. */}
          <div
            className="mt-5 rounded-lg p-4"
            style={{
              border: "1px solid rgba(234, 179, 8, 0.35)",
              background: "linear-gradient(135deg, rgba(234,179,8,0.10) 0%, rgba(234,179,8,0.02) 70%, transparent 100%)",
            }}
          >
            <div className="flex items-start gap-3">
              <div className="shrink-0 w-9 h-9 rounded-full flex items-center justify-center" style={{ background: "rgba(234,179,8,0.18)", border: "1px solid rgba(234,179,8,0.45)" }}>
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="rgba(234,179,8,1)" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01M4.93 19h14.14a2 2 0 001.74-2.99l-7.07-12.25a2 2 0 00-3.48 0L3.19 16.01A2 2 0 004.93 19z" />
                </svg>
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-[13px] font-semibold text-[var(--text-strong)]">
                  {t("tgl.mono.warnTitle")}
                </p>
                <p className="text-[11.5px] text-[var(--text-muted)] mt-1 leading-relaxed">
                  {t("tgl.mono.warnBody")}
                </p>
                <div className="flex flex-wrap gap-2 mt-3">
                  <button
                    className="dp-btn"
                    onClick={handleMonoExport}
                    disabled={busy !== "idle" || loading}
                    title={t("tgl.mono.exportHint")}
                  >
                    <svg className="w-4 h-4 mr-1.5 inline" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M9 5h-3a2 2 0 00-2 2v12a2 2 0 002 2h12a2 2 0 002-2v-3" />
                      <path strokeLinecap="round" strokeLinejoin="round" d="M16 3l5 5m0 0v-5m0 5h-5M9 14l11-11" />
                    </svg>
                    {t("tgl.mono.exportBtn")}
                  </button>
                  <button
                    className="dp-btn"
                    onClick={handleMonoImport}
                    disabled={busy !== "idle" || loading}
                    title={t("tgl.mono.importHint")}
                  >
                    <svg className="w-4 h-4 mr-1.5 inline" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M15 5h3a2 2 0 012 2v12a2 2 0 01-2 2H6a2 2 0 01-2-2V7a2 2 0 012-2h3" />
                      <path strokeLinecap="round" strokeLinejoin="round" d="M12 3v12m0 0l-4-4m4 4l4-4" />
                    </svg>
                    {t("tgl.mono.importBtn")}
                  </button>
                </div>
              </div>
            </div>
          </div>

          {error && (
            <p className="mt-4 text-[12px] text-[var(--danger)] whitespace-pre-wrap">{error}</p>
          )}
        </div>
      </div>

      {packSuccess && (
        <div className="fixed inset-0 z-40 bg-black/60 flex items-center justify-center p-6" onClick={() => setPackSuccess(null)}>
          <div
            className="w-full max-w-[600px] bg-[var(--bg-surface)] border border-[var(--border-soft)] rounded-xl shadow-2xl overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Hero band */}
            <div
              className="relative px-8 pt-7 pb-6 text-center"
              style={{
                background: "linear-gradient(135deg, rgba(34,197,94,0.18) 0%, rgba(34,197,94,0.05) 60%, transparent 100%)",
                borderBottom: "1px solid var(--border-soft)",
              }}
            >
              <div
                className="inline-flex items-center justify-center w-14 h-14 rounded-full mb-3"
                style={{
                  background: "radial-gradient(circle, rgba(34,197,94,0.30), rgba(34,197,94,0.05))",
                  boxShadow: "0 0 22px -4px rgba(34,197,94,0.45)",
                }}
              >
                <svg className="w-7 h-7 text-[var(--success)]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                </svg>
              </div>
              <h2 className="text-[22px] font-bold text-[var(--text-strong)] mb-1" style={{ fontFamily: "'Playfair Display', Georgia, serif" }}>
                {t("tgl.pack.successTitle")}
              </h2>
              <p className="text-[12.5px] text-[var(--text-muted)]">{t("tgl.pack.successSubtitle")}</p>
            </div>

            {/* Metrics grid */}
            <div className="grid grid-cols-2 gap-3 px-6 py-5">
              <div className="rounded-lg border border-[var(--border-soft)] bg-[var(--bg)] px-4 py-3">
                <p className="text-[10px] uppercase tracking-wider text-[var(--text-faint)] mb-1">{t("tgl.pack.metric.translated")}</p>
                <p className="text-[22px] font-bold text-[var(--success)] tabular-nums leading-none">
                  {packSuccess.translated.toLocaleString("uk-UA")}
                </p>
                <p className="text-[10.5px] text-[var(--text-muted)] mt-1.5">{t("tgl.pack.metric.uaRows")}</p>
              </div>
              <div className="rounded-lg border border-[var(--border-soft)] bg-[var(--bg)] px-4 py-3">
                <p className="text-[10px] uppercase tracking-wider text-[var(--text-faint)] mb-1">{t("tgl.pack.metric.fallback")}</p>
                <p className="text-[22px] font-bold text-[var(--text-strong)] tabular-nums leading-none">
                  {packSuccess.fallback.toLocaleString("uk-UA")}
                </p>
                <p className="text-[10.5px] text-[var(--text-muted)] mt-1.5">{t("tgl.pack.metric.enRows")}</p>
              </div>
            </div>

            {/* Paths */}
            <div className="px-6 pb-5 space-y-2.5">
              <div className="rounded-md border border-[var(--border-soft)] bg-[var(--bg)] px-3 py-2 flex items-start gap-3">
                <span className="text-[10px] uppercase tracking-wider text-[var(--text-faint)] shrink-0 mt-0.5">{t("tgl.pack.metric.bundle")}</span>
                <p className="text-[11px] font-mono text-[var(--text)] break-all flex-1 min-w-0" title={packSuccess.bundlePath}>
                  {packSuccess.bundlePath}
                </p>
              </div>
              {packSuccess.bakPath && (
                <div className="rounded-md border border-[var(--border-soft)] bg-[var(--bg)] px-3 py-2 flex items-start gap-3">
                  <span className="text-[10px] uppercase tracking-wider text-[var(--text-faint)] shrink-0 mt-0.5">{t("tgl.pack.metric.bak")}</span>
                  <p className="text-[11px] font-mono text-[var(--text-muted)] break-all flex-1 min-w-0" title={packSuccess.bakPath}>
                    {packSuccess.bakPath}
                  </p>
                </div>
              )}
            </div>

            {/* Actions */}
            <div className="px-6 pb-5 flex flex-wrap items-center gap-2 border-t border-[var(--border-soft)] pt-4">
              <button
                className="dp-btn"
                onClick={async () => {
                  const dir = packSuccess.bundlePath.replace(/[\\/][^\\/]+$/, "");
                  const w = window.dp2 as unknown as { openFolder?: (p: string) => void };
                  if (w.openFolder) w.openFolder(dir);
                }}
              >
                <svg className="w-4 h-4 mr-1.5 inline" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-7l-2-2H5a2 2 0 00-2 2z" />
                </svg>
                {t("tgl.pack.openFolder")}
              </button>
              <div className="flex-1" />
              <button
                className="dp-btn"
                onClick={() => setPackSuccess(null)}
              >
                {t("btn.close")}
              </button>
              <button
                className="dp-btn dp-btn--success"
                style={{ boxShadow: "0 0 18px -4px rgba(34,197,94,0.55)" }}
                onClick={async () => {
                  try {
                    const w = window.dp2 as unknown as { launchSteamGame?: (id: string) => Promise<{ ok: boolean; error?: string }> };
                    if (w.launchSteamGame) await w.launchSteamGame("1452500");
                  } catch {}
                  setPackSuccess(null);
                }}
              >
                <svg className="w-4 h-4 mr-1.5 inline" fill="currentColor" viewBox="0 0 24 24">
                  <path d="M8 5v14l11-7z" />
                </svg>
                {t("tgl.pack.launchGame")}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
