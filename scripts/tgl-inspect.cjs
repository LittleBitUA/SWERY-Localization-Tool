// One-shot inspector for The Good Life localization binary.
// Usage: node scripts/tgl-inspect.cjs <path-to-locale-file>

const fs = require("node:fs");

const TAG_PATTERNS = [
  { name: '[c="..."]...[/c]', re: /\[c="[^"]*"\][\s\S]*?\[\/c\]/g },
  { name: "[b]...[/b]", re: /\[b\][\s\S]*?\[\/b\]/g },
  { name: "[i]...[/i]", re: /\[i\][\s\S]*?\[\/i\]/g },
  { name: "[f1]...[/f1]", re: /\[f1\][\s\S]*?\[\/f1\]/g },
  { name: "[f2]...[/f2]", re: /\[f2\][\s\S]*?\[\/f2\]/g },
  { name: "[f3]...[/f3]", re: /\[f3\][\s\S]*?\[\/f3\]/g },
  { name: "[f4]...[/f4]", re: /\[f4\][\s\S]*?\[\/f4\]/g },
  { name: "[f5]...[/f5]", re: /\[f5\][\s\S]*?\[\/f5\]/g },
  { name: '[shop="..."/]', re: /\[shop="[^"]*"\/\]/g },
  { name: '[fragrance="..."/]', re: /\[fragrance="[^"]*"\/\]/g },
  { name: '[control="..."/]', re: /\[control="[^"]*"\/\]/g },
  { name: "\\control{NN}", re: /\\control\{[^}]+\}/g },
  { name: "{N}", re: /\{\d+\}/g },
];
const CATCHALL = /\[[^\]]+\]|\\[a-z]+\{[^}]*\}|\{\d+\}/gi;

function read7BitInt(buf, off) {
  let val = 0;
  let shift = 0;
  let p = off;
  while (true) {
    if (p >= buf.length) throw new Error(`7-bit read past EOF at ${off}`);
    const b = buf[p++];
    val |= (b & 0x7f) << shift;
    if ((b & 0x80) === 0) break;
    shift += 7;
    if (shift > 35) throw new Error(`7-bit int too long at ${off}`);
  }
  return { value: val, next: p };
}

function hexU64LE(buf, off) {
  const lo = buf.readUInt32LE(off);
  const hi = buf.readUInt32LE(off + 4);
  return (BigInt(hi) << 32n | BigInt(lo)).toString(16).padStart(16, "0");
}

function parse(file) {
  const buf = fs.readFileSync(file);
  const size = buf.length;
  const count = buf.readUInt32LE(0);
  let off = 4;
  const records = [];
  const keysSeen = new Set();
  let dupKeys = 0;
  let emptyText = 0;
  let dashText = 0;
  let withCR = 0;
  let withLF = 0;
  let withCRLF = 0;
  const lengths = [];

  for (let i = 0; i < count; i++) {
    if (off + 8 > size) throw new Error(`Truncated at key ${i} off=${off}`);
    const keyHex = hexU64LE(buf, off);
    off += 8;
    const lenInfo = read7BitInt(buf, off);
    off = lenInfo.next;
    const byteLen = lenInfo.value;
    if (off + byteLen > size) {
      throw new Error(`Truncated text body at #${i}, need ${byteLen} have ${size - off}`);
    }
    const text = buf.slice(off, off + byteLen).toString("utf8");
    off += byteLen;
    records.push({ i, keyHex, byteLen, text });
    if (keysSeen.has(keyHex)) dupKeys++; else keysSeen.add(keyHex);
    if (text.length === 0) emptyText++;
    if (text.trim() === "-") dashText++;
    const hasCRLF = text.includes("\r\n");
    if (hasCRLF) withCRLF++;
    if (!hasCRLF && text.includes("\r")) withCR++;
    if (!hasCRLF && text.includes("\n")) withLF++;
    lengths.push(byteLen);
  }

  return { buf, size, count, off, records, dupKeys, emptyText, dashText, withCR, withLF, withCRLF, lengths };
}

function pct(num, den) {
  return den ? ((num / den) * 100).toFixed(2) + "%" : "—";
}

function summarizeTags(records) {
  const tagCounts = new Map();
  const knownHits = new Map();
  for (const p of TAG_PATTERNS) knownHits.set(p.name, 0);

  let totalTagged = 0;
  for (const r of records) {
    let touchedThis = false;
    for (const p of TAG_PATTERNS) {
      const m = r.text.match(p.re);
      if (m && m.length) {
        knownHits.set(p.name, knownHits.get(p.name) + m.length);
        touchedThis = true;
      }
    }
    if (touchedThis) totalTagged++;

    // Catchall — to discover unexpected tag-like fragments.
    const all = r.text.match(CATCHALL);
    if (all) {
      for (const tok of all) {
        // Skip tokens already covered by known patterns to surface only news.
        let covered = false;
        for (const p of TAG_PATTERNS) { p.re.lastIndex = 0; if (p.re.test(tok)) { covered = true; break; } }
        if (covered) continue;
        // Trim attribute values: keep tag shape ("[c=\"X\"]" → "[c=...]").
        const shape = tok
          .replace(/="[^"]*"/g, '="…"')
          .replace(/\{[^}]+\}/g, "{…}");
        tagCounts.set(shape, (tagCounts.get(shape) ?? 0) + 1);
      }
    }
  }
  return { knownHits, unknownShapes: tagCounts, totalTagged };
}

function main() {
  const arg = process.argv[2];
  if (!arg) {
    console.error("Usage: node scripts/tgl-inspect.cjs <path>");
    process.exit(2);
  }
  const r = parse(arg);

  console.log(`File: ${arg}`);
  console.log(`Size: ${r.size.toLocaleString()} bytes`);
  console.log(`Records (header): ${r.count.toLocaleString()}`);
  console.log(`Records (parsed): ${r.records.length.toLocaleString()}`);
  console.log(`Bytes consumed:   ${r.off.toLocaleString()} / ${r.size.toLocaleString()}  trailing=${r.size - r.off}`);
  console.log(`Duplicate keys:   ${r.dupKeys}`);
  console.log(`Unique texts:     ${new Set(r.records.map((x) => x.text)).size.toLocaleString()}`);
  console.log(`Empty strings:    ${r.emptyText}`);
  console.log(`"-" placeholders: ${r.dashText}`);
  console.log(`Contains CRLF:    ${r.withCRLF}`);
  console.log(`Contains LF only: ${r.withLF}`);
  console.log(`Contains CR only: ${r.withCR}`);

  const lens = r.lengths.slice().sort((a, b) => a - b);
  const sum = lens.reduce((s, x) => s + x, 0);
  const avg = sum / lens.length;
  const median = lens[Math.floor(lens.length / 2)];
  const max = lens[lens.length - 1];
  console.log(`Byte-length: min=${lens[0]} median=${median} avg=${avg.toFixed(1)} max=${max}`);

  console.log("\nFirst 8 records:");
  for (const e of r.records.slice(0, 8)) {
    const t = e.text.replace(/\r/g, "\\r").replace(/\n/g, "\\n");
    console.log(`  ${e.i} | ${e.keyHex} | len=${e.byteLen} | ${t.slice(0, 80)}`);
  }

  const { knownHits, unknownShapes, totalTagged } = summarizeTags(r.records);
  console.log(`\nRecords with at least one known tag: ${totalTagged} (${pct(totalTagged, r.records.length)})`);
  console.log("\nKnown tag occurrences:");
  for (const [name, c] of knownHits.entries()) {
    if (c > 0) console.log(`  ${name.padEnd(28)} ${c}`);
  }

  if (unknownShapes.size > 0) {
    console.log("\nUnknown tag-shaped fragments (top 30):");
    const sorted = [...unknownShapes.entries()].sort((a, b) => b[1] - a[1]).slice(0, 30);
    for (const [shape, c] of sorted) {
      console.log(`  ${String(c).padStart(5)}  ${shape}`);
    }
  }

  // Full-file round-trip: re-encode every record and compare bytes vs. original.
  const out = encode(r.records);
  const sameLen = out.length === r.size;
  const sameBytes = sameLen && out.equals(r.buf);
  console.log(`\nFull round-trip: ${sameBytes ? "BYTE-EXACT" : (sameLen ? "len ok, bytes differ" : `len differs (${out.length} vs ${r.size})`)}`);

  // Samples for newly discovered tags (not in user's known list).
  const NEW_PROBE = [
    "[randx]", "[hop]", "[distort]", "[Job]", "[stretch]", "[fade]",
    "[wavex]", "[blink]", "[randy]", "[f3]",
  ];
  console.log("\nSamples of newly-found tags (up to 2 each):");
  for (const probe of NEW_PROBE) {
    let shown = 0;
    for (const rec of r.records) {
      if (rec.text.includes(probe)) {
        const t = rec.text.replace(/\r/g, "\\r").replace(/\n/g, "\\n");
        console.log(`  ${probe.padEnd(11)} #${rec.i}  ${t.slice(0, 110)}`);
        if (++shown >= 2) break;
      }
    }
  }

  // Tag pair imbalance: opens vs closes per shape (excluding self-closing).
  const PAIRS = [
    ["[i]", "[/i]"], ["[b]", "[/b]"], ["[f1]", "[/f1]"], ["[f2]", "[/f2]"],
    ["[f3]", "[/f3]"], ["[f4]", "[/f4]"], ["[f5]", "[/f5]"],
    ["[randx]", "[/randx]"], ["[hop]", "[/hop]"], ["[distort]", "[/distort]"],
    ["[stretch]", "[/stretch]"], ["[fade]", "[/fade]"], ["[wavex]", "[/wavex]"],
    ["[blink]", "[/blink]"], ["[randy]", "[/randy]"],
  ];
  console.log("\nPair balance (opens / closes; mismatch ⇒ tag may span split or be self-closing):");
  for (const [open, close] of PAIRS) {
    let o = 0, c = 0;
    for (const rec of r.records) {
      o += (rec.text.split(open).length - 1);
      c += (rec.text.split(close).length - 1);
    }
    if (o || c) console.log(`  ${open.padEnd(11)} open=${o}  close=${c}${o !== c ? "  ⚠ mismatch" : ""}`);
  }
}

function write7BitInt(out, val) {
  while (val >= 0x80) { out.push((val & 0x7f) | 0x80); val >>>= 7; }
  out.push(val & 0x7f);
}

function encode(records) {
  const bytes = [];
  const head = Buffer.alloc(4);
  head.writeUInt32LE(records.length, 0);
  for (const b of head) bytes.push(b);
  for (const r of records) {
    const key = BigInt("0x" + r.keyHex);
    const k = Buffer.alloc(8);
    k.writeUInt32LE(Number(key & 0xffffffffn), 0);
    k.writeUInt32LE(Number((key >> 32n) & 0xffffffffn), 4);
    for (const b of k) bytes.push(b);
    const utf = Buffer.from(r.text, "utf8");
    write7BitInt(bytes, utf.length);
    for (const b of utf) bytes.push(b);
  }
  return Buffer.from(bytes);
}

function decodeAll(buf) {
  const count = buf.readUInt32LE(0);
  let off = 4;
  const records = [];
  for (let i = 0; i < count; i++) {
    const keyHex = hexU64LE(buf, off); off += 8;
    const li = read7BitInt(buf, off); off = li.next;
    const text = buf.slice(off, off + li.value).toString("utf8"); off += li.value;
    records.push({ i, keyHex, byteLen: li.value, text });
  }
  return { records, off };
}

main();
