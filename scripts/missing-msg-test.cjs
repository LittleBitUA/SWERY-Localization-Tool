// Тест парсера MSG-формату THE MISSING. CommonJS-варіант parser.ts —
// тримаємо в синхроні з src/games/missing/parser.ts. Якщо там оновиться
// логіка — допиляй і тут.
//
// Запуск:  node scripts/missing-msg-test.cjs <path-to-dat>
// Якщо без аргумента — пробує E:/msg0613en-resources.assets-821.dat.

const fs = require("fs");

const UTF8 = new TextDecoder("utf-8");

function stripUnityWrap(raw) {
  if (raw.length >= 4 && raw[0] === 0x4D && raw[1] === 0x53 && raw[2] === 0x47 && raw[3] === 0x2E) {
    return { name: "", script: raw };
  }
  const v = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  const nameLen = v.getUint32(0, true);
  if (nameLen <= 0 || nameLen > 256) throw new Error("bad nameLen=" + nameLen);
  const name = UTF8.decode(raw.subarray(4, 4 + nameLen));
  const afterName = 4 + nameLen;
  const padded = (afterName + 3) & ~3;
  const scriptLen = v.getUint32(padded, true);
  const scriptStart = padded + 4;
  return { name, script: raw.subarray(scriptStart, scriptStart + scriptLen) };
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
    sec0: v.getUint32(0x04, true),
    sec1: v.getUint32(0x08, true),
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
  const entries = readSection(h.stringOffsetTable, h.stringBase, h.stringCount);
  const entries2 = h.stringCount2 > 0
    ? readSection(h.stringOffsetTable2, h.stringBase2, h.stringCount2)
    : [];
  return { name, script, header: h, entries, entries2 };
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

function main() {
  const arg = process.argv[2] || "E:/msg0613en-resources.assets-821.dat";
  const raw = new Uint8Array(fs.readFileSync(arg));
  console.log(`[INFO] read ${arg} (${raw.length} bytes)`);

  const parsed = parseMsg(raw);
  console.log(`name=${parsed.name}  msgBase=${parsed.header.msgBase}`);
  console.log("header:", parsed.header);
  console.log(`stringCount=${parsed.entries.length}  stringCount2=${parsed.entries2.length}`);
  console.log("First 10 entries (offset is absolute within m_Script):");
  for (const e of parsed.entries.slice(0, 10)) {
    console.log(`  [${String(e.index).padStart(3)}] 0x${e.offset.toString(16).padStart(6, "0")}  ${JSON.stringify(e.text)}`);
  }
  console.log("Last 10 entries:");
  for (const e of parsed.entries.slice(-10)) {
    console.log(`  [${String(e.index).padStart(3)}] 0x${e.offset.toString(16).padStart(6, "0")}  ${JSON.stringify(e.text)}`);
  }

  // Round-trip: збираємо без правок, порівнюємо з оригінальним m_Script.
  const rebuilt = buildMsg(parsed, new Map());
  const orig = parsed.script;
  let firstDiff = -1;
  const minLen = Math.min(rebuilt.length, orig.length);
  for (let i = 0; i < minLen; i++) {
    if (rebuilt[i] !== orig[i]) { firstDiff = i; break; }
  }
  if (firstDiff === -1 && rebuilt.length === orig.length) {
    console.log(`[OK] round-trip byte-identical (${rebuilt.length} bytes)`);
  } else {
    console.log(`[DIFF] round-trip differs:`);
    console.log(`  original m_Script: ${orig.length} bytes`);
    console.log(`  rebuilt m_Script:  ${rebuilt.length} bytes`);
    if (firstDiff !== -1) {
      console.log(`  first byte diff at 0x${firstDiff.toString(16)}`);
      const hex = (b) => b.toString(16).padStart(2, "0");
      const slice = (buf, from, to) => Array.from(buf.subarray(from, to)).map(hex).join(" ");
      const f = Math.max(0, firstDiff - 16), t = Math.min(minLen, firstDiff + 16);
      console.log(`  orig:    ${slice(orig, f, t)}`);
      console.log(`  rebuilt: ${slice(rebuilt, f, t)}`);
    }
  }
}

main();
