// IMHeightInfo MonoBehaviour parser for THE MISSING.
//
// Структура (реверс через UnityEX-дамп `TheMISSING.UI.IM.IMHeightInfo`):
//
//   ┌─ MonoBehaviour header (44 bytes) ──────────────────────────┐
//   │ 12 bytes  m_GameObject  (PPtr<GameObject>)                 │
//   │  4 bytes  m_Enabled (UInt8) + align-to-4 pad               │
//   │ 12 bytes  m_Script (PPtr<MonoScript>)                      │
//   │  4 + 12   m_Name length + "IMHeightInfo" (no pad, 12%4=0)  │
//   └────────────────────────────────────────────────────────────┘
//   ┌─ Custom payload ───────────────────────────────────────────┐
//   │ int32  headerField  (= 9; призначення невідомо, passthrough)│
//   │ ranges[]:                                                   │
//   │   int32 len + string + align-to-4 pad                       │
//   │   (масив без явного префіксу довжини; визначаємо за межею   │
//   │    переходу: коли наступний int32 не схожий на string-len)  │
//   │ int32  entryCount                                           │
//   │ entries[entryCount]:                                        │
//   │   int32 nameLen + name (e.g. "1010061") + align-to-4        │
//   │   int32 msgEnum                                             │
//   │   int32 langCount   (= 4 у MISSING)                         │
//   │   (float w, float h) × langCount                            │
//   └────────────────────────────────────────────────────────────┘
//
// Round-trip: за нашою формулою parse → build генерує байт-у-байт ідентичний
// файл (підтверджено на справжньому IMHeightInfo з resources.assets).

const UTF8 = new TextDecoder("utf-8");
const ENC = new TextEncoder();

export interface MissingHeightEntry {
  /** Текст, наприклад "1010061" — звичайно decimal repr msgEnum. */
  name: string;
  /** Глобальний msgEnum (стабільний; той самий, що у наших msg-файлах). */
  msgEnum: number;
  /** Розміри box'у для кожної мови. У MISSING langCount=4. */
  sizes: Array<{ w: number; h: number }>;
}

export interface MissingHeightInfo {
  /** Сирий MonoBehaviour header (44 байти) — зберігаємо як є для round-trip. */
  monoHeader: Uint8Array;
  /** int32 на початку payload (значення 9 у поточній збірці; невідома роль). */
  headerField: number;
  /** Список рядків між headerField і entryCount (range markers). */
  rangeMarkers: string[];
  /** Per-msgEnum box-sizes. */
  entries: MissingHeightEntry[];
}

function readCString(buf: Uint8Array, dv: DataView, off: number): { text: string; nextOff: number } {
  const len = dv.getInt32(off, true);
  if (len < 0 || off + 4 + len > buf.length) throw new Error(`bad string len=${len} at off=0x${off.toString(16)}`);
  const text = UTF8.decode(buf.subarray(off + 4, off + 4 + len));
  const pad = (4 - (len % 4)) % 4;
  return { text, nextOff: off + 4 + len + pad };
}

export function parseMissingHeightInfo(raw: Uint8Array): MissingHeightInfo {
  if (raw.length < 50) throw new Error(`too small: ${raw.length}`);
  // MonoBehaviour header — 12 (m_GameObject) + 4 (m_Enabled padded) + 12 (m_Script) + 4 + 12 (m_Name "IMHeightInfo")
  // = 44 байт. Перевіряємо ім'я.
  const dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  const nameLen = dv.getInt32(28, true);
  if (nameLen !== 12) throw new Error(`expected m_Name length 12, got ${nameLen}`);
  const name = UTF8.decode(raw.subarray(32, 32 + 12));
  if (name !== "IMHeightInfo") throw new Error(`expected m_Name 'IMHeightInfo', got '${name}'`);

  const monoHeader = raw.subarray(0, 44).slice(); // copy
  let off = 44;
  const headerField = dv.getInt32(off, true);
  off += 4;

  // Range markers: читаємо length-prefixed strings поки len схожий на ASCII-string
  // довжину (1..16). Як тільки бачимо щось більше — це entryCount.
  const rangeMarkers: string[] = [];
  while (off + 4 <= raw.length) {
    const probe = dv.getInt32(off, true);
    if (probe < 1 || probe > 16) break;
    const r = readCString(raw, dv, off);
    rangeMarkers.push(r.text);
    off = r.nextOff;
  }

  // entryCount + entries
  const entryCount = dv.getInt32(off, true);
  off += 4;
  if (entryCount < 0 || entryCount > 100000) throw new Error(`implausible entryCount=${entryCount}`);
  const entries: MissingHeightEntry[] = [];
  for (let i = 0; i < entryCount; i++) {
    const ns = readCString(raw, dv, off);
    off = ns.nextOff;
    const msgEnum = dv.getInt32(off, true); off += 4;
    const langCount = dv.getInt32(off, true); off += 4;
    if (langCount < 0 || langCount > 16) throw new Error(`bad langCount=${langCount} at i=${i}`);
    const sizes: Array<{ w: number; h: number }> = [];
    for (let j = 0; j < langCount; j++) {
      const w = dv.getFloat32(off, true); off += 4;
      const h = dv.getFloat32(off, true); off += 4;
      sizes.push({ w, h });
    }
    entries.push({ name: ns.text, msgEnum, sizes });
  }
  return { monoHeader, headerField, rangeMarkers, entries };
}

function writeCString(out: number[], text: string) {
  const bytes = ENC.encode(text);
  const len = bytes.length;
  // int32 LE
  out.push(len & 0xff, (len >> 8) & 0xff, (len >> 16) & 0xff, (len >> 24) & 0xff);
  for (const b of bytes) out.push(b);
  const pad = (4 - (len % 4)) % 4;
  for (let i = 0; i < pad; i++) out.push(0);
}
function writeInt32(out: number[], v: number) {
  out.push(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >> 24) & 0xff);
}
function writeFloat32(out: number[], v: number) {
  const buf = new ArrayBuffer(4);
  new DataView(buf).setFloat32(0, v, true);
  const u8 = new Uint8Array(buf);
  out.push(u8[0], u8[1], u8[2], u8[3]);
}

export function buildMissingHeightInfo(info: MissingHeightInfo): Uint8Array {
  const out: number[] = [];
  // MB header passthrough
  for (const b of info.monoHeader) out.push(b);
  writeInt32(out, info.headerField);
  for (const s of info.rangeMarkers) writeCString(out, s);
  writeInt32(out, info.entries.length);
  for (const e of info.entries) {
    writeCString(out, e.name);
    writeInt32(out, e.msgEnum);
    writeInt32(out, e.sizes.length);
    for (const s of e.sizes) {
      writeFloat32(out, s.w);
      writeFloat32(out, s.h);
    }
  }
  return new Uint8Array(out);
}

/** Швидкий look-up по MsgEnum. Створюємо мапу один раз при load. */
export function buildHeightInfoIndex(info: MissingHeightInfo): Map<number, number> {
  const m = new Map<number, number>();
  for (let i = 0; i < info.entries.length; i++) m.set(info.entries[i].msgEnum, i);
  return m;
}
