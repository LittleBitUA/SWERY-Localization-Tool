// D4 — редактор шрифтів з повним функціоналом фази 1:
//  - Розпакування Ms01Utility_LOC_INT.upk → UFont meta + atlas preview PNG
//  - TTF picker з збереженням у ttf-mapping.json
//  - Грід 25 шрифтів з preview-зображенням + TTF mapping
//  - Phase 2 (Generate + Pack) — заглушки на майбутнє.

import { useCallback, useEffect, useState } from "react";
import { useT } from "../../lib/i18n";
import { D4Hero } from "./D4Hero";
import { D4ProgressModal, type D4FileProgress } from "./D4ProgressModal";
import { D4FontPreviewModal } from "./D4FontPreviewModal";

interface Props { onHome: () => void; }

interface FontDef {
  name: string;
  category: "subtitle" | "system" | "menu" | "specialty";
  format: "BC3" | "PF_G8";
  hasShadowPair: boolean;
  shadowOf?: string;
}

const D4_FONTS: FontDef[] = [
  { name: "newcinema",          category: "subtitle",  format: "BC3",   hasShadowPair: true },
  { name: "newcinema_s",        category: "subtitle",  format: "BC3",   hasShadowPair: true,  shadowOf: "newcinema" },
  { name: "talkfont",           category: "subtitle",  format: "BC3",   hasShadowPair: true },
  { name: "shadowfont",         category: "subtitle",  format: "BC3",   hasShadowPair: true,  shadowOf: "talkfont" },
  { name: "consola",            category: "system",    format: "BC3",   hasShadowPair: false },
  { name: "consola_b",          category: "system",    format: "BC3",   hasShadowPair: false },
  { name: "dive",               category: "specialty", format: "BC3",   hasShadowPair: true },
  { name: "dive_s",             category: "specialty", format: "BC3",   hasShadowPair: true,  shadowOf: "dive" },
  { name: "dive_en",            category: "specialty", format: "BC3",   hasShadowPair: true },
  { name: "dive_en_s",          category: "specialty", format: "BC3",   hasShadowPair: true,  shadowOf: "dive_en" },
  { name: "observe_eng",        category: "specialty", format: "BC3",   hasShadowPair: true },
  { name: "observe_eng_s",      category: "specialty", format: "BC3",   hasShadowPair: true,  shadowOf: "observe_eng" },
  { name: "observefont",        category: "specialty", format: "BC3",   hasShadowPair: true },
  { name: "observefont_s",      category: "specialty", format: "BC3",   hasShadowPair: true,  shadowOf: "observefont" },
  { name: "observefont_eng",    category: "specialty", format: "PF_G8", hasShadowPair: false },
  { name: "menufont",           category: "menu",      format: "PF_G8", hasShadowPair: true },
  { name: "menufont_r",         category: "menu",      format: "PF_G8", hasShadowPair: true,  shadowOf: "menufont" },
  { name: "menufont_jp",        category: "menu",      format: "BC3",   hasShadowPair: true },
  { name: "menufont_jp_r",      category: "menu",      format: "BC3",   hasShadowPair: true,  shadowOf: "menufont_jp" },
  { name: "ms_mincho",          category: "system",    format: "BC3",   hasShadowPair: false },
  { name: "customfont",         category: "specialty", format: "BC3",   hasShadowPair: true },
  { name: "customfont_s",       category: "specialty", format: "BC3",   hasShadowPair: true,  shadowOf: "customfont" },
  { name: "times_new_roman",    category: "system",    format: "PF_G8", hasShadowPair: false },
  { name: "times_new_roman_storytitle", category: "system", format: "BC3", hasShadowPair: false },
  { name: "talkfont_jp",        category: "subtitle",  format: "BC3",   hasShadowPair: true },
];

const CATEGORY_KEY: Record<string, string> = {
  subtitle: "d4.fonts.cat.subtitle",
  system: "d4.fonts.cat.system",
  menu: "d4.fonts.cat.menu",
  specialty: "d4.fonts.cat.specialty",
};

interface StatusInfo {
  ok: boolean;
  d4Root: string | null;
  extracted: boolean;
  extractedCount: number;
  previewCount: number;
  mapping: Record<string, { ttfPath: string; source?: string }>;
  tools: { ready: boolean };
}

function fileName(p: string): string {
  return p.split(/[\\/]/).pop() ?? p;
}

export function D4FontsEditor({ onHome }: Props) {
  const t = useT();
  const [status, setStatus] = useState<StatusInfo | null>(null);
  const [previews, setPreviews] = useState<Record<string, string>>({});
  // Progress modal
  const [busy, setBusy] = useState(false);
  const [logLines, setLogLines] = useState<string[]>([]);
  const [fileProgress, setFileProgress] = useState<D4FileProgress[]>([]);
  const [opDone, setOpDone] = useState(false);
  const [opError, setOpError] = useState<string | null>(null);

  // Тип режиму busy: розпакування / генерація / pack у гру.
  const [busyKind, setBusyKind] = useState<"extract" | "generate" | "pack" | null>(null);
  // Preview lightbox.
  const [previewFor, setPreviewFor] = useState<{ name: string; format: string } | null>(null);
  // Перемикач Original (з гри) ↔ Generated (UA з TTF).
  const [previewMode, setPreviewMode] = useState<"original" | "generated">("original");
  const [generatedPreviews, setGeneratedPreviews] = useState<Record<string, string>>({});

  const reloadStatus = useCallback(async () => {
    const s = await window.dp2.d4FontsStatus();
    setStatus(s as StatusInfo);
    // Original previews (атласи з гри).
    if (s.extracted && s.previewCount > 0) {
      const pairs = await Promise.all(D4_FONTS.map(async (f) => {
        const r = await window.dp2.d4FontsReadPreview(f.name);
        return [f.name, r.ok ? `data:image/png;base64,${r.base64}` : ""] as const;
      }));
      const obj: Record<string, string> = {};
      for (const [k, v] of pairs) if (v) obj[k] = v;
      setPreviews(obj);
    } else {
      setPreviews({});
    }
    // Generated previews (UA з TTF — якщо вже згенеровано).
    const gens = await Promise.all(D4_FONTS.map(async (f) => {
      const r = await window.dp2.d4FontsReadGenerated(f.name);
      return [f.name, r.ok ? `data:image/png;base64,${r.base64}` : ""] as const;
    }));
    const gObj: Record<string, string> = {};
    for (const [k, v] of gens) if (v) gObj[k] = v;
    setGeneratedPreviews(gObj);
  }, []);

  useEffect(() => { reloadStatus(); }, [reloadStatus]);

  const runExtract = useCallback(async () => {
    setBusyKind("extract");
    setBusy(true);
    setLogLines([]);
    setFileProgress(D4_FONTS.map((f) => ({ name: f.name, status: "pending" })));
    setOpDone(false);
    setOpError(null);
    const unsub = window.dp2.onD4FontsProgress((rawLine: string) => {
      // Великий RESULT_JSON-блоб у журналі лише засмічує — лишаємо короткий
      // тег без payload, оскільки структуру вже виводимо у status-картку.
      const line = rawLine.includes("RESULT_JSON:")
        ? rawLine.replace(/RESULT_JSON:.*$/, "RESULT_JSON: …")
        : rawLine;
      setLogLines((prev) => [...prev, line]);
      // Лінії з main process приходять з префіксом "  " (відступ), тому
      // дозволяємо whitespace перед [STEP]. Також ловимо префікс "<name>:"
      // який емітить d4-fonts-preview.py (там формат "[STEP] <name>: …").
      const step = line.match(/^\s*\[STEP\]\s+([A-Za-z0-9_]+)/);
      if (step) {
        const name = step[1];
        const found = D4_FONTS.find((f) => f.name === name);
        if (found) {
          setFileProgress((prev) => {
            const idx = prev.findIndex((p) => p.name === name);
            if (idx < 0) return prev;
            return prev.map((p, i) => {
              if (p.name === name) {
                // Перезапис: якщо вже done — лишаємо done (не повертаємось
                // назад у running під час другої фази pipeline).
                return p.status === "done" ? p : { ...p, status: "running" };
              }
              // Будь-який інший running → автоматично done (бо новий [STEP]
              // означає, що попередній шрифт оброблено).
              if (p.status === "running") return { ...p, status: "done" };
              // Pending перед поточним → done (PS-фаза йде послідовно).
              if (i < idx && p.status === "pending") return { ...p, status: "done" };
              return p;
            });
          });
        }
      }
      // [SKIP] від preview.py — шрифт пропущено через відсутність preview.
      const skip = line.match(/^\s*\[SKIP\]\s+([A-Za-z0-9_]+):/);
      if (skip) {
        const name = skip[1];
        setFileProgress((prev) => prev.map((p) =>
          p.name === name && p.status === "running" ? { ...p, status: "done" } : p
        ));
      }
      // [ERR] — конкретний шрифт зламано.
      const err = line.match(/^\s*\[ERR\]\s+([A-Za-z0-9_]+):/);
      if (err) {
        const name = err[1];
        setFileProgress((prev) => prev.map((p) =>
          p.name === name ? { ...p, status: "error" } : p
        ));
      }
    });
    try {
      const r = await window.dp2.d4FontsExtract();
      setFileProgress((prev) => prev.map((p) => ({ ...p, status: r.ok ? "done" : "error" })));
      setOpDone(true);
      if (!r.ok) setOpError(r.error ?? t("d4.unknownError"));
      else if (r.warning) setLogLines((prev) => [...prev, `[WARN] ${r.warning}`]);
      await reloadStatus();
    } catch (e) {
      setOpError(String(e instanceof Error ? e.message : e));
      setOpDone(true);
    } finally {
      unsub();
    }
  }, [reloadStatus]);

  // Генерація UA-шрифтів: для кожного шрифту з TTF mapping — викликаємо
  // make_paired_fonts.py або make_single_font.py через IPC.
  const runGenerate = useCallback(async () => {
    setBusyKind("generate");
    setBusy(true);
    setLogLines([]);
    // Лише ті шрифти, що мають mapping і будуть генеруватись.
    const mapped = D4_FONTS.filter((f) => status?.mapping[f.name]?.ttfPath && !f.shadowOf);
    setFileProgress(mapped.map((f) => ({ name: f.name, status: "pending" })));
    setOpDone(false);
    setOpError(null);
    const unsub = window.dp2.onD4FontsProgress((rawLine: string) => {
      const line = rawLine.includes("RESULT_JSON:")
        ? rawLine.replace(/RESULT_JSON:.*$/, "RESULT_JSON: …")
        : rawLine;
      setLogLines((prev) => [...prev, line]);
      const step = line.match(/^\s*\[STEP\]\s+([A-Za-z0-9_]+)/);
      if (step) {
        const name = step[1];
        setFileProgress((prev) => {
          const idx = prev.findIndex((p) => p.name === name);
          if (idx < 0) return prev;
          return prev.map((p, i) => {
            if (p.name === name) return p.status === "done" ? p : { ...p, status: "running" };
            if (p.status === "running") return { ...p, status: "done" };
            if (i < idx && p.status === "pending") return { ...p, status: "done" };
            return p;
          });
        });
      }
      const done = line.match(/^\s*\[DONE\]\s+([A-Za-z0-9_]+)$/);
      if (done) {
        const name = done[1];
        setFileProgress((prev) => prev.map((p) => p.name === name ? { ...p, status: "done" } : p));
      }
      const err = line.match(/^\s*\[ERR\]\s+([A-Za-z0-9_]+):/);
      if (err) {
        const name = err[1];
        setFileProgress((prev) => prev.map((p) => p.name === name ? { ...p, status: "error" } : p));
      }
    });
    try {
      const r = await window.dp2.d4FontsGenerate();
      setFileProgress((prev) => prev.map((p) => {
        const res = r.results?.find((x) => x.name === p.name);
        if (!res) return p;
        return { ...p, status: res.ok ? "done" : "error" };
      }));
      setOpDone(true);
      if (!r.ok) setOpError(r.error ?? t("d4.unknownError"));
    } catch (e) {
      setOpError(String(e instanceof Error ? e.message : e));
      setOpDone(true);
    } finally {
      unsub();
    }
  }, [status?.mapping, t]);

  // Pack у гру: probe-exports + portable d4-fonts-pack.py + копія з .bak.
  const runPack = useCallback(async () => {
    setBusyKind("pack");
    setBusy(true);
    setLogLines([]);
    const mapped = D4_FONTS.filter((f) => status?.mapping[f.name]?.ttfPath && !f.shadowOf);
    setFileProgress(mapped.map((f) => ({ name: f.name, status: "pending" })));
    setOpDone(false);
    setOpError(null);
    const unsub = window.dp2.onD4FontsProgress((rawLine: string) => {
      const line = rawLine.includes("RESULT_JSON:")
        ? rawLine.replace(/RESULT_JSON:.*$/, "RESULT_JSON: …")
        : rawLine;
      setLogLines((prev) => [...prev, line]);
      const step = line.match(/^\s*\[STEP\]\s+([A-Za-z0-9_]+)\s*\(/);
      if (step) {
        const name = step[1];
        setFileProgress((prev) => {
          const idx = prev.findIndex((p) => p.name === name);
          if (idx < 0) return prev;
          return prev.map((p, i) => {
            if (p.name === name) return p.status === "done" ? p : { ...p, status: "running" };
            if (p.status === "running") return { ...p, status: "done" };
            if (i < idx && p.status === "pending") return { ...p, status: "done" };
            return p;
          });
        });
      }
      const done = line.match(/^\s*\[DONE\]\s+([A-Za-z0-9_]+)$/);
      if (done) {
        const name = done[1];
        setFileProgress((prev) => prev.map((p) => p.name === name ? { ...p, status: "done" } : p));
      }
      const err = line.match(/^\s*\[ERR\]\s+([A-Za-z0-9_]+):/);
      if (err) {
        const name = err[1];
        setFileProgress((prev) => prev.map((p) => p.name === name ? { ...p, status: "error" } : p));
      }
    });
    try {
      const r = await window.dp2.d4FontsPack();
      setFileProgress((prev) => prev.map((p) => {
        const res = r.fonts?.find((x) => x.name === p.name);
        if (!res) return p;
        return { ...p, status: res.ok ? "done" : "error" };
      }));
      setOpDone(true);
      if (!r.ok) setOpError(r.error ?? t("d4.unknownError"));
    } catch (e) {
      setOpError(String(e instanceof Error ? e.message : e));
      setOpDone(true);
    } finally {
      unsub();
    }
  }, [status?.mapping, t]);

  const pickTtf = useCallback(async (fontName: string) => {
    const r = await window.dp2.d4FontsPickTtf({ fontName });
    if (r.ok) await reloadStatus();
  }, [reloadStatus]);

  const clearTtf = useCallback(async (fontName: string) => {
    await window.dp2.d4FontsClearTtf(fontName);
    await reloadStatus();
  }, [reloadStatus]);

  const grouped = D4_FONTS.reduce<Record<string, FontDef[]>>((acc, f) => {
    (acc[f.category] ||= []).push(f);
    return acc;
  }, {});

  const mapping = status?.mapping ?? {};
  const mappedCount = D4_FONTS.filter((f) => mapping[f.name]?.ttfPath).length;
  const isReady = !!status?.d4Root && !!status?.tools.ready;

  return (
    <div className="flex-1 flex flex-col min-h-0 relative overflow-hidden" style={{ background: "#0d0204" }}>
      <D4Hero />

      <header
        className="h-12 px-4 flex items-center gap-3 shrink-0 relative"
        style={{
          background: "rgba(13, 2, 4, 0.75)",
          backdropFilter: "blur(8px)",
          borderBottom: "1px solid rgba(220, 38, 38, 0.25)",
          zIndex: 2,
        }}
      >
        <button
          onClick={onHome}
          className="px-2 py-1 text-[11px] flex items-center gap-1 rounded-sm transition-colors"
          style={{
            background: "rgba(220, 38, 38, 0.15)",
            border: "1px solid rgba(220, 38, 38, 0.3)",
            color: "#f5e6e6",
          }}
        >
          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M10 19l-7-7m0 0l7-7m-7 7h18" />
          </svg>
          {t("btn.home")}
        </button>
        <span className="text-[10px] tracking-[0.3em] uppercase font-semibold" style={{ color: "#dc2626" }}>
          {t("d4.case")}
        </span>
        <span className="text-[13px]" style={{ color: "rgba(245,230,230,0.75)" }}>
          {t("d4.text.title", { brand: t("d4.brand"), mode: t("d4.mode.fonts") })}
        </span>
        <div className="flex-1" />
        <button
          onClick={runExtract}
          disabled={!isReady || busy}
          className="px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wider rounded-sm transition-all"
          style={{
            background: !isReady ? "rgba(245,230,230,0.05)" : "rgba(220,38,38,0.18)",
            color: !isReady ? "rgba(245,230,230,0.3)" : "#fca5a5",
            border: `1px solid ${!isReady ? "rgba(245,230,230,0.15)" : "rgba(220,38,38,0.35)"}`,
            cursor: !isReady || busy ? "not-allowed" : "pointer",
          }}
          title={!isReady ? t("d4.fonts.btn.extractTitleDisabled") : t("d4.fonts.btn.extractTitle")}
        >
          {status?.extracted ? t("d4.fonts.btn.reextract") : t("d4.fonts.btn.extract")}
        </button>
        <button
          onClick={runGenerate}
          disabled={!isReady || busy || mappedCount === 0 || !status?.extracted}
          className="px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wider rounded-sm transition-all"
          style={{
            background: (!isReady || mappedCount === 0 || !status?.extracted)
              ? "rgba(245,230,230,0.05)"
              : "rgba(220,38,38,0.18)",
            color: (!isReady || mappedCount === 0 || !status?.extracted) ? "rgba(245,230,230,0.3)" : "#fca5a5",
            border: `1px solid ${(!isReady || mappedCount === 0 || !status?.extracted) ? "rgba(245,230,230,0.15)" : "rgba(220,38,38,0.35)"}`,
            cursor: (!isReady || busy || mappedCount === 0 || !status?.extracted) ? "not-allowed" : "pointer",
          }}
          title={
            !status?.extracted ? t("d4.fonts.btn.generateNeedExtract")
            : mappedCount === 0 ? t("d4.fonts.btn.generateNeedTtf")
            : t("d4.fonts.btn.generateTitle")
          }
        >
          {t("d4.fonts.btn.generate")}
        </button>
        <button
          onClick={runPack}
          disabled={!isReady || busy || Object.keys(generatedPreviews).length === 0}
          className="px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wider rounded-sm transition-all"
          style={{
            background: (!isReady || Object.keys(generatedPreviews).length === 0)
              ? "rgba(245,230,230,0.05)"
              : "linear-gradient(135deg, #dc2626 0%, #991b1b 100%)",
            color: (!isReady || Object.keys(generatedPreviews).length === 0) ? "rgba(245,230,230,0.3)" : "#fff",
            border: `1px solid ${(!isReady || Object.keys(generatedPreviews).length === 0) ? "rgba(245,230,230,0.15)" : "#ef4444"}`,
            boxShadow: (!isReady || Object.keys(generatedPreviews).length === 0) ? "none" : "0 0 15px rgba(220,38,38,0.4)",
            cursor: (!isReady || busy || Object.keys(generatedPreviews).length === 0) ? "not-allowed" : "pointer",
          }}
          title={
            Object.keys(generatedPreviews).length === 0 ? t("d4.fonts.btn.packNeedGen")
            : t("d4.fonts.btn.packTitle")
          }
        >
          {t("d4.fonts.btn.pack")}
        </button>
      </header>

      <div className="flex-1 overflow-y-auto relative" style={{ zIndex: 1 }}>
        <div className="max-w-[1280px] mx-auto px-8 py-8 space-y-5">
          {/* Hero title */}
          <section className="text-center">
            <div className="text-[10px] font-bold tracking-[0.4em] mb-2" style={{ color: "#dc2626" }}>
              {t("d4.fonts.brandFull")}
            </div>
            <h1 className="text-[28px] font-light tracking-wider" style={{ color: "#fff", textShadow: "0 0 25px rgba(220,38,38,0.4)" }}>
              {t("d4.fonts.title")}
            </h1>
          </section>

          {/* Toggle Original / Generated previews */}
          <section className="flex justify-center">
            <div className="inline-flex rounded-sm p-0.5" style={{ background: "rgba(0,0,0,0.4)", border: "1px solid rgba(220,38,38,0.25)" }}>
              {(["original", "generated"] as const).map((m) => {
                const active = previewMode === m;
                const count = m === "original"
                  ? Object.keys(previews).length
                  : Object.keys(generatedPreviews).length;
                return (
                  <button
                    key={m}
                    onClick={() => setPreviewMode(m)}
                    className="px-4 py-1.5 text-[11px] font-semibold uppercase tracking-wider transition-colors rounded-sm"
                    style={{
                      background: active ? "linear-gradient(135deg, #dc2626 0%, #991b1b 100%)" : "transparent",
                      color: active ? "#fff" : "rgba(245,230,230,0.6)",
                    }}
                  >
                    {m === "original" ? t("d4.fonts.preview.original") : t("d4.fonts.preview.generated")}
                    <span className="ml-1.5 text-[9.5px] font-mono opacity-70">{count}</span>
                  </button>
                );
              })}
            </div>
          </section>

          {/* Status grid */}
          <section className="grid grid-cols-1 md:grid-cols-4 gap-3">
            <FontStatusCard
              label={t("d4.fonts.status.extracted")}
              value={`${status?.extractedCount ?? 0} / 25`}
              ok={(status?.extractedCount ?? 0) > 0}
              hint={t("d4.fonts.status.previewCount", { n: status?.previewCount ?? 0 })}
            />
            <FontStatusCard
              label={t("d4.fonts.status.mapping")}
              value={`${mappedCount} / 25`}
              ok={mappedCount > 0}
              hint={mappedCount === 25 ? t("d4.fonts.status.mapping.all") : t("d4.fonts.status.mapping.pick")}
            />
            <FontStatusCard
              label={t("d4.status.tools")}
              value={status?.tools.ready ? t("d4.status.tools.ready") : t("d4.status.tools.missing")}
              ok={!!status?.tools.ready}
              hint={t("d4.fonts.status.tools.hint")}
            />
            <FontStatusCard
              label={t("d4.status.gameDir")}
              value={status?.d4Root ? t("d4.fonts.status.dir.ok") : t("d4.status.gameDir.notSet")}
              ok={!!status?.d4Root}
              hint={t("d4.fonts.status.dir.hint")}
            />
          </section>

          {/* Категорії шрифтів */}
          {Object.entries(grouped).map(([cat, items]) => (
            <section
              key={cat}
              className="rounded-sm p-4"
              style={{
                background: "rgba(13, 2, 4, 0.6)",
                backdropFilter: "blur(8px)",
                border: "1px solid rgba(220, 38, 38, 0.2)",
              }}
            >
              <header className="flex items-center justify-between mb-3">
                <h3 className="text-[11px] font-semibold tracking-[0.3em] uppercase" style={{ color: "#dc2626" }}>
                  {CATEGORY_KEY[cat] ? t(CATEGORY_KEY[cat]) : cat}
                </h3>
                <span className="text-[10.5px] font-mono" style={{ color: "rgba(245,230,230,0.45)" }}>
                  {t("d4.fonts.cat.count", { n: items.length })}
                </span>
              </header>
              <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
                {items.map((f) => {
                  const preview = previewMode === "original" ? previews[f.name] : generatedPreviews[f.name];
                  const ttf = mapping[f.name];
                  return (
                    <div
                      key={f.name}
                      className="rounded-sm overflow-hidden flex flex-col"
                      style={{
                        background: "rgba(0, 0, 0, 0.4)",
                        border: `1px solid ${ttf?.ttfPath ? "rgba(34, 197, 94, 0.3)" : "rgba(220, 38, 38, 0.18)"}`,
                      }}
                    >
                      {/* Preview area — click → lightbox */}
                      <button
                        type="button"
                        onClick={() => preview && setPreviewFor({ name: f.name, format: f.format })}
                        disabled={!preview}
                        className="relative h-[88px] flex items-center justify-center overflow-hidden group/preview"
                        style={{
                          background: "repeating-conic-gradient(rgba(245,230,230,0.05) 0% 25%, transparent 0% 50%) 0 0 / 12px 12px",
                          borderBottom: "1px solid rgba(220, 38, 38, 0.12)",
                          cursor: preview ? "zoom-in" : "default",
                        }}
                        title={preview ? t("d4.fonts.card.previewClick") : undefined}
                      >
                        {preview ? (
                          <img
                            src={preview}
                            alt={f.name}
                            style={{
                              maxHeight: "100%",
                              maxWidth: "100%",
                              objectFit: "contain",
                              filter: "invert(1) hue-rotate(180deg)",
                              opacity: 0.92,
                            }}
                          />
                        ) : (
                          <span className="text-[10px]" style={{ color: "rgba(245,230,230,0.35)" }}>
                            {status?.extracted ? t("d4.fonts.card.previewMissing") : t("d4.fonts.card.notExtracted")}
                          </span>
                        )}
                        {preview && (
                          <span
                            className="absolute inset-0 flex items-center justify-center opacity-0 group-hover/preview:opacity-100 transition-opacity"
                            style={{ background: "rgba(0,0,0,0.55)" }}
                          >
                            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="#fff" strokeWidth={2}>
                              <path strokeLinecap="round" strokeLinejoin="round" d="m21 21-5.197-5.197m0 0A7.5 7.5 0 1 0 5.196 5.196a7.5 7.5 0 0 0 10.607 10.607ZM10.5 7.5v6m-3-3h6" />
                            </svg>
                          </span>
                        )}
                        <span
                          className="absolute top-1.5 right-1.5 text-[9px] font-mono font-bold px-1.5 py-0.5 rounded-sm"
                          style={{
                            background: f.format === "BC3" ? "rgba(220,38,38,0.7)" : "rgba(251,191,36,0.6)",
                            color: "#fff",
                          }}
                        >
                          {f.format}
                        </span>
                      </button>
                      {/* Meta */}
                      <div className="p-2.5 flex-1 flex flex-col gap-1">
                        <div className="flex items-center gap-2">
                          <span className="font-mono text-[11.5px] font-semibold truncate" style={{ color: "#fff" }}>
                            {f.name}
                          </span>
                          {f.shadowOf && (
                            <span className="text-[9px]" style={{ color: "rgba(220,38,38,0.7)" }}>
                              ↳ {f.shadowOf}
                            </span>
                          )}
                        </div>
                        <button
                          onClick={() => pickTtf(f.name)}
                          className="text-left px-2 py-1.5 rounded-sm text-[10.5px] font-mono transition-colors"
                          style={{
                            background: ttf?.ttfPath ? "rgba(34, 197, 94, 0.1)" : "rgba(220, 38, 38, 0.08)",
                            border: `1px solid ${ttf?.ttfPath ? "rgba(34, 197, 94, 0.3)" : "rgba(220, 38, 38, 0.2)"}`,
                            color: ttf?.ttfPath ? "#86efac" : "rgba(245,230,230,0.75)",
                          }}
                          title={ttf?.ttfPath ?? t("d4.fonts.card.pick")}
                        >
                          {ttf?.ttfPath ? (
                            <>
                              <span style={{ color: "rgba(245,230,230,0.5)" }}>{t("d4.fonts.card.ttfLabel")}</span>{" "}
                              <span className="truncate inline-block max-w-[200px] align-middle">{fileName(ttf.ttfPath)}</span>
                              {ttf.source === "recon" && (
                                <span className="text-[8.5px] ml-1.5" style={{ color: "rgba(245,230,230,0.4)" }}>
                                  {t("d4.fonts.card.default")}
                                </span>
                              )}
                            </>
                          ) : (
                            <span style={{ color: "rgba(245,230,230,0.55)" }}>
                              {t("d4.fonts.card.pick")}
                            </span>
                          )}
                        </button>
                        {ttf?.ttfPath && ttf.source !== "recon" && (
                          <button
                            onClick={() => clearTtf(f.name)}
                            className="text-[9.5px] self-start"
                            style={{ color: "rgba(220, 38, 38, 0.7)" }}
                          >
                            {t("d4.fonts.card.clear")}
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </section>
          ))}

          {/* Phase 2: Generate + Pack — stub */}
          <section
            className="rounded-sm p-5"
            style={{
              background: "rgba(13, 2, 4, 0.5)",
              border: "1px dashed rgba(220, 38, 38, 0.3)",
            }}
          >
            <h3 className="text-[11px] font-semibold tracking-[0.3em] uppercase mb-2" style={{ color: "#dc2626" }}>
              {t("d4.fonts.phase2.title")}
            </h3>
            <p className="text-[12px] leading-relaxed" style={{ color: "rgba(245,230,230,0.6)" }}>
              {t("d4.fonts.phase2.body")}
            </p>
          </section>
        </div>
      </div>

      <D4FontPreviewModal
        open={!!previewFor}
        src={
          previewFor
            ? (previewMode === "original" ? previews[previewFor.name] : generatedPreviews[previewFor.name]) ?? ""
            : ""
        }
        name={previewFor?.name ?? ""}
        format={previewFor?.format}
        onClose={() => setPreviewFor(null)}
      />
      <D4ProgressModal
        open={busy}
        title={
          busyKind === "pack" ? t("d4.progress.fontsPack.title")
          : busyKind === "generate" ? t("d4.progress.fontsGen.title")
          : t("d4.progress.fonts.title")
        }
        subtitle={
          busyKind === "pack" ? t("d4.progress.fontsPack.subtitle")
          : busyKind === "generate" ? t("d4.progress.fontsGen.subtitle")
          : t("d4.progress.fonts.subtitle")
        }
        lines={logLines}
        files={fileProgress}
        current={fileProgress.filter((p) => p.status !== "pending").length}
        total={fileProgress.length}
        done={opDone}
        error={opError}
        onClose={() => setBusy(false)}
      />
    </div>
  );
}

function FontStatusCard({
  label, value, hint, ok,
}: { label: string; value: string; hint?: string; ok?: boolean }) {
  return (
    <div
      className="rounded-sm p-3"
      style={{
        background: "rgba(13, 2, 4, 0.6)",
        backdropFilter: "blur(8px)",
        border: `1px solid ${ok ? "rgba(34, 197, 94, 0.35)" : "rgba(220, 38, 38, 0.25)"}`,
      }}
    >
      <div
        className="text-[9px] font-bold tracking-[0.3em] uppercase mb-1.5"
        style={{ color: ok ? "#22c55e" : "#dc2626" }}
      >
        {label}
      </div>
      <div className="text-[15px] font-semibold tabular-nums" style={{ color: "#fff" }}>
        {value}
      </div>
      {hint && (
        <div className="text-[10px] mt-1 truncate" style={{ color: "rgba(245,230,230,0.5)" }} title={hint}>
          {hint}
        </div>
      )}
    </div>
  );
}
