// Стор для TGL Fonts editor. Тримає список шрифтів, поточний parsed-JSON
// та base64 атласу. Усі правки гліфів — у parsed.data.m_CharacterRects.Array
// (in-place), у store сидить лиш `dirty` прапорець + revision-tick.

import { create } from "zustand";
import { t, localizeBackendError } from "../../../lib/i18n";
import {
  cloneGlyphAttributes,
  normalizeCyrillic,
  parseFontJson,
  serializeFontJson,
  wrapParsedFont,
  type FontDump,
  type FontGlyph,
  type NormalizeStats,
  type ParsedFont,
} from "./parser";

export interface FontListItem {
  jsonPath: string;
  atlasPath: string | null;
  name: string;
  fontSize: number;
  lineSpacing: number;
  charCount: number;
  texPathId: string | null;
  baseDir: string;
}

interface State {
  items: FontListItem[];
  baseFolder: string | null;
  loading: boolean;
  error: string | null;
  lastDebug: any;
  // Активний шрифт
  active: FontListItem | null;
  parsed: ParsedFont | null;
  atlasBase64: string | null;
  atlasW: number; // реальний розмір PNG, не фолбек з JSON
  atlasH: number;
  dirty: boolean;
  rev: number;
  /** Останній завантажений TTF/OTF (тримаємо у пам'яті на час сесії). */
  loadedFont: { family: string; filename: string } | null;
  setLoadedFont: (font: { family: string; filename: string } | null) => void;

  init: () => Promise<void>;
  selectFont: (it: FontListItem) => Promise<void>;
  setAtlasSize: (w: number, h: number) => void;
  saveJson: () => Promise<{ ok: boolean; error?: string }>;
  saveAtlas: () => Promise<{ ok: boolean; error?: string }>;
  saveAtlasFromBase64: (b64: string) => Promise<{ ok: boolean; error?: string }>;

  // edits
  updateGlyph: (index: number, patch: Partial<FontGlyph>) => void;
  addGlyph: (g: FontGlyph) => void;
  removeGlyph: (index: number) => void;
  copyFromGlyph: (toIndex: number, fromIndex: number) => void;

  // bulk
  normalizeCyrillicNow: () => NormalizeStats | null;
  /**
   * Прогнати кожен гліф з m_CharacterRects через canvas measureText
   * на завантаженому FontFace — оновити advance і vert.x (bearing-left).
   * vert.y/vert.width/vert.height та uv НЕ чіпаємо (atlas pos лишається).
   */
  importMetricsFromFontFace: (fontFamily: string, scope: "all" | "cyrillic" | "latin") => { touched: number; skipped: number };

  /**
   * Додає НОВИЙ гліф з готового RGBA-канвасу: знаходить вільну ділянку на
   * атласі, малює туди canvas, оновлює base64 атласу і додає запис у JSON.
   * Не замінює існуючих гліфів. Повертає {ok, reason?, uv?, vert?}.
   */
  addGlyphFromBitmap: (params: {
    targetCp: number;
    bitmap: HTMLCanvasElement;
    vert: { x: number; y: number; width: number; height: number };
    advance: number;
  }) => Promise<{ ok: boolean; reason?: string }>;
}

// Async-encode canvas → base64 PNG через toBlob (не блокує main thread).
// `toDataURL` синхронний і для 4K атласу займає 300-800ms.
async function canvasToBase64(c: HTMLCanvasElement): Promise<string | null> {
  return new Promise((resolve) => {
    c.toBlob((blob) => {
      if (!blob) { resolve(null); return; }
      const reader = new FileReader();
      reader.onload = () => {
        const result = reader.result as string;
        const i = result.indexOf(",");
        resolve(i >= 0 ? result.slice(i + 1) : null);
      };
      reader.onerror = () => resolve(null);
      reader.readAsDataURL(blob);
    }, "image/png");
  });
}

// Web Worker для scan вільного місця на атласі. Lazy-init — створюємо лише
// при першому виклику, перевикористовуємо для наступних. Vite автоматично
// бандлить atlas-slot.worker.ts як окремий entry.
let _slotWorker: Worker | null = null;
function getSlotWorker(): Worker | null {
  if (_slotWorker) return _slotWorker;
  try {
    _slotWorker = new Worker(new URL("./atlas-slot.worker.ts", import.meta.url), { type: "module" });
    return _slotWorker;
  } catch {
    return null;
  }
}
async function findFreeSlot(
  alpha: Uint8Array, width: number, height: number, needW: number, needH: number,
): Promise<{ foundX: number; foundY: number }> {
  const w = getSlotWorker();
  if (!w) return findFreeSlotSync(alpha, width, height, needW, needH);
  return new Promise((resolve) => {
    const handler = (e: MessageEvent) => {
      w.removeEventListener("message", handler);
      resolve({ foundX: e.data.x, foundY: e.data.y });
    };
    w.addEventListener("message", handler);
    w.postMessage({ alpha, width, height, needW, needH }, [alpha.buffer]);
  });
}
function findFreeSlotSync(
  alpha: Uint8Array, width: number, height: number, needW: number, needH: number,
): { foundX: number; foundY: number } {
  const rowFree = new Uint16Array(width * height);
  for (let y = 0; y < height; y++) {
    let run = 0;
    const rs = y * width;
    for (let x = width - 1; x >= 0; x--) {
      run = alpha[rs + x] === 0 ? (run < 65535 ? run + 1 : 65535) : 0;
      rowFree[rs + x] = run;
    }
  }
  for (let y = height - needH; y >= 0; y -= 4) {
    for (let x = 0; x <= width - needW; x += 4) {
      let ok = true;
      for (let dy = 0; dy < needH; dy++) {
        if (rowFree[(y + dy) * width + x] < needW) { ok = false; break; }
      }
      if (ok) return { foundX: x, foundY: y };
    }
  }
  return { foundX: -1, foundY: -1 };
}

export const useTglFontsStore = create<State>((set, get) => ({
  items: [],
  baseFolder: null,
  loading: false,
  error: null,
  lastDebug: null,
  active: null,
  parsed: null,
  atlasBase64: null,
  atlasW: 0,
  atlasH: 0,
  dirty: false,
  rev: 0,
  loadedFont: null,
  setLoadedFont(font) { set({ loadedFont: font }); },

  async init() {
    set({ loading: true, error: null });
    try {
      const r: any = await window.dp2.tglFontsList();
      if (r.error) set({ error: localizeBackendError(r.error) });
      set({ items: r.items ?? [], baseFolder: r.baseFolder ?? null, loading: false, lastDebug: r.debug ?? null });
    } catch (e: any) {
      set({ loading: false, error: String(e?.message ?? e) });
    }
  },

  async selectFont(it) {
    set({ active: it, parsed: null, atlasBase64: null, atlasW: 0, atlasH: 0, dirty: false, loading: true, error: null });
    try {
      const j: any = await window.dp2.tglFontsReadJson(it.jsonPath);
      if (!j.ok) throw new Error(j.error || "read json fail");
      // Main process тепер парсить у heavy-worker і повертає { raw, data,
      // charsSection } — щоб не блокувати renderer на JSON.parse 11MB.
      // Fallback на `content` зберігаємо для сумісності.
      let parsed: ParsedFont;
      if (j.raw && j.data) {
        parsed = wrapParsedFont(j.raw as string, j.data as FontDump, j.charsSection ?? null);
      } else if (j.content) {
        parsed = parseFontJson(j.content as string);
      } else {
        throw new Error("worker повернув порожній результат");
      }
      let atlasBase64: string | null = null;
      if (it.atlasPath) {
        const a = await window.dp2.tglFontsReadAtlasBase64(it.atlasPath);
        if (a.ok && a.base64) atlasBase64 = a.base64;
      }
      set({ parsed, atlasBase64, loading: false, dirty: false, rev: get().rev + 1 });
    } catch (e: any) {
      set({ loading: false, error: String(e?.message ?? e) });
    }
  },

  setAtlasSize(w, h) {
    if (w > 0 && h > 0 && (w !== get().atlasW || h !== get().atlasH)) {
      set({ atlasW: w, atlasH: h, rev: get().rev + 1 });
    }
  },

  async saveJson() {
    const { active, parsed } = get();
    if (!active || !parsed) return { ok: false, error: t("tglFonts.err.notSelected") };
    const content = serializeFontJson(parsed);
    const r = await window.dp2.tglFontsWriteJson({ jsonPath: active.jsonPath, content });
    if (r.ok) set({ dirty: false });
    return r;
  },

  async saveAtlas() {
    const { active, atlasBase64 } = get();
    if (!active?.atlasPath || !atlasBase64) return { ok: false, error: t("tglFonts.err.noAtlas") };
    return await window.dp2.tglFontsWriteAtlasBase64({ pngPath: active.atlasPath, base64: atlasBase64 });
  },

  async saveAtlasFromBase64(b64) {
    const { active } = get();
    if (!active?.atlasPath) return { ok: false, error: t("tglFonts.err.noAtlasPath") };
    const r = await window.dp2.tglFontsWriteAtlasBase64({ pngPath: active.atlasPath, base64: b64 });
    if (r.ok) set({ atlasBase64: b64, rev: get().rev + 1 });
    return r;
  },

  updateGlyph(index, patch) {
    const { parsed } = get();
    if (!parsed) return;
    const g = parsed.glyphsByIndex.get(index);
    if (!g) return;
    if (patch.uv) g.uv = { ...g.uv, ...patch.uv };
    if (patch.vert) g.vert = { ...g.vert, ...patch.vert };
    if (typeof patch.advance === "number") g.advance = patch.advance;
    if (typeof patch.flipped === "boolean") g.flipped = patch.flipped;
    set({ dirty: true, rev: get().rev + 1 });
  },

  addGlyph(g) {
    const { parsed } = get();
    if (!parsed) return;
    if (parsed.glyphsByIndex.has(g.index)) return;
    parsed.data.m_CharacterRects.Array.push(g);
    parsed.data.m_CharacterRects.Array.sort((a, b) => a.index - b.index);
    parsed.glyphsByIndex.set(g.index, g);
    set({ dirty: true, rev: get().rev + 1 });
  },

  removeGlyph(index) {
    const { parsed, atlasBase64, atlasW, atlasH, active } = get();
    if (!parsed) return;
    const arr = parsed.data.m_CharacterRects.Array;
    const i = arr.findIndex((x) => x.index === index);
    if (i < 0) return;
    const g = arr[i];
    arr.splice(i, 1);
    parsed.glyphsByIndex.delete(index);
    set({ dirty: true, rev: get().rev + 1 });
    // Якщо є атлас — затираємо ділянку прозорим прямокутником.
    if (!atlasBase64 || !atlasW || !atlasH || !active?.atlasPath) return;
    const sx = Math.round(g.uv.x * atlasW);
    const sw = Math.round(g.uv.width * atlasW);
    const top = Math.round((1 - g.uv.y) * atlasH);
    const sh = Math.round(Math.abs(g.uv.height) * atlasH);
    if (sw <= 0 || sh <= 0) return;
    const img = new Image();
    img.onload = async () => {
      const c = document.createElement("canvas");
      c.width = atlasW; c.height = atlasH;
      const ctx = c.getContext("2d")!;
      ctx.drawImage(img, 0, 0);
      ctx.clearRect(sx, top, sw, sh);
      // canvas.toBlob є async (через PNG-encoder у браузерному pool),
      // не блокує main thread на відміну від toDataURL (синхронний).
      const b64 = await canvasToBase64(c);
      if (!b64) return;
      window.dp2.tglFontsWriteAtlasBase64({ pngPath: active.atlasPath!, base64: b64 })
        .then(() => set({ atlasBase64: b64, rev: get().rev + 1 }))
        .catch(() => {});
    };
    img.src = `data:image/png;base64,${atlasBase64}`;
  },

  copyFromGlyph(toIndex, fromIndex) {
    const { parsed } = get();
    if (!parsed) return;
    const from = parsed.glyphsByIndex.get(fromIndex);
    const to = parsed.glyphsByIndex.get(toIndex);
    if (!from) return;
    const attrs = cloneGlyphAttributes(from);
    if (to) {
      Object.assign(to, attrs);
    } else {
      const ng = { index: toIndex, ...attrs };
      parsed.data.m_CharacterRects.Array.push(ng);
      parsed.data.m_CharacterRects.Array.sort((a, b) => a.index - b.index);
      parsed.glyphsByIndex.set(toIndex, ng);
    }
    set({ dirty: true, rev: get().rev + 1 });
  },

  async addGlyphFromBitmap({ targetCp, bitmap, vert, advance }) {
    const { parsed, atlasBase64, atlasW, atlasH, active } = get();
    if (!parsed || !active?.atlasPath) return { ok: false, reason: t("tglFonts.err.notLoaded") };
    if (parsed.glyphsByIndex.has(targetCp)) return { ok: false, reason: t("tglFonts.err.alreadyExists") };
    if (!atlasBase64 || atlasW === 0 || atlasH === 0) return { ok: false, reason: t("tglFonts.err.atlasNotReady") };
    const w = bitmap.width;
    const h = bitmap.height;
    // 1) Завантажити поточний атлас у canvas.
    const atlasImg = new Image();
    await new Promise<void>((res, rej) => {
      atlasImg.onload = () => res();
      atlasImg.onerror = () => rej(new Error("atlas load fail"));
      atlasImg.src = `data:image/png;base64,${atlasBase64}`;
    });
    const ac = document.createElement("canvas");
    ac.width = atlasW; ac.height = atlasH;
    const actx = ac.getContext("2d")!;
    actx.drawImage(atlasImg, 0, 0);
    // 2) Знайти вільне місце (alpha=0 у КОЖНОМУ пікселі ділянки).
    // Раніше я перевіряв з stride=4 — це пропускало alpha=0 ВСЕРЕДИНІ
    // справжніх гліфів (середина "О", "Ш"), і алгоритм думав, що там
    // вільно. Тепер scan кожного пікселя, плюс прискорений summed-area
    // підрахунок для row-by-row перевірки.
    const PAD = 2;
    const need = { w: w + PAD * 2, h: h + PAD * 2 };
    const imgData = actx.getImageData(0, 0, atlasW, atlasH).data;
    // Виносимо scan 16M пікселів у Web Worker — це звільняє main thread на
    // 500-1500ms при додаванні гліфа. Передаємо ЛИШЕ alpha-канал (Transferable),
    // зменшуючи payload з 4× до 1×.
    const alpha = new Uint8Array(atlasW * atlasH);
    for (let i = 0, j = 3; i < alpha.length; i++, j += 4) alpha[i] = imgData[j];
    const { foundX, foundY } = await findFreeSlot(alpha, atlasW, atlasH, need.w, need.h);
    if (foundX < 0) return { ok: false, reason: t("tglFonts.err.noFreeSlot") };
    // 3) Малюємо bitmap з Y-flip — інші гліфи у TGL зберігають негативний
    // uv.height, тож рушій рендерить їх "догори" (Unity Y-up). Якщо малюємо
    // як є (Y-down PNG), гра показує літеру догори дриґом. Робимо Y-flip
    // через тимчасовий canvas.
    const flipC = document.createElement("canvas");
    flipC.width = w; flipC.height = h;
    const flipCtx = flipC.getContext("2d")!;
    flipCtx.translate(0, h);
    flipCtx.scale(1, -1);
    flipCtx.drawImage(bitmap, 0, 0);
    actx.drawImage(flipC, foundX + PAD, foundY + PAD);
    // 4) Експорт назад у base64 через async toBlob (не блокує main thread).
    const newB64 = await canvasToBase64(ac);
    if (!newB64) return { ok: false, reason: "PNG encode fail" };
    // 5) Запис у файл.
    const r = await window.dp2.tglFontsWriteAtlasBase64({ pngPath: active.atlasPath, base64: newB64 });
    if (!r.ok) return { ok: false, reason: r.error || "write atlas fail" };
    // 6) uv у Unity: y від низу. top_y_png = foundY + PAD; uv.y = 1 - top/H.
    const sx = foundX + PAD;
    const sy = foundY + PAD;
    const uv = {
      x: sx / atlasW,
      y: (atlasH - sy) / atlasH,
      width: w / atlasW,
      height: -h / atlasH,
    };
    const newGlyph: FontGlyph = { index: targetCp, uv, vert: { ...vert }, advance, flipped: false };
    parsed.data.m_CharacterRects.Array.push(newGlyph);
    parsed.data.m_CharacterRects.Array.sort((a, b) => a.index - b.index);
    parsed.glyphsByIndex.set(targetCp, newGlyph);
    set({ atlasBase64: newB64, dirty: true, rev: get().rev + 1 });
    return { ok: true };
  },

  normalizeCyrillicNow() {
    const { parsed } = get();
    if (!parsed) return null;
    const stats = normalizeCyrillic(parsed);
    if (stats.touched > 0) set({ dirty: true, rev: get().rev + 1 });
    return stats;
  },

  importMetricsFromFontFace(fontFamily, scope) {
    const { parsed } = get();
    if (!parsed) return { touched: 0, skipped: 0 };
    const fontSize = parsed.data.m_FontSize || 30;
    const c = document.createElement("canvas");
    c.width = 256; c.height = 64;
    const ctx = c.getContext("2d")!;
    ctx.font = `${fontSize}px "${fontFamily}"`;
    ctx.textBaseline = "alphabetic";

    // Pre-filter за scope, щоб не платити cost-of-call для пропущених.
    const arr = parsed.data.m_CharacterRects.Array;
    let touched = 0;
    let skipped = 0;
    for (let i = 0; i < arr.length; i++) {
      const g = arr[i];
      const cp = g.index;
      if (scope === "cyrillic" && (cp < 0x0400 || cp > 0x052F)) continue;
      if (scope === "latin" && (cp < 0x0020 || cp > 0x024F)) continue;
      const ch = String.fromCodePoint(cp);
      try {
        const m = ctx.measureText(ch);
        const right = m.actualBoundingBoxRight ?? 0;
        if (right > 0 && m.width > 0) {
          // Зберігаємо округлені значення у самому об'єкті — менше алокацій
          // ніж `{ ...g.vert, x: ... }` для 8K гліфів.
          g.advance = Math.max(0, Math.round(m.width));
          g.vert.x = Math.round(-(m.actualBoundingBoxLeft ?? 0));
          touched++;
        } else {
          skipped++;
        }
      } catch { skipped++; }
    }
    if (touched > 0) set({ dirty: true, rev: get().rev + 1 });
    return { touched, skipped };
  },
}));
