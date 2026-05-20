// Batch-тест парсера на всіх .dat у теці. Перевіряє:
//   1. msgBase з імені файлу збігається з тим, що у header offset 0x38.
//   2. Round-trip parse→serialize дає байт-ідентичний m_Script.
//   3. Виводить counts (stringCount, stringCount2) — щоб побачити які файли
//      мають другу секцію (там зазвичай живуть діалоги).
//
// Запуск: node scripts/missing-msg-test-batch.cjs <dir>
const fs = require("fs");
const path = require("path");

const UTF8 = new TextDecoder("utf-8");

function stripUnityWrap(raw) {
  if (raw.length >= 4 && raw[0] === 0x4D && raw[1] === 0x53 && raw[2] === 0x47 && raw[3] === 0x2E) {
    return { name: "", script: raw };
  }
  const v = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  const nameLen = v.getUint32(0, true);
  const name = UTF8.decode(raw.subarray(4, 4 + nameLen));
  const padded = ((4 + nameLen) + 3) & ~3;
  const scriptLen = v.getUint32(padded, true);
  return { name, script: raw.subarray(padded + 4, padded + 4 + scriptLen) };
}

function readCString(buf, pos) {
  let end = pos;
  while (end < buf.length && buf[end] !== 0) end++;
  return UTF8.decode(buf.subarray(pos, end));
}

function parseMsg(raw) {
  const { name, script } = stripUnityWrap(raw);
  const v = new DataView(script.buffer, script.byteOffset, script.byteLength);
  const h = {
    lengthTableOffset: v.getUint32(0x0C, true),
    stringOffsetTable: v.getUint32(0x10, true),
    stringBase: v.getUint32(0x14, true),
    stringOffsetTable2: v.getUint32(0x18, true),
    stringBase2: v.getUint32(0x1C, true),
    lengthCount: v.getUint32(0x2C, true),
    stringCount: v.getUint32(0x30, true),
    stringCount2: v.getUint32(0x34, true),
    msgBase: v.getUint32(0x38, true),
  };
  function readSection(offsetTable, base, count) {
    const out = [];
    for (let i = 0; i < count; i++) {
      const localOffset = v.getInt32(offsetTable + 4 * i, true);
      const absOffset = base + localOffset;
      const text = absOffset >= 0 && absOffset < script.length ? readCString(script, absOffset) : "";
      out.push({ index: i, offset: absOffset, localOffset, text });
    }
    return out;
  }
  return {
    name, script, header: h,
    entries: readSection(h.stringOffsetTable, h.stringBase, h.stringCount),
    entries2: h.stringCount2 > 0 ? readSection(h.stringOffsetTable2, h.stringBase2, h.stringCount2) : [],
  };
}

function buildMsg(orig, edits) {
  const enc = new TextEncoder();
  const src = orig.script;
  const h = orig.header;
  const newStrings = orig.entries.map((e, i) => {
    const txt = edits.has(i) ? edits.get(i) : e.text;
    const utf8 = enc.encode(txt);
    const out = new Uint8Array(utf8.length + 1);
    out.set(utf8, 0);
    return out;
  });
  const newLocalOffsets = [];
  let cursor = 0;
  for (const s of newStrings) { newLocalOffsets.push(cursor); cursor += s.length; }
  const newBlobLen = cursor;
  const padded = (newBlobLen + 0xF) & ~0xF;
  const padding = padded - newBlobLen;
  const newStringBase2 = h.stringBase + padded;
  const tail = src.subarray(h.stringBase2);
  const finalSize = h.stringBase + padded + tail.length;
  const out = new Uint8Array(finalSize);
  out.set(src.subarray(0, h.stringBase), 0);
  const ov = new DataView(out.buffer, out.byteOffset, out.byteLength);
  for (let i = 0; i < h.stringCount; i++) {
    ov.setInt32(h.stringOffsetTable + 4 * i, newLocalOffsets[i], true);
  }
  let pos = h.stringBase;
  for (const s of newStrings) { out.set(s, pos); pos += s.length; }
  pos += padding;
  out.set(tail, newStringBase2);
  ov.setUint32(0x1C, newStringBase2, true);
  for (let li = 0; li < h.lengthCount; li++) {
    const recOff = h.lengthTableOffset + li * 16;
    const id = ov.getInt32(recOff, true);
    if (id >= 0 && id < h.stringCount) {
      const len = newStrings[id].length - 1;
      ov.setInt16(recOff + 4, len & 0xFFFF, true);
    }
  }
  return out;
}

function bytesEqual(a, b) {
  if (a.length !== b.length) return -2;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return i;
  return -1;
}

function main() {
  const dir = process.argv[2] || "E:/missing";
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".dat"));
  const results = [];
  for (const f of files) {
    const raw = new Uint8Array(fs.readFileSync(path.join(dir, f)));
    let p;
    try { p = parseMsg(raw); } catch (e) { results.push({ f, error: e.message }); continue; }
    const filenameMsg = parseInt(f.match(/msg(\d{4})/)[1], 10);
    const headerMsg = p.header.msgBase;
    const rebuilt = buildMsg(p, new Map());
    const diff = bytesEqual(p.script, rebuilt);
    results.push({
      f,
      size: raw.length,
      filenameMsg,
      headerMsg,
      msgMatch: filenameMsg === headerMsg,
      str1: p.entries.length,
      str2: p.entries2.length,
      lenTbl: p.header.lengthCount,
      roundTrip: diff === -1 ? "OK" : `DIFF@${diff === -2 ? "size" : "0x" + diff.toString(16)}`,
    });
  }
  // Колонки фіксованої ширини для зручного читання.
  console.log("file                                                 size   msg→head  str1  str2  lenTbl  roundtrip");
  console.log("─".repeat(115));
  for (const r of results) {
    if (r.error) { console.log(`${r.f}: ERROR ${r.error}`); continue; }
    console.log(
      `${r.f.padEnd(48)} ${String(r.size).padStart(6)}  ${String(r.filenameMsg).padStart(4)}→${String(r.headerMsg).padStart(4)} ${r.msgMatch ? "✓" : "✗"}  ${String(r.str1).padStart(4)}  ${String(r.str2).padStart(4)}  ${String(r.lenTbl).padStart(5)}   ${r.roundTrip}`
    );
  }
  const allOk = results.every((r) => !r.error && r.roundTrip === "OK" && r.msgMatch);
  console.log("─".repeat(115));
  console.log(allOk ? `ALL ${results.length} files: OK round-trip + msg-base matches` : `Some files have issues`);
}

main();
