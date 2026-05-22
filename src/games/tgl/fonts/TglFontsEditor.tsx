import { useEffect, useMemo, useRef, useState } from "react";
import { useT, t } from "../../../lib/i18n";
import { alert as showAlert, confirm as showConfirm } from "../../../lib/dialogs";
import { useTglFontsStore } from "./store";
import { useTglStore } from "../store";
import { charLabel, isCjkCp, isCyrCp, isLatinCp, type FontGlyph } from "./parser";

interface Props { onHome: () => void }

type Filter = "all" | "latin" | "cyr" | "cjk" | "missing";

// Українські літери, яких часто бракує у "латинських" шрифтах.
const UA_LETTERS = ["Є", "є", "І", "і", "Ї", "ї", "Ґ", "ґ", "’"];

export function TglFontsEditor({ onHome }: Props) {
  const t = useT();
  const init = useTglFontsStore((s) => s.init);
  const items = useTglFontsStore((s) => s.items);
  const baseFolder = useTglFontsStore((s) => s.baseFolder);
  const loading = useTglFontsStore((s) => s.loading);
  const error = useTglFontsStore((s) => s.error);
  const active = useTglFontsStore((s) => s.active);
  const parsed = useTglFontsStore((s) => s.parsed);
  const atlasBase64 = useTglFontsStore((s) => s.atlasBase64);
  const dirty = useTglFontsStore((s) => s.dirty);
  const rev = useTglFontsStore((s) => s.rev);
  const selectFont = useTglFontsStore((s) => s.selectFont);
  const saveJson = useTglFontsStore((s) => s.saveJson);
  const updateGlyph = useTglFontsStore((s) => s.updateGlyph);
  const copyFromGlyph = useTglFontsStore((s) => s.copyFromGlyph);
  const normalizeCyrillicNow = useTglFontsStore((s) => s.normalizeCyrillicNow);
  const importMetricsFromFontFace = useTglFontsStore((s) => s.importMetricsFromFontFace);
  const saveAtlas = useTglFontsStore((s) => s.saveAtlas);
  const storeAtlasW = useTglFontsStore((s) => s.atlasW);
  const storeAtlasH = useTglFontsStore((s) => s.atlasH);

  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [activeCp, setActiveCp] = useState<number | null>(null);
  const [previewText, setPreviewText] = useState(() => t("tglFonts.preview.default"));
  const [zoom, setZoom] = useState(1);
  const [addOpen, setAddOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const atlasScrollRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => { init(); }, [init]);

  // Auto-extract: якщо TGL bundle (tglCabPath) відомий зі settings (а ми
  // автоматично резолвимо його з tglRoot у readSettings()), і список items
  // ще порожній — одразу запускаємо extract без UI-кліку.
  const autoExtractTriedRef = useRef(false);
  useEffect(() => {
    if (loading || items.length > 0 || autoExtractTriedRef.current) return;
    autoExtractTriedRef.current = true;
    (async () => {
      try {
        const settings: any = await window.dp2.getSettings();
        const cabPath: string | undefined = settings?.tglCabPath;
        if (!cabPath) return;
        const res: any = await window.dp2.tglFontsExtract({ cabPath });
        if (res?.ok) {
          await init();
          const fresh = useTglFontsStore.getState().items;
          if (fresh.length === 1) {
            await selectFont(fresh[0]);
            setActiveCp(null);
          }
        }
      } catch {}
    })();
  }, [loading, items.length, init, selectFont]);

  // Delete клавіша — видалити активний гліф (запис + ділянка атласу).
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== "Delete") return;
      if (activeCp == null) return;
      const tgt = e.target as HTMLElement | null;
      // Ігноруємо натискання в текстових інпутах (щоб не заважати редагуванню).
      if (tgt && (tgt.tagName === "INPUT" || tgt.tagName === "TEXTAREA" || tgt.isContentEditable)) return;
      e.preventDefault();
      const removeFn = useTglFontsStore.getState().removeGlyph;
      removeFn(activeCp);
      setActiveCp(null);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [activeCp]);

  const glyphs = parsed?.data.m_CharacterRects.Array ?? [];
  // Реальний розмір атласу беремо з PNG (через store.setAtlasSize, який
  // викликається з AtlasView/GamePreview після img.load), а не з parsed-JSON
  // (там часто немає m_AtlasWidth/Height — фолбек давав 2048×2048, що ламало
  // координати для атласів 2048×4096 / 4096×4096).
  const atlasW = storeAtlasW || parsed?.atlasWidth || 2048;
  const atlasH = storeAtlasH || parsed?.atlasHeight || 2048;

  const filtered = useMemo(() => {
    const q = search.trim();
    const qcp = q.length === 1 ? q.codePointAt(0) : NaN;
    const qNum = /^\d+$/.test(q) ? parseInt(q, 10) : NaN;
    // Фільтр "missing" обробляється окремо нижче — повертає порожній,
    // бо це не наявні гліфи (для них окрема панель MissingFromText).
    if (filter === "missing") return [];
    return glyphs.filter((g) => {
      const cp = g.index;
      if (filter === "latin" && !isLatinCp(cp)) return false;
      if (filter === "cyr" && !isCyrCp(cp)) return false;
      if (filter === "cjk" && !isCjkCp(cp)) return false;
      if (!q) return true;
      if (!Number.isNaN(qcp) && cp === qcp) return true;
      if (!Number.isNaN(qNum) && cp === qNum) return true;
      const ch = String.fromCodePoint(cp);
      return ch.toLowerCase().includes(q.toLowerCase());
    });
  }, [glyphs, search, filter]);

  // Список відсутніх UA-літер з нашого reference-набору (UA_LETTERS).
  const missingUa = useMemo(() => {
    if (!parsed) return [];
    return UA_LETTERS.filter((c) => !parsed.glyphsByIndex.has(c.codePointAt(0)!));
  }, [parsed, rev]);

  // Усі codepoints з активного TGL-перекладу. Будуємо set, потім перевіряємо
  // які з них відсутні у шрифті — універсально для будь-якої мови.
  const tglUaTexts = useTglStore((s) => s.uaTexts);
  const missingFromText = useMemo(() => {
    if (!parsed || !tglUaTexts?.length) return { codes: [] as number[], samples: new Map<number, string>() };
    const present = new Set<number>();
    const samples = new Map<number, string>();
    for (const txt of tglUaTexts) {
      if (typeof txt !== "string" || !txt) continue;
      for (const ch of txt) {
        const cp = ch.codePointAt(0)!;
        if (cp < 0x20) continue;          // control chars
        if (parsed.glyphsByIndex.has(cp)) continue;
        if (!present.has(cp)) {
          present.add(cp);
          samples.set(cp, txt.length > 60 ? txt.slice(0, 60) + "…" : txt);
        }
      }
    }
    const codes = [...present].sort((a, b) => a - b);
    return { codes, samples };
  }, [tglUaTexts, parsed, rev]);

  const activeGlyph = activeCp != null ? parsed?.glyphsByIndex.get(activeCp) ?? null : null;

  async function doSave() {
    const r = await saveJson();
    if (r.ok) await showAlert(t("tglFonts.saved"), t("tglFonts.savedBody"), { tone: "success" });
    else await showAlert(t("tglFonts.saveErr"), r.error ?? "?", { tone: "danger" });
  }

  async function doImportMetrics() {
    // file picker через прихований <input type=file>
    return new Promise<void>((resolve) => {
      const input = document.createElement("input");
      input.type = "file";
      input.accept = ".ttf,.otf,.woff,.woff2";
      input.onchange = async () => {
        const f = input.files?.[0];
        if (!f) { resolve(); return; }
        try {
          const bytes = await f.arrayBuffer();
          const family = `__tglMetrics_${Date.now()}`;
          const face = new FontFace(family, bytes);
          await face.load();
          (document.fonts as any).add(face);
          // Запитуємо scope: усі / тільки кирилиця / тільки латиниця.
          const stats = importMetricsFromFontFace(family, "all");
          await showAlert(
            t("tglFonts.importMetrics.doneTitle"),
            t("tglFonts.importMetrics.doneBody", { touched: stats.touched, skipped: stats.skipped, file: f.name }),
            { tone: "success" }
          );
        } catch (e: any) {
          await showAlert(t("tglFonts.importMetrics.errTitle"), String(e?.message ?? e), { tone: "danger" });
        } finally {
          resolve();
        }
      };
      input.click();
    });
  }

  async function doNormalize() {
    const ok = await showConfirm(
      t("tglFonts.normalize.confirmTitle"),
      t("tglFonts.normalize.confirmBody"),
      { okLabel: t("tglFonts.normalize.confirmOk"), cancelLabel: t("btn.cancel") }
    );
    if (!ok) return;
    const stats = normalizeCyrillicNow();
    if (!stats) return;
    await showAlert(
      t("tglFonts.normalize.doneTitle"),
      t("tglFonts.normalize.doneBody", { touched: stats.touched, paired: stats.paired, fit: stats.fit }),
      { tone: "success" }
    );
  }

  // Render guards
  if (!active) {
    return (
      <div className="flex-1 flex flex-col bg-[var(--bg)] min-h-0">
        <Header onHome={onHome} title={t("tglFonts.brand")} />
        <div className="flex-1 min-h-0 overflow-auto p-6">
          <div className="max-w-[920px] mx-auto">
            <h2 className="text-[20px] font-bold text-[var(--text-strong)] mb-1 tracking-tight">{t("tglFonts.pickTitle")}</h2>
            <p className="text-[11.5px] text-[var(--text-faint)] font-mono mb-6 truncate" title={baseFolder ?? ""}>
              {baseFolder ? baseFolder : t("tglFonts.noFolder")}
            </p>
            {loading && <p className="text-[13px] text-[var(--text-muted)]">{t("app.loading")}</p>}
            {error && <p className="text-[12px] text-[var(--danger)] whitespace-pre-wrap mb-3">{error}</p>}
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
              {items.map((it) => {
                const jsonName = it.jsonPath.split(/[\\/]/).pop() ?? "";
                const atlasName = it.atlasPath ? (it.atlasPath.split(/[\\/]/).pop() ?? "") : null;
                return (
                  <button
                    key={it.jsonPath}
                    onClick={() => { selectFont(it); setActiveCp(null); }}
                    className="group relative text-left rounded-xl border border-[var(--border-soft)] bg-gradient-to-br from-[var(--bg-surface)] to-[var(--bg-elevated)] hover:border-[var(--accent)] hover:shadow-[0_0_0_1px_var(--accent)] transition-all p-5"
                  >
                    <p className="text-[15px] font-bold text-[var(--text-strong)] truncate mb-2" title={it.name}>
                      {it.name}
                    </p>
                    {/* Status pill */}
                    <div className="flex items-center gap-2 mb-4">
                      <span className={`dp-pill ${it.atlasPath ? "dp-pill--success" : "dp-pill--warn"} text-[10px]`}>
                        {it.atlasPath ? "JSON + PNG" : "JSON only"}
                      </span>
                    </div>
                    {/* Stats grid */}
                    <div className="grid grid-cols-3 gap-2 text-[10.5px] font-mono text-[var(--text-faint)] mb-3 pt-3 border-t border-[var(--border-soft)]">
                      <div>
                        <p className="uppercase tracking-wider text-[9px] mb-0.5">size</p>
                        <p className="text-[var(--text-strong)] text-[12px] tabular-nums">{it.fontSize}</p>
                      </div>
                      <div>
                        <p className="uppercase tracking-wider text-[9px] mb-0.5">line</p>
                        <p className="text-[var(--text-strong)] text-[12px] tabular-nums">{it.lineSpacing}</p>
                      </div>
                      <div>
                        <p className="uppercase tracking-wider text-[9px] mb-0.5">glyphs</p>
                        <p className="text-[var(--text-strong)] text-[12px] tabular-nums">{it.charCount.toLocaleString("uk-UA")}</p>
                      </div>
                    </div>
                    {/* File path */}
                    <p className="text-[10px] text-[var(--text-faint)] font-mono truncate" title={jsonName}>
                      📄 {jsonName}
                    </p>
                    {atlasName && (
                      <p className="text-[10px] text-[var(--text-faint)] font-mono truncate" title={atlasName}>
                        🖼 {atlasName}
                      </p>
                    )}
                  </button>
                );
              })}
              {!loading && items.length === 0 && (
                <div className="rounded-lg border border-[var(--accent)]/40 bg-[var(--accent-soft)] p-5">
                  <p className="text-[13px] text-[var(--text)] mb-2 leading-relaxed">
                    {t("tglFonts.extract.hint")}
                  </p>
                  <p className="text-[11px] text-[var(--text-faint)] font-mono mb-3 break-all">
                    StreamingAssets/c0718fc478f6943d/CAB-…
                  </p>
                  <button
                    className="dp-btn dp-btn--primary"
                    onClick={async () => {
                      // Беремо збережений cabPath, інакше pickFile.
                      const settings: any = await window.dp2.getSettings();
                      let cabPath: string | null = settings?.tglCabPath || null;
                      if (!cabPath) {
                        cabPath = await window.dp2.pickFile({
                          title: t("tglFonts.extract.pickTitle"),
                          filters: [{ name: "Unity CAB", extensions: ["*"] }],
                        });
                      }
                      if (!cabPath) return;
                      const res = await window.dp2.tglFontsExtract({ cabPath });
                      // Якщо збережений шлях вже невалідний — попросимо новий.
                      if (!res.ok && /не знайдено/i.test(res.error || "")) {
                        cabPath = await window.dp2.pickFile({
                          title: t("tglFonts.extract.pickTitle"),
                          filters: [{ name: "Unity CAB", extensions: ["*"] }],
                        });
                        if (!cabPath) return;
                        Object.assign(res, await window.dp2.tglFontsExtract({ cabPath }));
                      }
                      if (!res.ok) {
                        await showAlert(t("tglFonts.extract.errTitle"), res.error ?? "?", { tone: "danger" });
                        return;
                      }
                      // PowerShell ConvertTo-Json для 1 елемента вертає object,
                      // не array — нормалізуємо тут (старі білди скрипта так
                      // робили, новий вже emit-ить `@($exported)`).
                      const expArr = Array.isArray(res.exported)
                        ? res.exported
                        : (res.exported ? [res.exported] : []);
                      const extractedJson = expArr[0]?.json as string | undefined;
                      await showAlert(
                        t("tglFonts.extract.doneTitle"),
                        t("tglFonts.extract.doneBody", { n: expArr.length, dir: res.outDir ?? "" }),
                        { tone: "success" }
                      );
                      await init(); // re-scan StreamingAssets + toolsDir
                      const freshItems = useTglFontsStore.getState().items;
                      const norm = (p: string) => p.replace(/\\/g, "/").toLowerCase();
                      let pick = extractedJson
                        ? freshItems.find((x) => norm(x.jsonPath) === norm(extractedJson))
                        : undefined;
                      if (!pick) pick = freshItems.find((x) => /chiarostd/i.test(x.name) || /chiarostd/i.test(x.jsonPath));
                      if (!pick && freshItems.length > 0) pick = freshItems[0];
                      if (pick) {
                        await selectFont(pick);
                        setActiveCp(null);
                      }
                    }}
                  >
                    {t("tglFonts.extract.btn")}
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col bg-[var(--bg)] min-h-0 relative">
      {busy && (
        <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
          <div className="rounded-lg border border-[var(--border-soft)] bg-[var(--bg-surface)] px-6 py-5 min-w-[420px] max-w-[680px] shadow-2xl">
            <p className="text-[13px] font-semibold text-[var(--text-strong)] mb-2">⏳ Працюю…</p>
            <p className="text-[12px] font-mono text-[var(--text-muted)] whitespace-pre-wrap break-all leading-relaxed">{busy}</p>
          </div>
        </div>
      )}
      <Header onHome={onHome} title={t("tglFonts.brand")}>
        <select
          value={active.jsonPath}
          onChange={(e) => {
            const it = items.find((x) => x.jsonPath === e.target.value);
            if (it) { selectFont(it); setActiveCp(null); }
          }}
          className="dp-input"
          title={active.jsonPath}
        >
          {items.map((it) => (
            <option key={it.jsonPath} value={it.jsonPath}>
              {it.name} ({it.charCount.toLocaleString("uk-UA")})
            </option>
          ))}
        </select>
        <span className="text-[11px] text-[var(--text-faint)] tabular-nums whitespace-nowrap">
          {atlasW}×{atlasH}
        </span>
        <div className="flex-1" />
        {missingUa.length > 0 && (
          <span className="text-[10.5px] dp-pill--danger px-2.5 py-1 rounded font-mono whitespace-nowrap"
            title={t("tglFonts.missingUaTitle")}
          >
            ⚠ {t("tglFonts.missingUa", { chars: missingUa.join(" ") })}
          </span>
        )}
        <button className="dp-btn dp-btn--ghost" onClick={doNormalize} disabled={!parsed} title={t("tglFonts.normalize.btn")}>
          {t("tglFonts.normalize.btn")}
        </button>
        <button className="dp-btn dp-btn--ghost" onClick={doImportMetrics} disabled={!parsed} title={t("tglFonts.importMetrics.hint")}>
          {t("tglFonts.importMetrics.btn")}
        </button>
        <button className="dp-btn" onClick={() => setAddOpen(true)} disabled={!parsed}>
          {t("tglFonts.addGlyph")}
        </button>
        <button
          className="dp-btn dp-btn--ghost"
          onClick={async () => {
            const r = await saveAtlas();
            if (r.ok) await showAlert(t("tglFonts.saveAtlas.doneTitle"), t("tglFonts.saveAtlas.doneBody"), { tone: "success" });
            else await showAlert(t("tglFonts.saveAtlas.errTitle"), r.error ?? "?", { tone: "danger" });
          }}
          disabled={!atlasBase64}
          title={t("tglFonts.saveAtlas.hint")}
        >
          {t("tglFonts.saveAtlas.btn")}
        </button>
        <button className="dp-btn dp-btn--success" onClick={doSave} disabled={!dirty}>
          {dirty ? t("tglFonts.save") : t("tglFonts.saved")}
        </button>
        <button
          className="dp-btn dp-btn--primary"
          disabled={!active || !active.atlasPath}
          title={t("tglFonts.packToCab.hint")}
          onClick={async () => {
            if (!active || !active.atlasPath) return;
            // 1) flush JSON+atlas на диск
            if (dirty) {
              const r1 = await saveJson();
              if (!r1.ok) {
                await showAlert(t("tglFonts.saveErr"), r1.error ?? "?", { tone: "danger" });
                return;
              }
            }
            const r2 = await saveAtlas();
            if (!r2.ok) {
              await showAlert(t("tglFonts.saveAtlas.errTitle"), r2.error ?? "?", { tone: "danger" });
              return;
            }
            // 2) cabPath: беремо збережений, інакше pickFile.
            const settings: any = await window.dp2.getSettings();
            let cabPath: string | null = settings?.tglCabPath || null;
            if (!cabPath) {
              cabPath = await window.dp2.pickFile({
                title: t("tglFonts.packToCab.pickTitle"),
                filters: [{ name: "Unity CAB", extensions: ["*"] }],
              });
            }
            if (!cabPath) return;
            const ok = await showConfirm(
              t("tglFonts.packToCab.confirmTitle"),
              t("tglFonts.packToCab.confirmBody", { cab: cabPath }),
              { okLabel: t("tglFonts.packToCab.confirmOk"), cancelLabel: t("btn.cancel") }
            );
            if (!ok) return;
            // Live-прогрес зі stdout PowerShell у busy-overlay.
            const unsub = (window.dp2 as any).onTglFontsImportProgress?.((line: string) => {
              setBusy(line.trim().slice(0, 200));
            });
            setBusy(t("tglFonts.busy.starting"));
            let res;
            try {
              res = await window.dp2.tglFontsImportToCab({
                cabPath,
                jsonPath: active.jsonPath,
                pngPath: active.atlasPath,
              });
            } finally {
              setBusy(null);
              if (typeof unsub === "function") unsub();
            }
            if (!res.ok) {
              await showAlert(t("tglFonts.packToCab.errTitle"), res.error ?? "?", { tone: "danger" });
              return;
            }
            await showAlert(
              t("tglFonts.packToCab.doneTitle"),
              t("tglFonts.packToCab.doneBody", { output: res.output ?? cabPath, size: res.size ?? 0, glyphs: res.glyphs ?? 0 }),
              { tone: "success" }
            );
          }}
        >
          {t("tglFonts.packToCab.btn")}
        </button>
      </Header>

      {parsed ? (
        <div className="flex-1 flex min-h-0">
          {/* LEFT: char list */}
          <section className="w-[340px] shrink-0 flex flex-col border-r border-[var(--border-soft)] min-h-0">
            <div className="px-3 py-2 border-b border-[var(--border-soft)] flex flex-wrap gap-1.5 shrink-0">
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder={t("tglFonts.search")}
                className="dp-input flex-1 min-w-0"
              />
            </div>
            <div className="px-3 py-1.5 border-b border-[var(--border-soft)] flex flex-wrap gap-1 shrink-0">
              {([
                ["all", t("tglFonts.filter.all", { n: glyphs.length })],
                ["latin", t("tglFonts.filter.latin")],
                ["cyr", t("tglFonts.filter.cyr")],
                ["cjk", t("tglFonts.filter.cjk")],
                ["missing", t("tglFonts.filter.missing", { n: missingFromText.codes.length })],
              ] as Array<[Filter, string]>).map(([v, lab]) => (
                <button
                  key={v}
                  onClick={() => setFilter(v)}
                  className={`dp-btn ${filter === v ? "dp-btn--primary" : ""}`}
                >
                  {lab}
                </button>
              ))}
            </div>
            {filter === "missing" ? (
              <MissingPanel
                codes={missingFromText.codes}
                samples={missingFromText.samples}
                onPick={(cp) => setActiveCp(cp)}
                onCreate={(cp) => {
                  setAddOpen(true);
                  setActiveCp(cp);
                }}
              />
            ) : (
            <div className="flex-1 min-h-0 overflow-auto">
              <table className="w-full text-[12px]">
                <thead className="sticky top-0 z-10 bg-[var(--bg-surface)] text-[10.5px] uppercase tracking-wider text-[var(--text-faint)] border-b border-[var(--border-soft)]">
                  <tr>
                    <th className="text-left px-2 py-1.5">U+</th>
                    <th className="text-left px-2 py-1.5">{t("tglFonts.col.char")}</th>
                    <th className="text-right px-2 py-1.5">adv</th>
                    <th className="text-right px-2 py-1.5">vw×vh</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.slice(0, 1000).map((g) => {
                    const isActive = g.index === activeCp;
                    return (
                      <tr
                        key={g.index}
                        onClick={() => setActiveCp(g.index)}
                        className={`cursor-pointer border-b border-[var(--border-soft)] ${
                          isActive ? "bg-[var(--row-active)]" : "hover:bg-[var(--row-hover)]"
                        }`}
                      >
                        <td className="px-2 py-1 font-mono text-[10.5px] text-[var(--text-faint)]">
                          {g.index.toString(16).toUpperCase().padStart(4, "0")}
                        </td>
                        <td className="px-2 py-1 text-[14px] text-[var(--text)]">{charLabel(g.index)}</td>
                        <td className="px-2 py-1 text-right text-[var(--text-muted)] tabular-nums">{g.advance.toFixed(1)}</td>
                        <td className="px-2 py-1 text-right text-[var(--text-faint)] tabular-nums">
                          {g.vert?.width?.toFixed(0)}×{Math.abs(g.vert?.height ?? 0).toFixed(0)}
                        </td>
                      </tr>
                    );
                  })}
                  {filtered.length > 1000 && (
                    <tr><td colSpan={4} className="px-2 py-2 text-center text-[11px] text-[var(--text-faint)]">
                      {t("tglFonts.truncated", { n: filtered.length })}
                    </td></tr>
                  )}
                </tbody>
              </table>
            </div>
            )}
          </section>

          {/* CENTER: atlas + game preview */}
          <section className="flex-1 flex flex-col min-w-0 min-h-0">
            <div className="px-3 py-2 border-b border-[var(--border-soft)] flex items-center gap-2 shrink-0">
              <label className="text-[11px] text-[var(--text-faint)] uppercase tracking-wider">{t("tglFonts.preview.label")}</label>
              <input
                value={previewText}
                onChange={(e) => setPreviewText(e.target.value)}
                className="dp-input flex-1"
                placeholder={t("tglFonts.preview.placeholder")}
              />
            </div>
            <div className="border-b border-[var(--border-soft)] bg-[var(--bg-elevated)] p-4 shrink-0">
              <GamePreview parsedRev={rev} text={previewText} />
            </div>
            <div className="px-3 py-1.5 border-b border-[var(--border-soft)] flex items-center gap-2 shrink-0">
              <span className="text-[11px] text-[var(--text-faint)] uppercase tracking-wider">{t("tglFonts.atlas")}</span>
              <button className="dp-btn dp-btn--ghost" onClick={() => setZoom(Math.max(0.1, zoom - 0.1))}>−</button>
              <span className="text-[11px] tabular-nums">{Math.round(zoom * 100)}%</span>
              <button className="dp-btn dp-btn--ghost" onClick={() => setZoom(Math.min(4, zoom + 0.1))}>+</button>
              <button className="dp-btn dp-btn--ghost" onClick={() => setZoom(1)}>{t("tglFonts.fit")}</button>
            </div>
            <div ref={atlasScrollRef} className="flex-1 min-h-0 overflow-auto bg-[var(--bg-elevated)]">
              <AtlasView
                base64={atlasBase64}
                width={atlasW}
                height={atlasH}
                glyphs={glyphs}
                zoom={zoom}
                activeCp={activeCp}
                onPickGlyph={(cp) => setActiveCp(cp)}
                onZoom={(factor) => {
                  setZoom((z) => Math.max(0.1, Math.min(4, +(z * factor).toFixed(2))));
                }}
                scrollContainerRef={atlasScrollRef}
              />
            </div>
          </section>

          {/* RIGHT: inspector */}
          <aside className="w-[340px] shrink-0 flex flex-col border-l border-[var(--border-soft)] bg-[var(--bg-surface)] min-h-0">
            {activeGlyph ? (
              <GlyphInspector
                glyph={activeGlyph}
                atlasW={atlasW}
                atlasH={atlasH}
                onChange={(patch) => updateGlyph(activeGlyph.index, patch)}
                onCopyFromCyrPair={() => {
                  // А ← A: вгадуємо пару з parser util.
                  const ch = String.fromCodePoint(activeGlyph.index);
                  const pairs: Record<string, string> = {
                    "А": "A", "В": "B", "Е": "E", "К": "K", "М": "M", "Н": "H", "О": "O",
                    "Р": "P", "С": "C", "Т": "T", "Х": "X", "У": "Y", "І": "I", "Ї": "Ï",
                    "а": "a", "в": "b", "е": "e", "к": "k", "м": "m", "н": "h", "о": "o",
                    "р": "p", "с": "c", "т": "t", "х": "x", "у": "y", "і": "i", "ї": "ï",
                  };
                  const src = pairs[ch];
                  if (!src) return;
                  copyFromGlyph(activeGlyph.index, src.codePointAt(0)!);
                }}
              />
            ) : (
              <div className="flex-1 flex items-center justify-center p-8 text-center">
                <p className="text-[12.5px] text-[var(--text-muted)]">{t("tglFonts.pickGlyph")}</p>
              </div>
            )}
          </aside>
        </div>
      ) : (
        <div className="flex-1 flex items-center justify-center">
          <p className="text-[13px] text-[var(--text-muted)]">{t("app.loading")}</p>
        </div>
      )}

      {addOpen && parsed && (
        <AddGlyphModal
          onClose={() => setAddOpen(false)}
          defaultTarget={activeCp ?? undefined}
        />
      )}
    </div>
  );
}

// ───────────────── sub-components ─────────────────

interface MissingPanelProps {
  codes: number[];
  samples: Map<number, string>;
  onPick: (cp: number) => void;
  onCreate: (cp: number) => void;
}
function MissingPanel({ codes, samples, onPick, onCreate }: MissingPanelProps) {
  const t = useT();
  return (
    <div className="flex-1 min-h-0 overflow-auto">
      <div className="px-3 py-2 text-[11px] text-[var(--text-muted)] leading-relaxed border-b border-[var(--border-soft)]">
        {t("tglFonts.missing.hint")}
      </div>
      {codes.length === 0 ? (
        <p className="py-10 text-center text-[12px] text-[var(--text-faint)]">
          {t("tglFonts.missing.none")}
        </p>
      ) : (
        <table className="w-full text-[12px]">
          <thead className="sticky top-0 z-10 bg-[var(--bg-surface)] text-[10.5px] uppercase tracking-wider text-[var(--text-faint)] border-b border-[var(--border-soft)]">
            <tr>
              <th className="text-left px-2 py-1.5">U+</th>
              <th className="text-left px-2 py-1.5">{t("tglFonts.col.char")}</th>
              <th className="text-left px-2 py-1.5">{t("tglFonts.missing.sample")}</th>
              <th className="text-right px-2 py-1.5"></th>
            </tr>
          </thead>
          <tbody>
            {codes.slice(0, 500).map((cp) => (
              <tr key={cp} className="border-b border-[var(--border-soft)] hover:bg-[var(--row-hover)]">
                <td className="px-2 py-1 font-mono text-[10.5px] text-[var(--text-faint)]">
                  {cp.toString(16).toUpperCase().padStart(4, "0")}
                </td>
                <td className="px-2 py-1 text-[16px] text-[var(--text)]">
                  {String.fromCodePoint(cp)}
                </td>
                <td className="px-2 py-1 text-[10.5px] text-[var(--text-faint)] truncate max-w-[160px]" title={samples.get(cp) ?? ""}>
                  {samples.get(cp) ?? ""}
                </td>
                <td className="px-1 py-1 text-right">
                  <button
                    className="dp-btn dp-btn--primary text-[10.5px]"
                    onClick={() => { onPick(cp); onCreate(cp); }}
                  >
                    {t("tglFonts.missing.create")}
                  </button>
                </td>
              </tr>
            ))}
            {codes.length > 500 && (
              <tr><td colSpan={4} className="px-2 py-2 text-center text-[11px] text-[var(--text-faint)]">
                {t("tglFonts.truncated", { n: codes.length })}
              </td></tr>
            )}
          </tbody>
        </table>
      )}
    </div>
  );
}

function Header({ onHome, title, children }: { onHome: () => void; title: string; children?: React.ReactNode }) {
  return (
    <header className="min-h-12 px-3 py-1.5 border-b border-[var(--border-soft)] bg-[var(--bg-surface)] flex flex-wrap items-center gap-2 shrink-0">
      <button className="dp-btn dp-btn--ghost shrink-0" onClick={onHome}>
        <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M10 19l-7-7m0 0l7-7m-7 7h18" />
        </svg>
      </button>
      <span className="text-[13px] text-[var(--text-muted)] shrink-0">{title}</span>
      {children}
    </header>
  );
}

interface AtlasViewProps {
  base64: string | null;
  width: number;
  height: number;
  glyphs: FontGlyph[];
  zoom: number;
  activeCp: number | null;
  onPickGlyph: (cp: number) => void;
}
function AtlasView({ base64, width, height, glyphs, zoom, activeCp, onPickGlyph, onZoom, scrollContainerRef }: AtlasViewProps & { onZoom?: (factor: number, mouseX: number, mouseY: number) => void; scrollContainerRef?: React.RefObject<HTMLDivElement | null> }) {
  const wrapRef = useRef<HTMLDivElement | null>(null);

  // Scroll-to-glyph: коли користувач клацає у списку → центруємо активну
  // рамку у видимій частині scroll-контейнера атласу.
  useEffect(() => {
    const sc = scrollContainerRef?.current;
    if (!sc || activeCp == null) return;
    const g = glyphs.find((x) => x.index === activeCp);
    if (!g) return;
    const cx = (g.uv.x + Math.abs(g.uv.width) / 2) * width * zoom;
    const cy = (height - g.uv.y + Math.abs(g.uv.height) / 2 - Math.abs(g.uv.height)) * zoom;
    sc.scrollTo({
      left: Math.max(0, cx - sc.clientWidth / 2),
      top: Math.max(0, cy - sc.clientHeight / 2),
      behavior: "smooth",
    });
  }, [activeCp, glyphs, width, height, zoom, scrollContainerRef]);

  const imgCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const overlayCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const [imgLoaded, setImgLoaded] = useState(false);

  useEffect(() => {
    if (!base64) return;
    let cancelled = false;
    const img = new Image();
    img.onload = () => {
      if (cancelled) return;
      imgRef.current = img;
      setImgLoaded(true);
      useTglFontsStore.getState().setAtlasSize(img.naturalWidth, img.naturalHeight);
    };
    img.onerror = () => {
      if (cancelled) return;
      // Раніше: silent failure — GamePreview не рендерився, без feedback.
      console.warn("TGL atlas image decode failed (corrupt base64?)");
      setImgLoaded(false);
    };
    img.src = `data:image/png;base64,${base64}`;
    return () => { cancelled = true; imgRef.current = null; setImgLoaded(false); };
  }, [base64]);

  // Image layer — малюється РІДКО (тільки на зміну zoom/imgLoaded).
  useEffect(() => {
    const c = imgCanvasRef.current;
    if (!c) return;
    c.width = Math.round(width * zoom);
    c.height = Math.round(height * zoom);
    const ctx = c.getContext("2d");
    if (!ctx) return;
    ctx.imageSmoothingEnabled = zoom < 1;
    const tile = 16;
    for (let y = 0; y < c.height; y += tile) {
      for (let x = 0; x < c.width; x += tile) {
        const dark = ((x / tile + y / tile) | 0) % 2 === 0;
        ctx.fillStyle = dark ? "#2a2a2a" : "#1f1f1f";
        ctx.fillRect(x, y, tile, tile);
      }
    }
    if (imgLoaded && imgRef.current) {
      ctx.drawImage(imgRef.current, 0, 0, c.width, c.height);
    }
  }, [width, height, zoom, imgLoaded]);

  // Overlay rects — окремий canvas, redraw через RAF (для 30k rects не лагає).
  const rafRef = useRef<number | null>(null);
  useEffect(() => {
    if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null;
      const c = overlayCanvasRef.current;
      if (!c) return;
      c.width = Math.round(width * zoom);
      c.height = Math.round(height * zoom);
      const ctx = c.getContext("2d");
      if (!ctx) return;
      ctx.clearRect(0, 0, c.width, c.height);
      ctx.lineWidth = 0.6;
      ctx.strokeStyle = "rgba(121,192,255,0.35)";
      // LOD: при малому zoom рамки гліфів зливаються в кашу — пропускаємо
      // рендер 8K Path2D rect-ів, малюємо лише активну (нижче). Це майже не
      // змінює візуал на zoom<0.3, але економить 30-60ms RAF.
      if (zoom >= 0.3) {
        const path = new Path2D();
        for (const g of glyphs) {
          const x = g.uv.x * width * zoom;
          const w = g.uv.width * width * zoom;
          const h = Math.abs(g.uv.height) * height * zoom;
          const y = (height - g.uv.y * height) * zoom;
          path.rect(x + 0.5, y + 0.5, Math.max(1, w - 1), Math.max(1, h - 1));
        }
        ctx.stroke(path);
      }
      // Активна рамка поверх — окремо, жовтим.
      if (activeCp != null) {
        const g = glyphs.find((x) => x.index === activeCp);
        if (g) {
          const x = g.uv.x * width * zoom;
          const w = g.uv.width * width * zoom;
          const h = Math.abs(g.uv.height) * height * zoom;
          const y = (height - g.uv.y * height) * zoom;
          ctx.strokeStyle = "#f0b429";
          ctx.lineWidth = 2;
          ctx.strokeRect(x + 0.5, y + 0.5, Math.max(1, w - 1), Math.max(1, h - 1));
        }
      }
    });
    return () => {
      if (rafRef.current != null) { cancelAnimationFrame(rafRef.current); rafRef.current = null; }
    };
  }, [width, height, glyphs, zoom, activeCp]);

  function onClick(e: React.MouseEvent<HTMLCanvasElement>) {
    const c = overlayCanvasRef.current;
    if (!c) return;
    const rect = c.getBoundingClientRect();
    const px = (e.clientX - rect.left) / zoom;
    const py = (e.clientY - rect.top) / zoom;
    let bestCp: number | null = null;
    let bestArea = Infinity;
    for (const g of glyphs) {
      const ux = g.uv.x * width;
      const uw = g.uv.width * width;
      const uh = Math.abs(g.uv.height) * height;
      const uy = height - g.uv.y * height;
      if (px >= ux && px <= ux + uw && py >= uy && py <= uy + uh) {
        const a = uw * uh;
        if (a < bestArea) { bestArea = a; bestCp = g.index; }
      }
    }
    if (bestCp != null) onPickGlyph(bestCp);
  }

  // Mouse wheel zoom (Ctrl чи без — будь-який scroll масштабує).
  function onWheel(e: React.WheelEvent<HTMLDivElement>) {
    if (!onZoom) return;
    e.preventDefault();
    const wrap = wrapRef.current;
    if (!wrap) return;
    const rect = wrap.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
    onZoom(factor, mx, my);
  }

  if (!base64) {
    return <div className="p-6 text-center text-[12px] text-[var(--text-faint)]">атлас не завантажено</div>;
  }
  return (
    <div
      ref={wrapRef}
      onWheel={onWheel}
      style={{ position: "relative", width: Math.round(width * zoom), height: Math.round(height * zoom) }}
    >
      <canvas ref={imgCanvasRef} style={{ position: "absolute", left: 0, top: 0 }} />
      <canvas
        ref={overlayCanvasRef}
        onClick={onClick}
        className="cursor-crosshair"
        style={{ position: "absolute", left: 0, top: 0 }}
      />
    </div>
  );
}

interface GlyphInspectorProps {
  glyph: FontGlyph;
  atlasW: number;
  atlasH: number;
  onChange: (patch: Partial<FontGlyph>) => void;
  onCopyFromCyrPair: () => void;
}
function GlyphInspector({ glyph, atlasW, atlasH, onChange, onCopyFromCyrPair }: GlyphInspectorProps) {
  const t = useT();
  const px = (v: number, max: number) => `${(v * max).toFixed(1)} px`;
  const ch = String.fromCodePoint(glyph.index);
  const isCyrPair = isCyrCp(glyph.index);
  return (
    <div className="flex-1 min-h-0 overflow-auto p-4 space-y-3">
      <div className="border border-[var(--border-soft)] rounded-md p-3 bg-[var(--bg)]">
        <p className="text-[10.5px] uppercase tracking-wider text-[var(--text-faint)]">{t("tglFonts.insp.title")}</p>
        <p className="text-[28px] font-bold text-[var(--text-strong)] leading-none mt-1 mb-1">{ch}</p>
        <p className="text-[11px] font-mono text-[var(--text-faint)]">
          index={glyph.index} · U+{glyph.index.toString(16).toUpperCase().padStart(4, "0")}
        </p>
      </div>

      <NumberRow
        label={t("tglFonts.insp.advance")}
        hint={t("tglFonts.insp.advance.hint")}
        value={glyph.advance} step={1} min={0} max={200}
        onChange={(v) => onChange({ advance: v })} suffix="px"
      />

      <fieldset className="border border-[var(--border-soft)] rounded-md p-3 space-y-2">
        <legend className="text-[11px] font-semibold text-[var(--text-muted)] px-1">
          {t("tglFonts.insp.vert")} <span className="text-[var(--text-faint)] font-normal">— {t("tglFonts.insp.vert.hint")}</span>
        </legend>
        <NumberRow label={t("tglFonts.insp.vx")} hint={t("tglFonts.insp.vx.hint")}
          value={glyph.vert.x} step={1} onChange={(v) => onChange({ vert: { ...glyph.vert, x: v } })} suffix="px" />
        <NumberRow label={t("tglFonts.insp.vy")} hint={t("tglFonts.insp.vy.hint")}
          value={glyph.vert.y} step={1} onChange={(v) => onChange({ vert: { ...glyph.vert, y: v } })} suffix="px" />
        <NumberRow label={t("tglFonts.insp.vw")} hint={t("tglFonts.insp.vw.hint")}
          value={glyph.vert.width} step={1} onChange={(v) => onChange({ vert: { ...glyph.vert, width: v } })} suffix="px" />
        <NumberRow label={t("tglFonts.insp.vh")} hint={t("tglFonts.insp.vh.hint")}
          value={glyph.vert.height} step={1} onChange={(v) => onChange({ vert: { ...glyph.vert, height: v } })} suffix="px" />
      </fieldset>

      <fieldset className="border border-[var(--border-soft)] rounded-md p-3 space-y-2">
        <legend className="text-[11px] font-semibold text-[var(--text-muted)] px-1">
          {t("tglFonts.insp.uv")} <span className="text-[var(--text-faint)] font-normal">— {t("tglFonts.insp.uv.hint")}</span>
        </legend>
        <NumberRow label={t("tglFonts.insp.ux")} hint={t("tglFonts.insp.ux.hint")}
          value={glyph.uv.x} step={1 / atlasW} display={px(glyph.uv.x, atlasW)}
          onChange={(v) => onChange({ uv: { ...glyph.uv, x: v } })} />
        <NumberRow label={t("tglFonts.insp.uy")} hint={t("tglFonts.insp.uy.hint")}
          value={glyph.uv.y} step={1 / atlasH} display={px(glyph.uv.y, atlasH)}
          onChange={(v) => onChange({ uv: { ...glyph.uv, y: v } })} />
        <NumberRow label={t("tglFonts.insp.uw")} hint={t("tglFonts.insp.uw.hint")}
          value={glyph.uv.width} step={1 / atlasW} display={px(glyph.uv.width, atlasW)}
          onChange={(v) => onChange({ uv: { ...glyph.uv, width: v } })} />
        <NumberRow label={t("tglFonts.insp.uh")} hint={t("tglFonts.insp.uh.hint")}
          value={glyph.uv.height} step={1 / atlasH} display={px(glyph.uv.height, atlasH)}
          onChange={(v) => onChange({ uv: { ...glyph.uv, height: v } })} />
      </fieldset>

      <label className="flex items-start gap-2 text-[12px] text-[var(--text-muted)] border border-[var(--border-soft)] rounded-md p-3">
        <input type="checkbox" checked={!!glyph.flipped} onChange={(e) => onChange({ flipped: e.target.checked })} className="mt-0.5" />
        <span>
          <span className="text-[var(--text)]">{t("tglFonts.insp.flipped")}</span>
          <span className="block text-[10.5px] text-[var(--text-faint)] mt-0.5">{t("tglFonts.insp.flipped.hint")}</span>
        </span>
      </label>

      {isCyrPair && (
        <button onClick={onCopyFromCyrPair} className="dp-btn w-full">
          {t("tglFonts.insp.copyFromLatin")}
        </button>
      )}
    </div>
  );
}

function NumberRow({
  label, hint, value, step = 1, min, max, display, suffix, onChange,
}: {
  label: string;
  hint?: string;
  value: number;
  step?: number;
  min?: number;
  max?: number;
  display?: string;
  suffix?: string;
  onChange: (v: number) => void;
}) {
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-2">
        <label className="w-[120px] text-[11px] text-[var(--text-muted)]" title={hint}>{label}</label>
        <input
          type="number"
          value={value}
          step={step}
          min={min}
          max={max}
          onChange={(e) => {
            const v = parseFloat(e.target.value);
            if (!Number.isNaN(v)) onChange(v);
          }}
          className="dp-input flex-1 tabular-nums"
        />
        {(display || suffix) && (
          <span className="text-[10.5px] text-[var(--text-faint)] tabular-nums whitespace-nowrap">{display ?? suffix}</span>
        )}
      </div>
      {hint && <p className="text-[10px] text-[var(--text-faint)] leading-tight pl-[124px] -mt-0.5">{hint}</p>}
    </div>
  );
}

interface GamePreviewProps { parsedRev: number; text: string }
function GamePreview({ parsedRev, text }: GamePreviewProps) {
  // Малюємо текст так, як це робить Unity bitmap-font: для кожного codepoint
  // знаходимо glyph; копіюємо фрагмент атласу за uv → ставимо за курсором з
  // зсувом vert.x/vert.y; пересуваємо курсор на advance.
  const parsed = useTglFontsStore((s) => s.parsed);
  const atlasBase64 = useTglFontsStore((s) => s.atlasBase64);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const [imgReady, setImgReady] = useState(false);

  useEffect(() => {
    if (!atlasBase64) { setImgReady(false); return; }
    const img = new Image();
    img.onload = () => {
      imgRef.current = img;
      setImgReady(true);
      useTglFontsStore.getState().setAtlasSize(img.naturalWidth, img.naturalHeight);
    };
    img.src = `data:image/png;base64,${atlasBase64}`;
  }, [atlasBase64]);

  // Підписуємось на актуальний розмір атласу зі store.
  const atlasW = useTglFontsStore((s) => s.atlasW);
  const atlasH = useTglFontsStore((s) => s.atlasH);

  useEffect(() => {
    const c = canvasRef.current;
    if (!c || !parsed) return;
    const w = 720;
    const lineH = (parsed.data.m_LineSpacing || 32) + 8;
    const h = Math.max(60, lineH * 2);
    c.width = w * 2;
    c.height = h * 2;
    c.style.width = w + "px";
    c.style.height = h + "px";
    const ctx = c.getContext("2d");
    if (!ctx) return;
    ctx.scale(2, 2);
    ctx.fillStyle = "#1a1a1a";
    ctx.fillRect(0, 0, w, h);
    if (!imgReady || !imgRef.current) return;

    const img = imgRef.current;
    const aw = atlasW || parsed.atlasWidth;
    const ah = atlasH || parsed.atlasHeight;
    const baseline = h - 14;
    let cursor = 8;
    ctx.imageSmoothingEnabled = false;
    for (const ch of [...text]) {
      const cp = ch.codePointAt(0)!;
      if (ch === " ") { cursor += 9; continue; }
      const g = parsed.glyphsByIndex.get(cp);
      if (!g) {
        // tofu (квадрат) для відсутнього
        ctx.strokeStyle = "#e25";
        ctx.strokeRect(cursor + 1, baseline - 16, 14, 16);
        cursor += 16;
        continue;
      }
      // ChiaroStd convention (порт логіки python-референс-скрипта):
      //   sx = uv.x * W;  sy = H - uv.y * H
      //   sw = |uv.width| * W;  sh = |uv.height| * H
      //   flipped:false → vertical flip (ImageOps.flip);
      //   flipped:true  → rotate 90° CCW (PIL Image.rotate(90, expand=True)).
      // Pipeline: crop → orient у temp canvas → drawImage на головний.
      const sx = g.uv.x * aw;
      const sw = Math.abs(g.uv.width) * aw;
      const sh = Math.abs(g.uv.height) * ah;
      const sy = ah - g.uv.y * ah;
      const dx = cursor + (g.vert.x ?? 0);
      const dy = baseline - (g.vert.y ?? 0);
      const dw = Math.abs(g.vert.width ?? sw);
      const dh = Math.abs(g.vert.height ?? sh);
      if (sw > 0 && sh > 0 && dw > 0 && dh > 0) {
        try {
          // 1) Сирий crop у temp canvas.
          const swR = Math.max(1, Math.round(sw));
          const shR = Math.max(1, Math.round(sh));
          const tmp = document.createElement("canvas");
          tmp.width = swR; tmp.height = shR;
          const tctx = tmp.getContext("2d")!;
          tctx.drawImage(img, sx, sy, sw, sh, 0, 0, swR, shR);

          // 2) Orient: для flipped — CCW 90° (нова canvas з swapped W/H);
          //    для not-flipped — vertical flip in-place.
          const orient = document.createElement("canvas");
          const octx = orient.getContext("2d")!;
          if (g.flipped) {
            orient.width = shR; orient.height = swR;
            octx.translate(0, swR);
            octx.rotate(-Math.PI / 2);
            octx.drawImage(tmp, 0, 0);
          } else {
            orient.width = swR; orient.height = shR;
            octx.translate(0, shR);
            octx.scale(1, -1);
            octx.drawImage(tmp, 0, 0);
          }

          // 3) Малюємо oriented bitmap на основний canvas з розміром dw×dh.
          ctx.drawImage(orient, 0, 0, orient.width, orient.height, dx, dy, dw, dh);
        } catch {}
      }
      cursor += g.advance;
    }
    // baseline guide
    ctx.strokeStyle = "rgba(255,255,255,0.08)";
    ctx.beginPath();
    ctx.moveTo(0, baseline);
    ctx.lineTo(w, baseline);
    ctx.stroke();
  }, [parsedRev, text, imgReady, parsed, atlasW, atlasH]);

  return (
    <div>
      <p className="text-[10px] uppercase tracking-wider text-[var(--text-faint)] mb-1">
        Game preview
      </p>
      <canvas ref={canvasRef} className="block rounded border border-[var(--border)] bg-black" />
    </div>
  );
}

interface AddGlyphModalProps {
  onClose: () => void;
  defaultTarget?: number;
}
function AddGlyphModal({ onClose, defaultTarget }: AddGlyphModalProps) {
  const t = useT();
  const addGlyphFromBitmap = useTglFontsStore((s) => s.addGlyphFromBitmap);
  const parsed = useTglFontsStore((s) => s.parsed);
  const loadedFont = useTglFontsStore((s) => s.loadedFont);
  const setLoadedFont = useTglFontsStore((s) => s.setLoadedFont);
  const [target, setTarget] = useState(defaultTarget ? String.fromCodePoint(defaultTarget) : "Є");
  const [refSource, setRefSource] = useState("E"); // звідки беремо baseline vy
  const [fontFamily, setFontFamily] = useState<string | null>(loadedFont?.family ?? null);
  const [fontFilename, setFontFilename] = useState<string | null>(loadedFont?.filename ?? null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [bitmap, setBitmap] = useState<HTMLCanvasElement | null>(null);
  const [metrics, setMetrics] = useState<{ advance: number; bearingLeft: number; ascent: number; descent: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [busyMsg, setBusyMsg] = useState<string>("");
  const [error, setError] = useState<string | null>(null);

  // Парсимо input target як список через кому: "Є, і, Ї, Ґ" → ["Є","і","Ї","Ґ"]
  // Перший — для prev'ю / metrics індикації; решта обробляється у Batch.
  const targets = target
    .split(/[,;]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((s) => [...s][0]); // перший codepoint кожного токена
  const firstTarget = targets[0] ?? "";
  const targetCp = firstTarget.codePointAt(0) ?? 0;
  const refCp = refSource.codePointAt(0) ?? 0;
  const ref = parsed?.glyphsByIndex.get(refCp);
  const targetFontSize = parsed?.data.m_FontSize ?? 30;

  async function pickFont(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (!f) return;
    try {
      const bytes = await f.arrayBuffer();
      const family = `__tglUser_${Date.now()}`;
      const face = new FontFace(family, bytes);
      await face.load();
      (document.fonts as any).add(face);
      setFontFamily(family);
      setFontFilename(f.name);
      setLoadedFont({ family, filename: f.name }); // запам'ятовуємо у store
      renderPreview(family, firstTarget);
    } catch (err: any) {
      setError(String(err?.message ?? err));
    }
  }

  /** Renderить один char у tight bitmap + повертає metrics. Без setState — суто pure. */
  function renderChar(family: string, ch: string): { bmp: HTMLCanvasElement; metrics: { advance: number; bearingLeft: number; ascent: number; descent: number } } | null {
    if (!ch || !ref) return null;
    const refW = Math.abs(ref.vert.width);
    const refH = Math.abs(ref.vert.height);
    const work = document.createElement("canvas");
    const padding = 4;
    work.width = Math.max(64, refW * 2);
    work.height = Math.max(64, refH * 2);
    const ctx = work.getContext("2d")!;
    ctx.clearRect(0, 0, work.width, work.height);
    ctx.fillStyle = "#000";
    ctx.textBaseline = "alphabetic";
    ctx.font = `${targetFontSize}px "${family}"`;
    const m = ctx.measureText(ch);
    const mtr = {
      advance: m.width,
      bearingLeft: m.actualBoundingBoxLeft ?? 0,
      ascent: m.actualBoundingBoxAscent ?? targetFontSize * 0.8,
      descent: m.actualBoundingBoxDescent ?? targetFontSize * 0.2,
    };
    const baselineY = Math.round(targetFontSize * 0.85) + padding;
    ctx.fillText(ch, padding, baselineY);
    const data = ctx.getImageData(0, 0, work.width, work.height);
    let minX = work.width, minY = work.height, maxX = -1, maxY = -1;
    for (let y = 0; y < work.height; y++) {
      for (let x = 0; x < work.width; x++) {
        if (data.data[(y * work.width + x) * 4 + 3] > 5) {
          if (x < minX) minX = x;
          if (y < minY) minY = y;
          if (x > maxX) maxX = x;
          if (y > maxY) maxY = y;
        }
      }
    }
    if (maxX < 0) return null;
    const cw = maxX - minX + 1;
    const cy = maxY - minY + 1;
    const out = document.createElement("canvas");
    out.width = cw; out.height = cy;
    out.getContext("2d")!.drawImage(work, minX, minY, cw, cy, 0, 0, cw, cy);
    return { bmp: out, metrics: mtr };
  }

  function renderPreview(family: string, ch: string = firstTarget) {
    if (!ch) return;
    const r = renderChar(family, ch);
    if (!r) { setError(t("tglFonts.err.emptyGlyph")); return; }
    setBitmap(r.bmp);
    setMetrics(r.metrics);
    setPreviewUrl(r.bmp.toDataURL("image/png"));
    setError(null);
  }

  useEffect(() => {
    if (fontFamily) renderPreview(fontFamily, firstTarget);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target, refSource, fontFamily]);

  async function handleAdd() {
    if (!fontFamily || !ref || targets.length === 0) return;
    setBusy(true);
    const added: string[] = [];
    const skipped: Array<{ ch: string; reason: string }> = [];
    try {
      for (let i = 0; i < targets.length; i++) {
        const ch = targets[i];
        const cp = ch.codePointAt(0);
        if (!cp) { skipped.push({ ch, reason: t("tglFonts.err.emptyChar") }); continue; }
        setBusyMsg(t("tglFonts.addGlyph.progress", { i: i + 1, n: targets.length, ch }));
        const r = renderChar(fontFamily, ch);
        if (!r) { skipped.push({ ch, reason: t("tglFonts.err.notInFont") }); continue; }
        const vert = {
          x: Math.round(-r.metrics.bearingLeft),
          y: Math.round(r.metrics.ascent),
          width: r.bmp.width,
          height: -r.bmp.height,
        };
        const advance = Math.max(8, Math.round(r.metrics.advance));
        const res = await addGlyphFromBitmap({ targetCp: cp, bitmap: r.bmp, vert, advance });
        if (res.ok) added.push(ch);
        else skipped.push({ ch, reason: res.reason ?? "?" });
      }
      const skippedTxt = skipped.length
        ? "\n\n" + t("tglFonts.addGlyph.skipped") + "\n" +
          skipped.map((s) => `  ${s.ch}: ${s.reason}`).join("\n")
        : "";
      await showAlert(
        t("tglFonts.addGlyph.doneTitle"),
        t("tglFonts.addGlyph.batchDone", { added: added.length, total: targets.length, chars: added.join(" ") }) + skippedTxt,
        { tone: added.length > 0 ? "success" : "danger" }
      );
      if (added.length > 0) onClose();
    } finally {
      setBusy(false);
      setBusyMsg("");
    }
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4" onClick={onClose}>
      <div className="dp-card w-[560px] p-5" onClick={(e) => e.stopPropagation()}>
        <h2 className="text-[15px] font-bold text-[var(--text-strong)] mb-1">{t("tglFonts.addGlyph.title")}</h2>
        <p className="text-[12px] text-[var(--text-muted)] mb-4 leading-relaxed">
          {t("tglFonts.addGlyph.hintTtf")}
        </p>

        <div className="space-y-3 mb-4">
          <div className="flex items-start gap-3">
            <label className="w-32 text-[11px] uppercase tracking-wider text-[var(--text-faint)] pt-1.5">
              {t("tglFonts.addGlyph.target")}
            </label>
            <div className="flex-1">
              <input
                value={target}
                onChange={(e) => setTarget(e.target.value)}
                className="dp-input w-full text-[16px]"
                placeholder={t("tglFonts.addGlyph.placeholderEx")}
              />
              <p className="text-[10.5px] text-[var(--text-faint)] mt-1">
                {targets.length > 1
                  ? t("tglFonts.addGlyph.batchHint", { n: targets.length, list: targets.join(" ") })
                  : t("tglFonts.addGlyph.singleHint", { code: "U+" + targetCp.toString(16).toUpperCase().padStart(4, "0") })}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <label className="w-32 text-[11px] uppercase tracking-wider text-[var(--text-faint)]">
              {t("tglFonts.addGlyph.refSource")}
            </label>
            <input value={refSource} maxLength={2} onChange={(e) => setRefSource(e.target.value)} className="dp-input w-20 text-center text-[20px]" />
            <span className="text-[10.5px] text-[var(--text-faint)] truncate" title={t("tglFonts.addGlyph.refSource.hint")}>
              {t("tglFonts.addGlyph.refSource.hint")}
            </span>
          </div>
          <div className="flex items-start gap-3">
            <label className="w-32 text-[11px] uppercase tracking-wider text-[var(--text-faint)] pt-1.5">
              {t("tglFonts.addGlyph.fontFile")}
            </label>
            <div className="flex-1">
              <input type="file" accept=".ttf,.otf,.woff,.woff2" onChange={pickFont} className="text-[11px]" />
              {fontFilename && (
                <p className="text-[10.5px] text-[var(--success)] mt-1 truncate">
                  {t("tglFonts.addGlyph.lastFont", { file: fontFilename })}
                </p>
              )}
            </div>
          </div>
          {ref && (
            <p className="text-[10.5px] text-[var(--text-faint)] pl-32">
              {t("tglFonts.addGlyph.refMetrics", { vw: Math.abs(ref.vert.width), vh: Math.abs(ref.vert.height), adv: ref.advance, fs: targetFontSize })}
            </p>
          )}
          {previewUrl && (
            <div className="flex items-center gap-3 pl-32">
              <span className="text-[11px] text-[var(--text-faint)]">{t("tglFonts.addGlyph.preview")}:</span>
              <img src={previewUrl} alt="preview" style={{ background: "#222", padding: 4 }} />
            </div>
          )}
          {metrics && (
            <p className="text-[10.5px] text-[var(--success)] pl-32">
              {t("tglFonts.addGlyph.ttfMetrics", {
                adv: metrics.advance.toFixed(1),
                bl: metrics.bearingLeft.toFixed(1),
                asc: metrics.ascent.toFixed(1),
                desc: metrics.descent.toFixed(1),
              })}
            </p>
          )}
          {error && <p className="text-[11px] text-[var(--danger)] pl-32">{error}</p>}
        </div>

        <div className="flex gap-2 justify-end">
          <button className="dp-btn" onClick={onClose} disabled={busy}>{t("btn.cancel")}</button>
          <button
            className="dp-btn dp-btn--primary"
            disabled={!bitmap || !ref || busy}
            onClick={handleAdd}
            title={busy ? busyMsg : undefined}
          >
            {busy ? (busyMsg || t("tglFonts.addGlyph.adding")) : t("tglFonts.addGlyph.add")}
          </button>
        </div>
      </div>
    </div>
  );
}
