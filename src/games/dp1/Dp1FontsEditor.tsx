// DP1 Fonts editor — Photoshop-like редактор атласу FONTWIDE.DDS.
//
// Workflow гри: текст йде через `dp1GlyphMap` (Cyrillic → Latin), гра рендерить
// латинський гліф з FONTWIDE.DDS. Щоб дати укр-літери, треба:
//   1) Стерти існуючий латинський гліф у FONTWIDE.
//   2) Намалювати нову кирилицю у тій самій клітинці.
//   3) Додати у glyphmap пару Кир→Лат.
//
// Цей UI дозволяє:
//   • Drag-selection прямокутника (з snap-to-grid; Shift вимикає snap).
//   • Стерти виділене (залити чорним).
//   • Намалювати літеру у виділене (Cinema Calligraphy 31.5pt, червоний).
//   • Перемістити виділене (cut → paste, старе місце чорне).
//   • Toggle grid 32×32 overlay.
//   • Glyphmap propose-banner після draw — "Додати Ї → Q?" з кнопкою Apply.

import { useCallback, useEffect, useRef, useState } from "react";
import { useT, localizeBackendError } from "../../lib/i18n";
import { LangToggle } from "../../components/LangToggle";
import { showError, showOk, showWarn } from "../../components/Toast";

interface Props {
  onHome: () => void;
}

const DP1_FONT_FAMILY = "DP1CinemaCalligraphy";
const DEFAULT_FONT_SIZE = 31.5;
const DP1_RED = "#FF0000";
const DEFAULT_GRID = 32;

let _fontPromise: Promise<{ ok: true } | { ok: false; error: string }> | null = null;
async function ensureDp1FontLoaded(fontPath: string): Promise<{ ok: true } | { ok: false; error: string }> {
  if (_fontPromise) return _fontPromise;
  _fontPromise = (async () => {
    const r = await window.dp2.readFontFile(fontPath);
    if (!r.ok || !r.base64) return { ok: false as const, error: r.error ?? "не вдалося прочитати шрифт" };
    const bin = atob(r.base64);
    const ab = new ArrayBuffer(bin.length);
    const u8 = new Uint8Array(ab);
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    try {
      const ff = new FontFace(DP1_FONT_FAMILY, ab);
      await ff.load();
      document.fonts.add(ff);
      return { ok: true as const };
    } catch (e) {
      _fontPromise = null;
      return { ok: false as const, error: String(e instanceof Error ? e.message : e) };
    }
  })();
  return _fontPromise;
}

interface Rect { x: number; y: number; w: number; h: number }
type Tool = "select" | "move";

export function Dp1FontsEditor({ onHome }: Props) {
  const t = useT();
  const [dimensions, setDimensions] = useState<{ w: number; h: number } | null>(null);
  const [source, setSource] = useState<"done" | "original" | null>(null);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [zoom, setZoom] = useState(0.5);
  const [tool, setTool] = useState<Tool>("select");
  const [showGrid, setShowGrid] = useState(true);
  const [gridSize, setGridSize] = useState(DEFAULT_GRID);
  const [selection, setSelection] = useState<Rect | null>(null);
  const [drawOpen, setDrawOpen] = useState(false);
  const [typefacePath, setTypefacePath] = useState<string | null>(null);
  const [typefaceDownload, setTypefaceDownload] = useState<{
    visible: boolean; phase: "start" | "download" | "done" | "error"; percent: number; downloaded: number; total: number; error?: string;
  }>({ visible: false, phase: "start", percent: 0, downloaded: 0, total: 0 });
  const [mapProposal, setMapProposal] = useState<{
    letter: string; rect: Rect; suggestedKey?: string; existingMap: Record<string, string>;
  } | null>(null);

  const rgbaRef = useRef<Uint8ClampedArray | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const overlayRef = useRef<HTMLCanvasElement | null>(null);
  const renderCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const wrapperRef = useRef<HTMLDivElement | null>(null);

  // Undo: тримаємо до MAX_UNDO снапшотів rgbaRef (deep-copy). Push перед
  // кожною мутацією (erase/draw/move). Ctrl+Z поппає.
  const undoStackRef = useRef<Uint8ClampedArray[]>([]);
  const MAX_UNDO = 30;

  // Mouse drag state (у image-space координатах, не CSS).
  const dragRef = useRef<{
    mode: "select" | "move-source";
    startX: number; startY: number;
    curX: number; curY: number;
    wasDragged: boolean;        // true як тільки рух перевищив CLICK_THRESHOLD
    originRect?: Rect;          // для move
    cutData?: Uint8ClampedArray;
  } | null>(null);
  const CLICK_THRESHOLD = 3; // px у image-space — менше = click, більше = drag

  // ── Bootstrap: download + decode ───────────────────────────────
  const reload = useCallback(async () => {
    setBusy(true);
    setError(null);
    setSelection(null);
    const r = await window.dp2.dp1FontsReadRgba();
    setBusy(false);
    if (!r.ok || !r.rgbaBase64) { setError(localizeBackendError(r.error) || t("dp1.fonts.ddsLoadFailed")); return; }
    const bin = atob(r.rgbaBase64);
    const arr = new Uint8ClampedArray(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    rgbaRef.current = arr;
    setDimensions({ w: r.width!, h: r.height! });
    setSource(r.source ?? "original");
    setDirty(false);
  }, []);

  useEffect(() => {
    const off = window.dp2.onDp1FontsTypefaceProgress((p) => {
      setTypefaceDownload((prev) => ({
        ...prev, visible: p.phase !== "done", phase: p.phase,
        percent: p.percent ?? prev.percent, downloaded: p.downloaded ?? prev.downloaded,
        total: p.total ?? prev.total, error: p.error ?? undefined,
      }));
    });
    return () => off();
  }, []);

  useEffect(() => {
    (async () => {
      const r = await window.dp2.dp1FontsEnsureTypeface();
      if (!r.ok || !r.path) { setError(localizeBackendError(r.error) || t("dp1.fonts.fontLoadFailed")); return; }
      setTypefacePath(r.path);
      setTypefaceDownload((s) => ({ ...s, visible: false }));
      void ensureDp1FontLoaded(r.path);
      await reload();
    })();
  }, [reload]);

  // Малюємо RGBA → canvas коли dimensions міняються.
  useEffect(() => {
    if (!canvasRef.current || !dimensions || !rgbaRef.current) return;
    const c = canvasRef.current;
    c.width = dimensions.w; c.height = dimensions.h;
    const ctx = c.getContext("2d");
    if (!ctx) return;
    ctx.putImageData(new ImageData(rgbaRef.current.slice(), dimensions.w, dimensions.h), 0, 0);
  }, [dimensions]);

  // Малюємо overlay (grid + selection) — окремий шар поверх canvas.
  const redrawOverlay = useCallback(() => {
    const oc = overlayRef.current;
    if (!oc || !dimensions) return;
    oc.width = dimensions.w; oc.height = dimensions.h;
    const ctx = oc.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, dimensions.w, dimensions.h);
    if (showGrid && gridSize > 0) {
      ctx.strokeStyle = "rgba(120,180,255,0.18)";
      ctx.lineWidth = 1;
      for (let x = 0; x <= dimensions.w; x += gridSize) {
        ctx.beginPath(); ctx.moveTo(x + 0.5, 0); ctx.lineTo(x + 0.5, dimensions.h); ctx.stroke();
      }
      for (let y = 0; y <= dimensions.h; y += gridSize) {
        ctx.beginPath(); ctx.moveTo(0, y + 0.5); ctx.lineTo(dimensions.w, y + 0.5); ctx.stroke();
      }
    }
    if (selection) {
      const { x, y, w, h } = selection;
      ctx.strokeStyle = "#58a6ff";
      ctx.lineWidth = 2;
      ctx.setLineDash([6, 4]);
      ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
      ctx.setLineDash([]);
      // Sm-label з розмірами і координатами у кутку.
      ctx.fillStyle = "rgba(0,0,0,0.7)";
      ctx.fillRect(x, Math.max(0, y - 18), 140, 16);
      ctx.fillStyle = "#fff";
      ctx.font = "11px monospace";
      ctx.fillText(`${x},${y} · ${w}×${h}`, x + 4, Math.max(12, y - 5));
    }
  }, [dimensions, selection, showGrid, gridSize]);

  useEffect(() => { redrawOverlay(); }, [redrawOverlay]);

  // Ctrl+Z → undo (Ctrl+Shift+Z навмисно не біндимо як redo, бо не маємо
  // redo-стека; стандартний Ctrl+Y теж пропускаємо).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const ctrl = e.ctrlKey || e.metaKey;
      if (ctrl && !e.shiftKey && e.key.toLowerCase() === "z") {
        e.preventDefault();
        undo();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dimensions]);

  // ── Mouse helpers ───────────────────────────────────────────────
  function imgCoords(e: React.PointerEvent<HTMLDivElement>): { x: number; y: number } | null {
    if (!wrapperRef.current || !dimensions) return null;
    const rect = wrapperRef.current.getBoundingClientRect();
    // wrapper розміром (w*zoom, h*zoom). Image-coord = (clientX - left)/zoom.
    const cssX = e.clientX - rect.left;
    const cssY = e.clientY - rect.top;
    if (cssX < 0 || cssY < 0 || cssX > rect.width || cssY > rect.height) return null;
    return { x: Math.round(cssX / zoom), y: Math.round(cssY / zoom) };
  }
  function snap(v: number, shift: boolean): number {
    if (shift || !showGrid || gridSize <= 0) return v;
    return Math.round(v / gridSize) * gridSize;
  }
  function normalizeRect(sx: number, sy: number, ex: number, ey: number, shift: boolean): Rect {
    const x1 = snap(Math.min(sx, ex), shift);
    const y1 = snap(Math.min(sy, ey), shift);
    const x2 = snap(Math.max(sx, ex), shift);
    const y2 = snap(Math.max(sy, ey), shift);
    return { x: x1, y: y1, w: Math.max(1, x2 - x1), h: Math.max(1, y2 - y1) };
  }

  function onPointerDown(e: React.PointerEvent<HTMLDivElement>) {
    if (e.button !== 0) return;
    const p = imgCoords(e);
    if (!p) return;
    (e.target as Element).setPointerCapture?.(e.pointerId);
    if (tool === "move" && selection &&
        p.x >= selection.x && p.x < selection.x + selection.w &&
        p.y >= selection.y && p.y < selection.y + selection.h) {
      // Move: cut data резервуємо одразу, але оригінал НЕ стираємо до drop —
      // інакше під час drag-у користувач бачить чорну дірку і не розуміє куди
      // потрапить glyph.
      dragRef.current = {
        mode: "move-source",
        startX: p.x, startY: p.y, curX: p.x, curY: p.y,
        wasDragged: false,
        originRect: { ...selection },
        cutData: cutFromBuffer(selection),
      };
      return;
    }
    dragRef.current = { mode: "select", startX: p.x, startY: p.y, curX: p.x, curY: p.y, wasDragged: false };
    // Не апдейтимо selection одразу — чекаємо на pointerUp / wasDragged.
  }
  function onPointerMove(e: React.PointerEvent<HTMLDivElement>) {
    if (!dragRef.current) return;
    const p = imgCoords(e);
    if (!p) return;
    dragRef.current.curX = p.x;
    dragRef.current.curY = p.y;
    const dist = Math.max(Math.abs(p.x - dragRef.current.startX), Math.abs(p.y - dragRef.current.startY));
    if (dist > CLICK_THRESHOLD) dragRef.current.wasDragged = true;
    if (dragRef.current.mode === "select") {
      if (dragRef.current.wasDragged) {
        setSelection(normalizeRect(dragRef.current.startX, dragRef.current.startY, p.x, p.y, e.shiftKey));
      }
    } else if (dragRef.current.mode === "move-source") {
      if (!dragRef.current.originRect) return;
      const r = dragRef.current.originRect;
      const dx = p.x - dragRef.current.startX;
      const dy = p.y - dragRef.current.startY;
      const tx = snap(r.x + dx, e.shiftKey);
      const ty = snap(r.y + dy, e.shiftKey);
      setSelection({ x: tx, y: ty, w: r.w, h: r.h });
    }
  }
  function onPointerUp(e: React.PointerEvent<HTMLDivElement>) {
    const drag = dragRef.current;
    if (!drag) return;
    dragRef.current = null;
    if (drag.mode === "select" && !drag.wasDragged) {
      // Click без drag — виділити одну grid-клітинку, у яку клікнув.
      if (showGrid && gridSize > 0) {
        const cx = Math.floor(drag.startX / gridSize) * gridSize;
        const cy = Math.floor(drag.startY / gridSize) * gridSize;
        if (dimensions) {
          const w = Math.min(gridSize, dimensions.w - cx);
          const h = Math.min(gridSize, dimensions.h - cy);
          setSelection({ x: cx, y: cy, w, h });
        }
      } else {
        // Без grid просто виставимо точкове виділення 1×1 (rідко корисно).
        setSelection({ x: drag.startX, y: drag.startY, w: 1, h: 1 });
      }
      return;
    }
    if (drag.mode === "move-source" && drag.cutData && drag.originRect && drag.wasDragged) {
      pushUndo();
      const r = drag.originRect;
      const dx = drag.curX - drag.startX;
      const dy = drag.curY - drag.startY;
      const tx = snap(r.x + dx, e.shiftKey);
      const ty = snap(r.y + dy, e.shiftKey);
      // Тільки тут (на drop) стираємо оригінал і блітимо у нове місце.
      eraseRect(r);
      pasteToBuffer({ x: tx, y: ty, w: r.w, h: r.h }, drag.cutData);
      paintFullCanvas();
      setSelection({ x: tx, y: ty, w: r.w, h: r.h });
      setDirty(true);
    }
  }

  // ── Buffer ops (всі через rgbaRef) ──────────────────────────────
  function cutFromBuffer(r: Rect): Uint8ClampedArray {
    const buf = rgbaRef.current!;
    const dim = dimensions!;
    const out = new Uint8ClampedArray(r.w * r.h * 4);
    for (let y = 0; y < r.h; y++) {
      const srcRow = ((r.y + y) * dim.w + r.x) * 4;
      out.set(buf.subarray(srcRow, srcRow + r.w * 4), y * r.w * 4);
    }
    return out;
  }
  function pasteToBuffer(r: Rect, data: Uint8ClampedArray) {
    const buf = rgbaRef.current!;
    const dim = dimensions!;
    const cw = Math.min(r.w, dim.w - r.x);
    const ch = Math.min(r.h, dim.h - r.y);
    for (let y = 0; y < ch; y++) {
      const dstRow = ((r.y + y) * dim.w + r.x) * 4;
      buf.set(data.subarray(y * r.w * 4, y * r.w * 4 + cw * 4), dstRow);
    }
  }
  function eraseRect(r: Rect) {
    const buf = rgbaRef.current!;
    const dim = dimensions!;
    for (let y = 0; y < r.h; y++) {
      const off = ((r.y + y) * dim.w + r.x) * 4;
      for (let x = 0; x < r.w; x++) {
        const o = off + x * 4;
        buf[o] = 0; buf[o + 1] = 0; buf[o + 2] = 0; buf[o + 3] = 255;
      }
    }
  }
  function paintCanvasRect(_r: Rect) {
    paintFullCanvas();
  }
  function paintFullCanvas() {
    if (!canvasRef.current || !rgbaRef.current || !dimensions) return;
    const ctx = canvasRef.current.getContext("2d");
    if (!ctx) return;
    ctx.putImageData(new ImageData(rgbaRef.current.slice(), dimensions.w, dimensions.h), 0, 0);
  }

  function pushUndo() {
    if (!rgbaRef.current) return;
    undoStackRef.current.push(rgbaRef.current.slice());
    while (undoStackRef.current.length > MAX_UNDO) undoStackRef.current.shift();
  }
  function undo() {
    const prev = undoStackRef.current.pop();
    if (!prev || !dimensions) return;
    rgbaRef.current = prev;
    paintFullCanvas();
    setDirty(undoStackRef.current.length > 0);
  }

  // ── Action handlers ────────────────────────────────────────────
  function actErase() {
    if (!selection) { showWarn(t("dp1.fonts.selectRectFirst")); return; }
    pushUndo();
    eraseRect(selection);
    paintCanvasRect(selection);
    setDirty(true);
  }
  function actOpenDraw() {
    if (!selection) { showWarn(t("dp1.fonts.selectRectOnAtlasFirst")); return; }
    setDrawOpen(true);
  }
  async function actDraw(letter: string, fontSize: number, offsetX = 0, offsetY = 0) {
    if (!selection || !rgbaRef.current || !dimensions || !renderCanvasRef.current || !typefacePath) return;
    const r = selection;
    pushUndo();
    // Стираємо існуючий пiксель + малюємо літеру у центрі виділення зі зсувом.
    eraseRect(r);
    const rc = renderCanvasRef.current;
    rc.width = r.w; rc.height = r.h;
    const ctx = rc.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, r.w, r.h);
    ctx.fillStyle = DP1_RED;
    ctx.font = `${fontSize}px "${DP1_FONT_FAMILY}"`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(letter, r.w / 2 + offsetX, r.h / 2 + offsetY);
    const overlay = ctx.getImageData(0, 0, r.w, r.h).data;
    const buf = rgbaRef.current;
    const dim = dimensions;
    for (let y = 0; y < r.h; y++) {
      for (let x = 0; x < r.w; x++) {
        const oOff = (y * r.w + x) * 4;
        const a = overlay[oOff + 3];
        if (!a) continue;
        const k = a / 255;
        const dOff = ((r.y + y) * dim.w + (r.x + x)) * 4;
        buf[dOff]     = (overlay[oOff]     * k + buf[dOff]     * (1 - k)) | 0;
        buf[dOff + 1] = (overlay[oOff + 1] * k + buf[dOff + 1] * (1 - k)) | 0;
        buf[dOff + 2] = (overlay[oOff + 2] * k + buf[dOff + 2] * (1 - k)) | 0;
        buf[dOff + 3] = 255;
      }
    }
    paintCanvasRect(r);
    setDirty(true);
    setDrawOpen(false);
    // Glyphmap proposal — читаємо поточну мапу і пропонуємо ключ.
    try {
      const g = await window.dp2.dp1GlyphMapRead();
      const existing = g.ok ? (g.map ?? {}) : {};
      // Suggestion: знайти clear latin-літеру тієї ж випадку. Простий heuristic:
      // якщо letter — велика кирилиця, пропонуємо латиничну літеру близьку
      // за виглядом; інакше — порожнім — нехай користувач вкаже.
      setMapProposal({ letter, rect: r, suggestedKey: guessLatinCounterpart(letter), existingMap: existing });
    } catch {}
  }

  async function handleSave() {
    if (!dimensions || !rgbaRef.current) return;
    setBusy(true);
    const b64 = uint8ToBase64(rgbaRef.current);
    const r = await window.dp2.dp1FontsSaveRgba({ width: dimensions.w, height: dimensions.h, rgbaBase64: b64 });
    setBusy(false);
    if (!r.ok) showError(localizeBackendError(r.error) || "save fail", t("dp1.fonts.ddsSaveFailed"));
    else { showOk(t("dp1.fonts.savedToDone", { size: ((r.size ?? 0) / 1024).toFixed(1) }), "FONTWIDE.DDS"); setDirty(false); setSource("done"); }
  }

  return (
    <div className="flex-1 flex flex-col min-h-0 h-full">
      <header className="h-12 px-4 border-b border-[var(--border-soft)] bg-[var(--bg)] flex items-center gap-2 shrink-0">
        <button className="dp-btn dp-btn--ghost" onClick={onHome}>← {t("dp1.fonts.toHome")}</button>
        <span className="text-[13px] font-semibold text-[var(--text-strong)]">{t("dp1.fonts.title")}</span>
        {dimensions && (
          <span className="text-[10.5px] text-[var(--text-faint)] font-mono">
            {dimensions.w}×{dimensions.h} · {source === "done" ? "Done" : "Original"}{dirty && " · ●"}
          </span>
        )}
        <div className="flex-1" />
        <button
          className={`dp-btn ${tool === "select" ? "dp-btn--primary" : "dp-btn--ghost"}`}
          onClick={() => setTool("select")}
          title={t("dp1.fonts.selectTip")}
        >▭ Select</button>
        <button
          className={`dp-btn ${tool === "move" ? "dp-btn--primary" : "dp-btn--ghost"}`}
          onClick={() => setTool("move")}
          disabled={!selection}
          title={t("dp1.fonts.moveTip")}
        >↔ Move</button>
        <button className="dp-btn" onClick={actErase} disabled={!selection} title={t("dp1.fonts.eraseTip")}>🗑 {t("dp1.fonts.erase")}</button>
        <button className="dp-btn" onClick={actOpenDraw} disabled={!selection || !typefacePath} title={t("dp1.fonts.drawTip")}>+ {t("dp1.fonts.letter")}</button>
        <span className="mx-1 h-5 w-px bg-[var(--border-soft)]" />
        <label className="flex items-center gap-1 text-[10.5px] text-[var(--text-muted)] cursor-pointer">
          <input type="checkbox" checked={showGrid} onChange={(e) => setShowGrid(e.target.checked)} />
          Grid
        </label>
        <input
          type="number" min={4} max={256} step={1}
          className="dp-input !w-[64px] !text-[11px] !py-0.5"
          value={gridSize}
          onChange={(e) => setGridSize(Math.max(4, parseInt(e.target.value) || DEFAULT_GRID))}
          title={t("dp1.fonts.gridSizeTip")}
        />
        <span className="mx-1 h-5 w-px bg-[var(--border-soft)]" />
        <label className="flex items-center gap-1 text-[10.5px] text-[var(--text-muted)]">
          {(zoom * 100).toFixed(0)}%
          <input
            type="range" min={0.25} max={2} step={0.05}
            value={zoom} onChange={(e) => setZoom(parseFloat(e.target.value))}
            className="accent-[var(--accent)]" style={{ width: 100 }}
          />
        </label>
        <button
          className="dp-btn dp-btn--ghost"
          onClick={undo}
          title={t("dp1.fonts.undoTip")}
        >↶</button>
        <button className="dp-btn dp-btn--ghost" disabled={busy} onClick={() => { void reload(); }} title={t("dp1.fonts.reloadTip")}>↻</button>
        <button className="dp-btn dp-btn--success" disabled={!dirty || busy} onClick={handleSave}>
          {busy ? "…" : t("dp1.fonts.saveToDone")}
        </button>
        <LangToggle compact />
      </header>

      {error && <div className="px-4 py-2 bg-[var(--danger)]/10 border-b border-[var(--danger)]/40 text-[12px] text-[var(--danger)]">{error}</div>}

      {mapProposal && (
        <GlyphmapProposalBanner
          letter={mapProposal.letter}
          suggestedKey={mapProposal.suggestedKey}
          existingMap={mapProposal.existingMap}
          onApply={async (latinKey) => {
            const map = { ...mapProposal.existingMap, [mapProposal.letter]: latinKey };
            const r = await window.dp2.dp1GlyphMapWrite({ map });
            if (!r.ok) showError(localizeBackendError(r.error) || "?", "GlyphMap save failed");
            else showOk(t("dp1.fonts.glyphMapAdded", { letter: mapProposal.letter, key: latinKey }), "GlyphMap");
            setMapProposal(null);
          }}
          onDismiss={() => setMapProposal(null)}
        />
      )}

      <div className="flex-1 overflow-auto bg-[var(--bg)] flex items-start justify-center p-4">
        {!dimensions && !error && !typefaceDownload.visible && <p className="text-[12.5px] text-[var(--text-muted)] py-10">{t("dp1.fonts.decodingDds")}</p>}
        {dimensions && (
          <div
            ref={wrapperRef}
            className="relative"
            style={{
              // Container розміром саме як scaled-atlas — щоб scroll/overflow
              // правильно вираховували повну площу.
              width: dimensions.w * zoom,
              height: dimensions.h * zoom,
              touchAction: "none",
              cursor: tool === "move" ? "move" : "crosshair",
            }}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
          >
            {/* Canvas-и рендеримо у native pixel-resolution атласу.
               transform: scale() з pixelated дає Chromium nearest-neighbor
               без артефактів, на відміну від CSS width/height-resize, яке
               блюрить навіть з image-rendering:pixelated. */}
            <canvas
              ref={canvasRef}
              style={{
                position: "absolute", top: 0, left: 0,
                width: dimensions.w + "px",
                height: dimensions.h + "px",
                transform: `scale(${zoom})`,
                transformOrigin: "top left",
                imageRendering: "pixelated",
                background: "repeating-conic-gradient(#181818 0% 25%, #1f1f1f 0% 50%) 50% / 24px 24px",
                boxShadow: "0 0 0 1px var(--border-soft)",
              }}
            />
            <canvas
              ref={overlayRef}
              style={{
                position: "absolute", top: 0, left: 0,
                width: dimensions.w + "px",
                height: dimensions.h + "px",
                transform: `scale(${zoom})`,
                transformOrigin: "top left",
                imageRendering: "pixelated",
                pointerEvents: "none",
              }}
            />
          </div>
        )}
      </div>
      <canvas ref={renderCanvasRef} className="hidden" />

      {typefaceDownload.visible && <TypefaceDownloadModal data={typefaceDownload} />}

      {drawOpen && selection && (
        <DrawLetterModal
          rect={selection}
          defaultSize={DEFAULT_FONT_SIZE}
          fontReady={!!typefacePath}
          onClose={() => setDrawOpen(false)}
          onSubmit={actDraw}
        />
      )}
    </div>
  );
}

// ── Glyphmap proposal banner ────────────────────────────────────────

// DP1: гра відображає клітинку атласу зі зсувом +2 від char code у тексті
// ДЛЯ extended ASCII (>= 0xA0). Тож щоб замінити Г-літеру на видиму клітинку
// `Á` (0xC1) у атласі, у словник пишемо `Г → ¿` (0xBF = 0xC1-2). Базовий
// ASCII (A-Z, a-z, 0-9) рендериться напряму без offset — для нього у default
// mapping ми бачимо direct pairs типу `А → A`.
function offsetForward(ch: string): string {
  if (!ch) return ch;
  const c = ch.charCodeAt(0);
  // Базовий ASCII (включаючи printable) — без offset.
  if (c < 0xA0) return ch;
  return String.fromCharCode((c - 2) & 0xffff);
}

function GlyphmapProposalBanner({
  letter, suggestedKey, existingMap, onApply, onDismiss,
}: {
  letter: string;
  suggestedKey?: string;
  existingMap: Record<string, string>;
  onApply: (latinKey: string) => void;
  onDismiss: () => void;
}) {
  const t = useT();
  // `val` — ВІЗУАЛЬНИЙ символ (де у атласі намальовано літеру). У словник
  // пишемо offsetForward(val), бо гра при рендері робить -2.
  const [val, setVal] = useState(suggestedKey ?? "");
  const stored = val ? offsetForward(val) : "";
  const collision = stored && Object.entries(existingMap).find(([k, v]) => v === stored && k !== letter);
  return (
    <div className="px-4 py-2 border-b border-[var(--accent)]/40 bg-[var(--accent)]/8 text-[12px] flex items-center gap-3 flex-wrap">
      <span className="font-mono text-[var(--accent)]">GlyphMap</span>
      <span className="text-[var(--text)]">
        {t("dp1.fonts.addPrefix")} <span className="font-mono text-[14px]">{letter}</span> →
      </span>
      <label className="flex items-center gap-1 text-[10.5px] text-[var(--text-muted)]">
        {t("dp1.fonts.visualCell")}
        <input
          className="dp-input !w-[60px] !text-[14px] text-center font-mono"
          maxLength={1}
          value={val}
          onChange={(e) => setVal(e.target.value)}
          placeholder="?"
          autoFocus
        />
      </label>
      <span className="text-[10.5px] text-[var(--text-faint)] font-mono">
        {t("dp1.fonts.toDict")}&nbsp;
        <span className="text-[var(--accent)]">{stored || "?"}</span>
        {val && (
          <span className="ml-1 text-[var(--text-faint)]">
            ({val.charCodeAt(0) >= 0xA0 ? `${val.charCodeAt(0)} −2 = ${stored.charCodeAt(0)}` : t("dp1.fonts.noOffsetAscii")})
          </span>
        )}
      </span>
      {collision && (
        <span className="text-[10.5px] text-[var(--warning,#d97706)]">⚠ {t("dp1.fonts.alreadyMapped", { key: collision[0] })}</span>
      )}
      <button className="dp-btn dp-btn--primary" disabled={!val} onClick={() => onApply(stored)}>Apply</button>
      <button className="dp-btn dp-btn--ghost" onClick={onDismiss}>{t("dp1.fonts.skip")}</button>
    </div>
  );
}

// ── Typeface download modal ─────────────────────────────────────────

function TypefaceDownloadModal({ data }: { data: { phase: string; percent: number; downloaded: number; total: number; error?: string } }) {
  const t = useT();
  const fmt = (n: number) => n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(2)} MB`;
  return (
    <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-6">
      <div className="dp-card max-w-md w-full p-5" style={{ background: "var(--bg-surface)" }}>
        <p className="text-[11px] uppercase tracking-wider text-[var(--text-faint)] mb-1">{t("dp1.fonts.firstRun")}</p>
        <h2 className="text-[15px] font-semibold text-[var(--text-strong)] mb-3">{t("dp1.fonts.downloadingCinema")}</h2>
        <p className="text-[12px] text-[var(--text-muted)] mb-4">{t("dp1.fonts.cinemaDesc")} <span className="font-mono text-[var(--accent)]">Documents/SWERY-Localization-Tool/DP1/Fonts/</span>.</p>
        {data.phase === "error" ? (
          <p className="text-[12px] text-[var(--danger)] break-words">{data.error}</p>
        ) : (
          <>
            <div className="h-2 bg-[var(--bg-elevated)] rounded overflow-hidden mb-2">
              <div className="h-full bg-[var(--accent)] transition-[width] duration-150" style={{ width: `${Math.max(2, data.percent)}%` }} />
            </div>
            <div className="flex items-center justify-between text-[10.5px] tabular-nums text-[var(--text-muted)]">
              <span>{data.phase === "start" ? t("dp1.fonts.connectingDropbox") : fmt(data.downloaded) + " / " + (data.total ? fmt(data.total) : "?")}</span>
              <span>{data.percent.toFixed(0)}%</span>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ── Draw-letter modal ───────────────────────────────────────────────

function DrawLetterModal({ rect, defaultSize, fontReady, onClose, onSubmit }: {
  rect: Rect; defaultSize: number; fontReady: boolean;
  onClose: () => void;
  onSubmit: (letter: string, size: number, offsetX: number, offsetY: number) => void;
}) {
  const t = useT();
  const [letter, setLetter] = useState("");
  const [size, setSize] = useState(defaultSize);
  // Зсув центру літери всередині клітинки (px). Дозволяє підкорегувати
  // вертикальну/горизонтальну центровку — бо у Cinema Calligraphy baseline
  // не завжди співпадає з геометричним центром, особливо для літер з
  // діакритикою (Ї, Й, Є).
  const [offsetX, setOffsetX] = useState(0);
  const [offsetY, setOffsetY] = useState(0);
  const previewRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    if (!fontReady || !previewRef.current) return;
    const c = previewRef.current;
    c.width = rect.w; c.height = rect.h;
    const ctx = c.getContext("2d");
    if (!ctx) return;
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, rect.w, rect.h);
    if (letter) {
      ctx.fillStyle = DP1_RED;
      ctx.font = `${size}px "${DP1_FONT_FAMILY}"`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(letter, rect.w / 2 + offsetX, rect.h / 2 + offsetY);
    }
  }, [letter, size, rect, fontReady, offsetX, offsetY]);

  return (
    <div
      className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-6"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="dp-card max-w-md w-full p-5" style={{ background: "var(--bg-surface)" }} onMouseDown={(e) => e.stopPropagation()}>
        <h2 className="text-[15px] font-semibold text-[var(--text-strong)] mb-1">{t("dp1.fonts.drawLetterTitle")}</h2>
        <p className="text-[11px] text-[var(--text-faint)] font-mono mb-4">{t("dp1.fonts.intoCell", { x: rect.x, y: rect.y, w: rect.w, h: rect.h })}</p>

        <div className="space-y-3">
          <div>
            <label className="block text-[10.5px] uppercase tracking-wider text-[var(--text-faint)] mb-1">{t("dp1.fonts.letterField")}</label>
            <input
              className="dp-input !text-[24px] text-center font-mono"
              maxLength={1}
              value={letter}
              onChange={(e) => setLetter(e.target.value.slice(0, 1))}
              autoFocus
            />
          </div>
          <div>
            <label className="block text-[10.5px] uppercase tracking-wider text-[var(--text-faint)] mb-1">{t("dp1.fonts.sizePt")}</label>
            <input
              type="number" step={0.5} min={6} max={200}
              className="dp-input"
              value={size}
              onChange={(e) => setSize(parseFloat(e.target.value) || defaultSize)}
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-[10.5px] uppercase tracking-wider text-[var(--text-faint)] mb-1 flex items-center justify-between">
                <span>{t("dp1.fonts.offsetX")}</span>
                <span className="tabular-nums text-[var(--text)]">{offsetX > 0 ? `+${offsetX}` : offsetX}</span>
              </label>
              <input
                type="range" min={-16} max={16} step={1}
                value={offsetX}
                onChange={(e) => setOffsetX(parseInt(e.target.value, 10) || 0)}
                onDoubleClick={() => setOffsetX(0)}
                className="w-full accent-[var(--accent)]"
                title={t("dp1.fonts.resetTip")}
              />
            </div>
            <div>
              <label className="block text-[10.5px] uppercase tracking-wider text-[var(--text-faint)] mb-1 flex items-center justify-between">
                <span>{t("dp1.fonts.offsetY")}</span>
                <span className="tabular-nums text-[var(--text)]">{offsetY > 0 ? `+${offsetY}` : offsetY}</span>
              </label>
              <input
                type="range" min={-16} max={16} step={1}
                value={offsetY}
                onChange={(e) => setOffsetY(parseInt(e.target.value, 10) || 0)}
                onDoubleClick={() => setOffsetY(0)}
                className="w-full accent-[var(--accent)]"
                title={t("dp1.fonts.resetTip")}
              />
            </div>
          </div>
          <div>
            <p className="text-[10.5px] uppercase tracking-wider text-[var(--text-faint)] mb-1">{t("dp1.fonts.preview")}</p>
            <canvas
              ref={previewRef}
              style={{
                imageRendering: "pixelated",
                width: Math.min(rect.w * 4, 320),
                height: Math.min(rect.h * 4, 320),
                background: "#000",
                border: "1px solid var(--border-soft)",
              }}
            />
          </div>
        </div>

        <div className="flex items-center justify-end gap-2 mt-5 pt-3 border-t border-[var(--border-soft)]">
          <button className="dp-btn dp-btn--ghost" onClick={onClose}>{t("dp1.fonts.cancel")}</button>
          <button
            className="dp-btn dp-btn--primary"
            disabled={!letter || !fontReady}
            onClick={() => onSubmit(letter, size, offsetX, offsetY)}
          >
            {t("dp1.fonts.draw")}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Helpers ─────────────────────────────────────────────────────────

function uint8ToBase64(u8: Uint8ClampedArray): string {
  const CHUNK = 0x8000;
  let s = "";
  for (let i = 0; i < u8.length; i += CHUNK) {
    const slice = u8.subarray(i, i + CHUNK);
    s += String.fromCharCode.apply(null, Array.from(slice));
  }
  return btoa(s);
}

// Простий heuristic для DP1 glyphmap: пробуємо знайти латинський символ
// схожий за виглядом. Якщо нема — повертаємо undefined, користувач сам впише.
function guessLatinCounterpart(ch: string): string | undefined {
  const map: Record<string, string> = {
    "А": "A", "В": "B", "Е": "E", "К": "K", "М": "M", "Н": "H", "О": "O", "Р": "P",
    "С": "C", "Т": "T", "У": "Y", "Х": "X", "І": "I", "Ї": "Q", "Є": "W", "Ґ": "G",
    "а": "a", "в": "b", "е": "e", "к": "k", "м": "m", "н": "h", "о": "o", "р": "p",
    "с": "c", "т": "t", "у": "y", "х": "x", "і": "i", "ї": "q", "є": "w", "ґ": "g",
  };
  return map[ch];
}
