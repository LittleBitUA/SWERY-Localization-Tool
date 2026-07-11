// D4 — редактор одного JSON-файлу (msg_en_*.json).
// Показує всі Ms01DataMessage записи + три перекладні масиви: m_aString,
// m_aWord, m_aVoiceIdStr. Користувач редагує текст inline; ми зберігаємо
// весь масив назад у JSON (одним записом). Original-значення відображаються
// як placeholder/diff поряд.

import { useCallback, useEffect, useMemo, useState } from "react";
import { useT, t as tStatic } from "../../lib/i18n";
import { D4Hero } from "./D4Hero";
import { D4FindReplaceModal } from "./D4FindReplaceModal";
import { D4DiffModal } from "./D4DiffModal";
import { D4TmPanel } from "./D4Modals";
import { D4MonacoEditModal } from "./D4MonacoEditModal";

interface FileItem {
  name: string;
  origPath: string;
  donePath: string;
}

interface Msg {
  objectName: string;
  fileName?: string | null;
  m_aString: string[];
  m_aWord: string[];
  m_aVoiceIdStr: string[];
}

interface Props {
  file: FileItem;
  onClose: () => void;
}

type FieldKey = "m_aString" | "m_aWord" | "m_aVoiceIdStr";

// «Перекладено» — рядок Done відрізняється від відповідного у Original.
// НЕ за кирилицею: у грі є власні гліфи (типу САFЙ SWERY65), які не значать,
// що це переклад.
function isTranslated(value: string, original: string): boolean {
  return typeof value === "string"
    && value.trim() !== ""
    && value !== (original ?? "");
}

// Лічильник символів і слів. Для warning'у про надмірну довжину перекладу
// (UI у грі може обрізати).
function countChars(s: string): number {
  return [...(s ?? "")].length;  // Unicode-aware (емодзі/коди як 1 символ).
}
function countWords(s: string): number {
  return (s ?? "").trim().split(/\s+/).filter(Boolean).length;
}

// Лінт розмітки: знаходить «технічні» вкраплення (HTML-теги, [bracket],
// {var}, %s/%d, \n/\r). Якщо набір у перекладі ≠ набору в оригіналі —
// загубили (або додали зайве) спецсимвол, який гра очікує.
const MARKER_RE = /<\/?[^>]+>|\[[^\]]+\]|\{[^}]+\}|%[sdif]|\\n|\\r|\\t/g;
function extractMarkers(s: string): string[] {
  return (s ?? "").match(MARKER_RE) ?? [];
}
function markerDiff(orig: string, value: string): { missing: string[]; extra: string[] } {
  const o = extractMarkers(orig).sort();
  const v = extractMarkers(value).sort();
  const oMap = new Map<string, number>();
  for (const m of o) oMap.set(m, (oMap.get(m) ?? 0) + 1);
  const vMap = new Map<string, number>();
  for (const m of v) vMap.set(m, (vMap.get(m) ?? 0) + 1);
  const missing: string[] = [];
  const extra: string[] = [];
  for (const [k, n] of oMap) { const d = n - (vMap.get(k) ?? 0); for (let i = 0; i < d; i++) missing.push(k); }
  for (const [k, n] of vMap) { const d = n - (oMap.get(k) ?? 0); for (let i = 0; i < d; i++) extra.push(k); }
  return { missing, extra };
}

export function D4TextItemEditor({ file, onClose }: Props) {
  const t = useT();
  const [original, setOriginal] = useState<Msg[]>([]);
  const [done, setDone] = useState<Msg[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeIdx, setActiveIdx] = useState(0);
  const [search, setSearch] = useState("");
  const [showUntranslatedOnly, setShowUntranslatedOnly] = useState(false);
  const [findOpen, setFindOpen] = useState(false);
  const [diffOpen, setDiffOpen] = useState(false);
  const [autosaveAt, setAutosaveAt] = useState<number | null>(null);
  // #9 Per-entry meta + #7 TM
  const [meta, setMeta] = useState<Record<string, { status?: string; bookmark?: boolean; note?: string }>>({});
  const [tmPairs, setTmPairs] = useState<Array<{ en: string; ua: string }>>([]);

  const autosaveKey = `d4.autosave.${file.donePath}`;

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [orig, dn] = await Promise.all([
        window.dp2.d4TextRead(file.origPath),
        window.dp2.d4TextRead(file.donePath),
      ]);
      if (!orig.ok) throw new Error(orig.error);
      if (!dn.ok) throw new Error(dn.error);
      const o: Msg[] = JSON.parse(orig.content ?? "[]");
      const d: Msg[] = JSON.parse(dn.content ?? "[]");
      setOriginal(o);
      setDone(d);
      setDirty(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [file]);

  useEffect(() => { load(); }, [load]);

  // #9 Meta load + #7 TM build при відкритті файлу.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const r = await window.dp2.d4MetaRead(file.donePath);
      if (!cancelled && r.ok) setMeta(r.perFile ?? {});
    })();
    (async () => {
      const r = await window.dp2.d4TmBuild();
      if (!cancelled && r.ok) setTmPairs(r.pairs ?? []);
    })();
    return () => { cancelled = true; };
  }, [file.donePath]);

  // Зберегти meta (debounce).
  useEffect(() => {
    if (loading) return;
    const handle = setTimeout(() => {
      window.dp2.d4MetaWrite({ donePath: file.donePath, perFile: meta }).catch(() => {});
    }, 600);
    return () => clearTimeout(handle);
  }, [meta, loading, file.donePath]);

  const setEntryStatus = (objectName: string, status: "draft" | "review" | "approved" | undefined) => {
    setMeta((prev) => {
      const next = { ...prev };
      const cur = { ...(next[objectName] ?? {}) };
      if (status) cur.status = status;
      else delete cur.status;
      next[objectName] = cur;
      return next;
    });
  };
  const toggleBookmark = (objectName: string) => {
    setMeta((prev) => {
      const next = { ...prev };
      const cur = { ...(next[objectName] ?? {}) };
      cur.bookmark = !cur.bookmark;
      next[objectName] = cur;
      return next;
    });
  };

  // Autosave у localStorage кожні 1.2с після останньої правки. Якщо при
  // наступному відкритті у LS є новіша версія за on-disk — відновлюємо.
  useEffect(() => {
    if (!dirty) return;
    const handle = setTimeout(() => {
      try {
        localStorage.setItem(autosaveKey, JSON.stringify({ at: Date.now(), done }));
        setAutosaveAt(Date.now());
      } catch {}
    }, 1200);
    return () => clearTimeout(handle);
  }, [done, dirty, autosaveKey]);

  // На завантаженні: якщо в LS є чернетка, питаємо чи відновити.
  useEffect(() => {
    if (loading) return;
    try {
      const raw = localStorage.getItem(autosaveKey);
      if (!raw) return;
      const obj = JSON.parse(raw);
      if (!obj?.done || !Array.isArray(obj.done)) return;
      const sameLen = obj.done.length === done.length;
      if (!sameLen) return;
      const differs = JSON.stringify(obj.done) !== JSON.stringify(done);
      if (!differs) { localStorage.removeItem(autosaveKey); return; }
      if (confirm("Знайдено незбережений чернетковий переклад. Відновити?")) {
        setDone(obj.done);
        setDirty(true);
      } else {
        localStorage.removeItem(autosaveKey);
      }
    } catch {}
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading]);

  // Original by objectName для швидкого порівняння (стани картки/фільтру).
  const origByName = useMemo(() => {
    const map = new Map<string, Msg>();
    for (const m of original) if (m?.objectName) map.set(m.objectName, m);
    return map;
  }, [original]);

  // Аґрегуємо рядки для прогресу + фільтра.
  const stats = useMemo(() => {
    let total = 0, translated = 0;
    for (const m of done) {
      const arr = m.m_aString ?? [];
      const origArr = origByName.get(m.objectName)?.m_aString ?? [];
      total += arr.length;
      for (let i = 0; i < arr.length; i++) {
        if (isTranslated(arr[i], origArr[i] ?? "")) translated++;
      }
    }
    const pct = total > 0 ? Math.round((translated / total) * 100) : 0;
    return { total, translated, pct };
  }, [done, origByName]);

  // Пер-запис {tr,total} — рахуємо ОДИН раз (не на кожен рендер сайдбар-рядка).
  // Раніше кожен видимий рядок перераховував це на кожне натискання у пошуку
  // → O(видимих × рядків) за клавішу. Тепер перерахунок лише коли done змінився.
  const perEntryCounts = useMemo(() => {
    const out: Array<{ tr: number; total: number }> = [];
    for (const m of done) {
      const arr = m.m_aString ?? [];
      const origArr = origByName.get(m.objectName)?.m_aString ?? [];
      let tr = 0;
      for (let i = 0; i < arr.length; i++) if (isTranslated(arr[i], origArr[i] ?? "")) tr++;
      out.push({ tr, total: arr.length });
    }
    return out;
  }, [done, origByName]);

  // Список Ms01DataMessage для лівої колонки (фільтр).
  const filteredIdxs = useMemo(() => {
    const lower = search.trim().toLowerCase();
    const result: number[] = [];
    for (let i = 0; i < done.length; i++) {
      const m = done[i];
      if (showUntranslatedOnly) {
        const origArr = origByName.get(m.objectName)?.m_aString ?? [];
        const arr = m.m_aString ?? [];
        const allTranslated = arr.every((s, idx) => !s || isTranslated(s, origArr[idx] ?? ""));
        if (allTranslated) continue;
      }
      if (lower) {
        const hay = (m.objectName + " " + (m.fileName ?? "") + " " + (m.m_aString ?? []).join(" ")).toLowerCase();
        if (!hay.includes(lower)) continue;
      }
      result.push(i);
    }
    return result;
  }, [done, search, showUntranslatedOnly, origByName]);

  const activeMsg = done[activeIdx];
  const origMsg = original[activeIdx];

  const updateField = (field: FieldKey, i: number, value: string) => {
    setDone((prev) => {
      const next = [...prev];
      const m = { ...next[activeIdx] };
      const arr = [...(m[field] ?? [])];
      arr[i] = value;
      m[field] = arr;
      next[activeIdx] = m;
      return next;
    });
    setDirty(true);
  };

  // F8 — jump to next untranslated entry. Перебираємо done з activeIdx+1
  // циклічно, шукаємо запис де ХОЧА Б ОДИН m_aString не відрізняється від
  // Original (== не перекладено).
  const jumpNextUntranslated = useCallback(() => {
    if (done.length === 0) return;
    for (let off = 1; off <= done.length; off++) {
      const i = (activeIdx + off) % done.length;
      const m = done[i];
      const origArr = origByName.get(m.objectName)?.m_aString ?? [];
      const arr = m.m_aString ?? [];
      const hasUntr = arr.some((v, k) => !isTranslated(v, origArr[k] ?? ""));
      if (hasUntr) { setActiveIdx(i); return; }
    }
  }, [done, activeIdx, origByName]);

  // Глобальні шорткати — capture-фаза + e.code (а не e.key), щоб працювало
  // на будь-якій розкладці (укр/рос дають кирилицю в e.key, але KeyH/KeyF
  // у e.code — стабільне).
  //   Ctrl+H, Ctrl+F — Find/Replace
  //   F8 — jump next untranslated
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const ctrl = e.ctrlKey || e.metaKey;
      // Якщо фокус усередині Monaco (popup-редактор відкрито) — не перехоплюємо
      // Ctrl+F/Ctrl+H, хай спрацює власний find/replace-віджет Monaco.
      const inMonaco = e.target instanceof Element && e.target.closest(".monaco-editor");
      if (ctrl && !e.shiftKey && !inMonaco && (e.code === "KeyH" || e.code === "KeyF")) {
        e.preventDefault();
        e.stopPropagation();
        setFindOpen(true);
        return;
      }
      if (e.code === "F8" || e.key === "F8") {
        e.preventDefault();
        e.stopPropagation();
        jumpNextUntranslated();
        return;
      }
    };
    window.addEventListener("keydown", onKey, true);  // capture phase
    return () => window.removeEventListener("keydown", onKey, true);
  }, [jumpNextUntranslated]);

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const content = JSON.stringify(done, null, 2);
      const r = await window.dp2.d4TextWrite({ fullPath: file.donePath, content });
      if (!r.ok) throw new Error(r.error);
      setDirty(false);
      try { localStorage.removeItem(autosaveKey); } catch {}
      setAutosaveAt(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center relative" style={{ background: "#0d0204" }}>
        <D4Hero />
        <div className="relative z-10 text-center" style={{ color: "rgba(245,230,230,0.7)" }}>
          <div className="text-[11px] tracking-[0.3em] uppercase mb-2" style={{ color: "#dc2626" }}>{t("d4.item.loading")}</div>
          <p className="text-[13px]">{file.name}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col min-h-0 relative overflow-hidden" style={{ background: "#0d0204" }}>
      <D4Hero />

      <header
        className="h-12 px-4 flex items-center gap-3 shrink-0 relative"
        style={{
          background: "rgba(13, 2, 4, 0.85)",
          backdropFilter: "blur(8px)",
          borderBottom: "1px solid rgba(220, 38, 38, 0.3)",
          zIndex: 2,
        }}
      >
        <button
          onClick={() => {
            if (dirty && !confirm(t("d4.item.confirmClose"))) return;
            onClose();
          }}
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
          {t("btn.back")}
        </button>
        <span className="text-[10px] tracking-[0.3em] uppercase font-semibold" style={{ color: "#dc2626" }}>
          {t("d4.item.dossier")}
        </span>
        <span className="font-mono text-[12px]" style={{ color: "rgba(245,230,230,0.85)" }}>
          {file.name}
        </span>
        <span className="text-[11px] font-mono tabular-nums" style={{ color: "rgba(245,230,230,0.55)" }}>
          {t("d4.item.headSummary", { msgs: done.length, tr: stats.translated, total: stats.total, pct: stats.pct })}
        </span>
        <div className="flex-1" />
        <HeaderLabelBtn
          onClick={() => setFindOpen(true)}
          title={t("d4.find.title")}
          shortcut="Ctrl+H"
          icon={
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="m21 21-5.197-5.197m0 0A7.5 7.5 0 1 0 5.196 5.196a7.5 7.5 0 0 0 10.607 10.607Z" />
            </svg>
          }
        >
          {t("d4.btn.findShort")}
        </HeaderLabelBtn>
        <HeaderLabelBtn
          onClick={jumpNextUntranslated}
          title={t("d4.item.btn.nextUntranslated")}
          shortcut="F8"
          icon={
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M13 5l7 7-7 7M4 5l7 7-7 7" />
            </svg>
          }
        >
          {t("d4.btn.nextShort")}
        </HeaderLabelBtn>
        <HeaderLabelBtn
          onClick={() => setDiffOpen(true)}
          title={t("d4.diff.title")}
          icon={
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 3v18M15 3v18M3 9h18M3 15h18" />
            </svg>
          }
        >
          {t("d4.btn.diffShort")}
        </HeaderLabelBtn>
        {dirty && (
          <span className="text-[10px] tracking-[0.2em] uppercase font-semibold ml-2" style={{ color: "#fbbf24" }}>
            {t("d4.item.dirty")}
          </span>
        )}
        <button
          onClick={save}
          disabled={saving || !dirty}
          className="px-4 py-1.5 text-[11px] font-semibold uppercase tracking-wider rounded-sm transition-all"
          style={{
            background: !dirty ? "rgba(245,230,230,0.05)" : "linear-gradient(135deg, #dc2626 0%, #991b1b 100%)",
            color: !dirty ? "rgba(245,230,230,0.3)" : "#fff",
            border: `1px solid ${!dirty ? "rgba(245,230,230,0.15)" : "#ef4444"}`,
            cursor: !dirty || saving ? "not-allowed" : "pointer",
          }}
        >
          {saving ? t("d4.item.btn.saving") : t("d4.item.btn.save")}
        </button>
      </header>

      {error && (
        <div
          className="px-5 py-2 text-[11px]"
          style={{
            background: "rgba(127, 29, 29, 0.4)",
            color: "#fecaca",
            borderBottom: "1px solid #dc2626",
          }}
        >
          {error}
        </div>
      )}

      <div className="flex-1 flex min-h-0 relative" style={{ zIndex: 1 }}>
        {/* Sidebar: Ms01DataMessage list */}
        <aside
          className="w-[320px] shrink-0 flex flex-col"
          style={{
            background: "rgba(13, 2, 4, 0.85)",
            backdropFilter: "blur(8px)",
            borderRight: "1px solid rgba(220, 38, 38, 0.2)",
          }}
        >
          <div className="p-3 flex flex-col gap-2" style={{ borderBottom: "1px solid rgba(220,38,38,0.15)" }}>
            <input
              type="text"
              placeholder={t("d4.item.search")}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full px-2.5 py-1.5 text-[12px] rounded-sm"
              style={{
                background: "rgba(0,0,0,0.4)",
                border: "1px solid rgba(220,38,38,0.25)",
                color: "#f5e6e6",
              }}
            />
            <label className="flex items-center gap-2 text-[10.5px] tracking-wider uppercase cursor-pointer" style={{ color: "rgba(245,230,230,0.65)" }}>
              <input
                type="checkbox"
                checked={showUntranslatedOnly}
                onChange={(e) => setShowUntranslatedOnly(e.target.checked)}
                style={{ accentColor: "#dc2626" }}
              />
              {t("d4.item.untranslatedOnly")}
            </label>
            <p className="text-[10px] font-mono tabular-nums" style={{ color: "rgba(245,230,230,0.4)" }}>
              {filteredIdxs.length} / {done.length}
            </p>
          </div>
          <div className="flex-1 overflow-y-auto" style={{ scrollbarWidth: "thin" }}>
            {filteredIdxs.map((idx) => {
              const m = done[idx];
              const { tr, total } = perEntryCounts[idx] ?? { tr: 0, total: m.m_aString?.length ?? 0 };
              const isActive = idx === activeIdx;
              const preview = m.m_aString?.[0] ?? m.fileName ?? "";
              const mm = meta[m.objectName] ?? {};
              const statusColor = mm.status === "approved" ? "#22c55e"
                : mm.status === "review" ? "#fbbf24"
                : mm.status === "draft" ? "#94a3b8"
                : "transparent";
              return (
                <button
                  key={idx}
                  onClick={() => setActiveIdx(idx)}
                  className="w-full text-left px-3 py-2 transition-colors relative"
                  style={{
                    background: isActive ? "rgba(220,38,38,0.2)" : "transparent",
                    borderLeft: `2px solid ${isActive ? "#dc2626" : "transparent"}`,
                    borderBottom: "1px solid rgba(220,38,38,0.08)",
                  }}
                >
                  <div className="flex items-center gap-1.5">
                    {mm.status && (
                      <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: statusColor }} title={mm.status} />
                    )}
                    {mm.bookmark && <span className="text-[9px]" style={{ color: "#fbbf24" }}>★</span>}
                    <div className="font-mono text-[10.5px] font-semibold truncate flex-1" style={{ color: "#fff" }}>
                      {m.objectName}
                    </div>
                  </div>
                  {m.fileName && (
                    <div className="text-[9.5px] mt-0.5 truncate" style={{ color: "rgba(245,230,230,0.45)" }}>
                      {m.fileName}
                    </div>
                  )}
                  {preview && (
                    <div className="text-[10.5px] mt-0.5 truncate italic" style={{ color: "rgba(245,230,230,0.55)" }}>
                      "{preview.slice(0, 60)}"
                    </div>
                  )}
                  <div className="text-[9.5px] mt-0.5 font-mono tabular-nums" style={{ color: tr === total && total > 0 ? "#22c55e" : "rgba(245,230,230,0.4)" }}>
                    {t("d4.item.linesCount", { tr, total })}
                  </div>
                </button>
              );
            })}
          </div>
        </aside>

        {/* Main editor */}
        <main className="flex-1 overflow-y-auto p-6" style={{ scrollbarWidth: "thin" }}>
          {!activeMsg ? (
            <p style={{ color: "rgba(245,230,230,0.5)" }}>{t("d4.item.pickRecord")}</p>
          ) : (
            <div className="max-w-[920px] mx-auto space-y-6">
              {/* Header card */}
              <div
                className="rounded-sm p-4"
                style={{
                  background: "rgba(13, 2, 4, 0.65)",
                  backdropFilter: "blur(8px)",
                  border: "1px solid rgba(220,38,38,0.3)",
                }}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="text-[10px] tracking-[0.3em] uppercase font-semibold mb-1" style={{ color: "#dc2626" }}>
                      {t("d4.item.classLabel")}
                    </div>
                    <div className="font-mono text-[15px] font-semibold" style={{ color: "#fff" }}>
                      {activeMsg.objectName}
                    </div>
                    {activeMsg.fileName && (
                      <div className="text-[11px] mt-1" style={{ color: "rgba(245,230,230,0.6)" }}>
                        {t("d4.item.fileName")}<span className="font-mono">{activeMsg.fileName}</span>
                      </div>
                    )}
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    {(["draft", "review", "approved"] as const).map((s) => {
                      const active = meta[activeMsg.objectName]?.status === s;
                      const c = s === "approved" ? "#22c55e" : s === "review" ? "#fbbf24" : "#94a3b8";
                      return (
                        <button
                          key={s}
                          onClick={() => setEntryStatus(activeMsg.objectName, active ? undefined : s)}
                          className="px-2 py-0.5 text-[9.5px] uppercase tracking-wider font-semibold rounded-sm transition-colors"
                          style={{
                            background: active ? `${c}33` : "rgba(0,0,0,0.3)",
                            border: `1px solid ${active ? c : "rgba(245,230,230,0.15)"}`,
                            color: active ? c : "rgba(245,230,230,0.55)",
                          }}
                          title={t(`d4.meta.status.${s}`)}
                        >
                          {t(`d4.meta.status.${s}`)}
                        </button>
                      );
                    })}
                    <button
                      onClick={() => toggleBookmark(activeMsg.objectName)}
                      className="w-6 h-6 flex items-center justify-center rounded-sm"
                      style={{
                        background: meta[activeMsg.objectName]?.bookmark ? "rgba(251,191,36,0.2)" : "rgba(0,0,0,0.3)",
                        border: `1px solid ${meta[activeMsg.objectName]?.bookmark ? "#fbbf24" : "rgba(245,230,230,0.15)"}`,
                        color: meta[activeMsg.objectName]?.bookmark ? "#fbbf24" : "rgba(245,230,230,0.55)",
                      }}
                      title={t("d4.meta.bookmark")}
                    >
                      ★
                    </button>
                  </div>
                </div>
              </div>

              {/* Field sections — key прив'язаний до активного запису, щоб при
                  перемиканні запису локальний monacoIdx скидався (не редагувати
                  чужий запис через відкритий popup). */}
              <FieldSection
                key={`${activeMsg.objectName}:m_aString`}
                label="m_aString"
                description={t("d4.item.field.m_aString")}
                items={activeMsg.m_aString ?? []}
                origItems={origMsg?.m_aString ?? []}
                onChange={(i, v) => updateField("m_aString", i, v)}
                tmPairs={tmPairs}
              />
              {(activeMsg.m_aWord?.length ?? 0) > 0 && (
                <FieldSection
                  key={`${activeMsg.objectName}:m_aWord`}
                  label="m_aWord"
                  description={t("d4.item.field.m_aWord")}
                  items={activeMsg.m_aWord}
                  origItems={origMsg?.m_aWord ?? []}
                  onChange={(i, v) => updateField("m_aWord", i, v)}
                />
              )}
              {(activeMsg.m_aVoiceIdStr?.length ?? 0) > 0 && (
                <FieldSection
                  key={`${activeMsg.objectName}:m_aVoiceIdStr`}
                  label="m_aVoiceIdStr"
                  description={t("d4.item.field.m_aVoiceIdStr")}
                  items={activeMsg.m_aVoiceIdStr}
                  origItems={origMsg?.m_aVoiceIdStr ?? []}
                  onChange={(i, v) => updateField("m_aVoiceIdStr", i, v)}
                />
              )}
            </div>
          )}
        </main>
      </div>

      <D4FindReplaceModal
        open={findOpen}
        done={done}
        activeIdx={activeIdx}
        onApply={(updated) => { setDone(updated); setDirty(true); }}
        onJump={(i) => setActiveIdx(i)}
        onClose={() => setFindOpen(false)}
      />
      <D4DiffModal
        open={diffOpen}
        origStrings={origMsg?.m_aString ?? []}
        doneStrings={activeMsg?.m_aString ?? []}
        onClose={() => setDiffOpen(false)}
      />
    </div>
  );
}

function HeaderLabelBtn({
  onClick, title, shortcut, icon, children,
}: {
  onClick: () => void;
  title: string;
  shortcut?: string;
  icon?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      title={shortcut ? `${title} (${shortcut})` : title}
      className="h-7 px-2 flex items-center gap-1.5 rounded-sm transition-colors text-[11px] font-semibold tracking-wide"
      style={{
        background: "rgba(220, 38, 38, 0.1)",
        border: "1px solid rgba(220, 38, 38, 0.25)",
        color: "#f5e6e6",
      }}
      onMouseEnter={(e) => { e.currentTarget.style.background = "rgba(220, 38, 38, 0.25)"; }}
      onMouseLeave={(e) => { e.currentTarget.style.background = "rgba(220, 38, 38, 0.1)"; }}
    >
      {icon}
      <span>{children}</span>
      {shortcut && (
        <span className="text-[9px] font-mono opacity-60 ml-0.5 px-1 rounded-sm" style={{ background: "rgba(0,0,0,0.3)" }}>
          {shortcut}
        </span>
      )}
    </button>
  );
}

function FieldSection({
  label, description, items, origItems, onChange, tmPairs,
}: {
  label: string;
  description: string;
  items: string[];
  origItems: string[];
  onChange: (i: number, value: string) => void;
  tmPairs?: Array<{ en: string; ua: string }>;
}) {
  const t = useT();
  // Індекс рядка для Monaco-popup (null = closed).
  const [monacoIdx, setMonacoIdx] = useState<number | null>(null);
  return (
    <div
      className="rounded-sm overflow-hidden"
      style={{
        background: "rgba(13, 2, 4, 0.55)",
        backdropFilter: "blur(8px)",
        border: "1px solid rgba(220,38,38,0.2)",
      }}
    >
      <header
        className="px-4 py-2 flex items-center justify-between"
        style={{
          background: "linear-gradient(90deg, rgba(220,38,38,0.1) 0%, transparent 100%)",
          borderBottom: "1px solid rgba(220,38,38,0.15)",
        }}
      >
        <div>
          <span className="font-mono text-[11px] font-semibold tracking-wider" style={{ color: "#dc2626" }}>
            {label}
          </span>
          <span className="text-[10.5px] ml-2" style={{ color: "rgba(245,230,230,0.5)" }}>
            · {description}
          </span>
        </div>
        <span className="text-[10px] font-mono tabular-nums" style={{ color: "rgba(245,230,230,0.5)" }}>
          {tStatic("d4.item.field.linesShort", { n: items.length })}
        </span>
      </header>
      <div className="divide-y divide-[rgba(220,38,38,0.08)]">
        {items.map((value, i) => {
          const orig = origItems[i] ?? "";
          const translated = isTranslated(value, orig);
          const isChanged = value !== orig;
          const enChars = countChars(orig), enWords = countWords(orig);
          const uaChars = countChars(value), uaWords = countWords(value);
          const deltaPct = enChars > 0 ? Math.round(((uaChars - enChars) / enChars) * 100) : 0;
          const markers = orig ? markerDiff(orig, value) : { missing: [], extra: [] };
          const hasLint = markers.missing.length > 0 || markers.extra.length > 0;
          return (
            <div key={i} className="p-3 flex gap-3">
              <span
                className="font-mono text-[10px] tabular-nums w-8 shrink-0 pt-1.5"
                style={{ color: "rgba(245,230,230,0.35)" }}
              >
                {i.toString().padStart(3, "0")}
              </span>
              <div className="flex-1 min-w-0 space-y-1.5">
                {/* Original (read-only) */}
                {orig && (
                  <div
                    className="text-[11.5px] font-mono px-2 py-1 rounded-sm"
                    style={{
                      background: "rgba(0,0,0,0.3)",
                      color: "rgba(245,230,230,0.5)",
                      borderLeft: "2px solid rgba(245,230,230,0.2)",
                      whiteSpace: "pre-wrap",
                      wordBreak: "break-word",
                    }}
                  >
                    {orig}
                  </div>
                )}
                {/* Translation textarea + Monaco-popup кнопка */}
                <div className="relative">
                  <textarea
                    value={value}
                    onChange={(e) => onChange(i, e.target.value)}
                    rows={Math.max(1, Math.min(8, value.split("\n").length))}
                    className="w-full px-2 py-1 pr-8 text-[12px] font-mono rounded-sm resize-y"
                    style={{
                      background: "rgba(0,0,0,0.5)",
                      color: translated ? "#fff" : isChanged ? "#fbbf24" : "rgba(245,230,230,0.85)",
                      border: `1px solid ${hasLint && isChanged ? "rgba(251,191,36,0.5)" : translated ? "rgba(34,197,94,0.4)" : "rgba(220,38,38,0.25)"}`,
                      borderLeft: `2px solid ${translated ? "#22c55e" : "#dc2626"}`,
                      minHeight: "32px",
                    }}
                  />
                  <button
                    onClick={() => setMonacoIdx(i)}
                    title={tStatic("d4.monaco.open")}
                    className="absolute top-1 right-1 w-5 h-5 flex items-center justify-center rounded-sm"
                    style={{
                      background: "rgba(220,38,38,0.15)",
                      border: "1px solid rgba(220,38,38,0.3)",
                      color: "#fca5a5",
                    }}
                  >
                    <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 3.75v4.5m0-4.5h4.5m-4.5 0L9 9M3.75 20.25v-4.5m0 4.5h4.5m-4.5 0L9 15M20.25 3.75h-4.5m4.5 0v4.5m0-4.5L15 9m5.25 11.25h-4.5m4.5 0v-4.5m0 4.5L15 15" />
                    </svg>
                  </button>
                </div>
                {/* TM panel (тільки для m_aString — там tmPairs передаються) */}
                {tmPairs && orig && orig.length >= 4 && (
                  <D4TmPanel
                    query={orig}
                    pairs={tmPairs}
                    onPick={(ua) => onChange(i, ua)}
                  />
                )}
                {/* Counters + Lint footer */}
                {(orig || value) && (
                  <div className="flex items-center flex-wrap gap-x-3 gap-y-0.5 text-[10px] font-mono tabular-nums" style={{ color: "rgba(245,230,230,0.5)" }}>
                    {orig && (
                      <span>
                        <span style={{ color: "rgba(245,230,230,0.4)" }}>{tStatic("d4.counter.en")}</span>{" "}
                        {tStatic("d4.counter.chars", { n: enChars })} · {tStatic("d4.counter.words", { n: enWords })}
                      </span>
                    )}
                    {value && (
                      <span>
                        <span style={{ color: "rgba(245,230,230,0.4)" }}>{tStatic("d4.counter.ua")}</span>{" "}
                        {tStatic("d4.counter.chars", { n: uaChars })} · {tStatic("d4.counter.words", { n: uaWords })}
                      </span>
                    )}
                    {orig && value && (
                      <span style={{
                        color: Math.abs(deltaPct) > 30 ? "#fbbf24" : "rgba(245,230,230,0.4)",
                      }}>
                        {tStatic("d4.counter.delta", { sign: deltaPct >= 0 ? "+" : "", pct: deltaPct })}
                      </span>
                    )}
                    {hasLint && (
                      <span className="px-1.5 py-0.5 rounded-sm" title={tStatic("d4.lint.title")} style={{
                        background: "rgba(251,191,36,0.15)",
                        color: "#fbbf24",
                        border: "1px solid rgba(251,191,36,0.4)",
                      }}>
                        {markers.missing.length > 0 && tStatic("d4.lint.missing", { tags: markers.missing.join(" ") })}
                        {markers.missing.length > 0 && markers.extra.length > 0 && " · "}
                        {markers.extra.length > 0 && tStatic("d4.lint.extra", { tags: markers.extra.join(" ") })}
                      </span>
                    )}
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
      <D4MonacoEditModal
        open={monacoIdx !== null}
        initial={monacoIdx !== null ? (items[monacoIdx] ?? "") : ""}
        original={monacoIdx !== null ? (origItems[monacoIdx] ?? "") : ""}
        title={`${label}[${monacoIdx ?? 0}]`}
        onSave={(v) => { if (monacoIdx !== null) onChange(monacoIdx, v); setMonacoIdx(null); }}
        onClose={() => setMonacoIdx(null)}
      />
    </div>
  );
}
