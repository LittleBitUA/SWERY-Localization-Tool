// The Good Life localization binary — unpack/pack tool (TXT workflow).
//
//   node scripts/tgl-pack.cjs unpack <bin>               → writes <bin>.txt
//   node scripts/tgl-pack.cjs unpack <bin> <out.txt>
//   node scripts/tgl-pack.cjs pack <bin-template> <in.txt> [out-bin]
//
// Bin format:  uint32 LE count, then for each record:
//              uint64 LE key, 7-bit-encoded UTF-8 byte length, UTF-8 bytes.
//
// TXT format:  UTF-8 (no BOM), CRLF line endings, one record per line.
//              Inside a record:  \  → \\   CR → \r   LF → \n
//              (matches the format used by Parser_loc_GoodLife.exe.)

const fs = require("node:fs");

// ───── bin codec ─────

function read7BitInt(buf, off) {
  // Multiplication замість `<<` — для shift>=28 bitwise зсув коерсить
  // у signed int32 і ламає старші біти.
  let val = 0, shift = 0, p = off;
  while (true) {
    if (p >= buf.length) throw new Error(`7-bit read past EOF at ${off}`);
    const b = buf[p++];
    val += (b & 0x7f) * 2 ** shift;
    if ((b & 0x80) === 0) break;
    shift += 7;
    if (shift > 35) throw new Error(`7-bit int too long at ${off}`);
  }
  return { value: val, next: p };
}

function write7BitInt(out, val) {
  if (val < 0) throw new Error(`negative length ${val}`);
  while (val >= 0x80) { out.push((val & 0x7f) | 0x80); val = val >>> 7; }
  out.push(val & 0x7f);
}

function keyHexFromU64(buf, off) {
  const lo = buf.readUInt32LE(off);
  const hi = buf.readUInt32LE(off + 4);
  return (BigInt(hi) << 32n | BigInt(lo)).toString(16).padStart(16, "0");
}

function decodeBin(file) {
  const buf = fs.readFileSync(file);
  const count = buf.readUInt32LE(0);
  let off = 4;
  const records = [];
  for (let i = 0; i < count; i++) {
    const key = keyHexFromU64(buf, off); off += 8;
    const li = read7BitInt(buf, off); off = li.next;
    const text = buf.slice(off, off + li.value).toString("utf8");
    off += li.value;
    records.push({ i, key, en: text });
  }
  if (off !== buf.length) {
    throw new Error(`Trailing bytes: parsed ${off}, file ${buf.length}`);
  }
  return { records, originalSize: buf.length };
}

function encodeBin(records) {
  let total = 4;
  const enc = new Array(records.length);
  for (let i = 0; i < records.length; i++) {
    const utf = Buffer.from(records[i].text, "utf8");
    const lenBytes = [];
    write7BitInt(lenBytes, utf.length);
    enc[i] = { keyHex: records[i].key, lenBytes, utf };
    total += 8 + lenBytes.length + utf.length;
  }
  const out = Buffer.allocUnsafe(total);
  out.writeUInt32LE(records.length, 0);
  let off = 4;
  for (const e of enc) {
    const key = BigInt("0x" + e.keyHex);
    out.writeUInt32LE(Number(key & 0xffffffffn), off);
    out.writeUInt32LE(Number((key >> 32n) & 0xffffffffn), off + 4);
    off += 8;
    for (const b of e.lenBytes) out[off++] = b;
    e.utf.copy(out, off);
    off += e.utf.length;
  }
  return out;
}

// ───── txt codec ─────

function escapeForTxt(s) {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === "\\") out += "\\\\";
    else if (ch === "\r") out += "\\r";
    else if (ch === "\n") out += "\\n";
    else out += ch;
  }
  return out;
}

function unescapeFromTxt(s) {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === "\\" && i + 1 < s.length) {
      const nxt = s[i + 1];
      if (nxt === "\\") { out += "\\"; i++; }
      else if (nxt === "r") { out += "\r"; i++; }
      else if (nxt === "n") { out += "\n"; i++; }
      else { out += ch; }
    } else {
      out += ch;
    }
  }
  return out;
}

function recordsToTxt(records) {
  // CRLF separator, no trailing CRLF (matches the foreign parser's output).
  return records.map((r) => escapeForTxt(r.en ?? r.text ?? "")).join("\r\n");
}

function txtToLines(txt) {
  // Accept LF or CRLF in case the user edited the file in a Unix-y tool.
  // Strip optional BOM.
  if (txt.charCodeAt(0) === 0xfeff) txt = txt.slice(1);
  // Drop a single trailing newline so we don't get a phantom empty record.
  if (txt.endsWith("\r\n")) txt = txt.slice(0, -2);
  else if (txt.endsWith("\n")) txt = txt.slice(0, -1);
  return txt.split(/\r\n|\r|\n/);
}

// ───── commands ─────

function unpack(binPath, outPath) {
  const { records } = decodeBin(binPath);
  const dest = outPath ?? binPath + ".txt";
  const body = recordsToTxt(records.map((r) => ({ en: r.en })));
  fs.writeFileSync(dest, body, "utf8");
  console.log(`Unpacked ${records.length} records → ${dest} (${Buffer.byteLength(body)} bytes)`);
  return dest;
}

function pack(binTemplate, txtPath, outPath) {
  const { records: orig, originalSize } = decodeBin(binTemplate);
  const raw = fs.readFileSync(txtPath, "utf8");
  const lines = txtToLines(raw);
  if (lines.length !== orig.length) {
    throw new Error(`Line count mismatch: bin=${orig.length} txt=${lines.length} (file: ${txtPath})`);
  }

  let translated = 0;
  const packed = new Array(orig.length);
  for (let i = 0; i < orig.length; i++) {
    const line = unescapeFromTxt(lines[i]);
    if (line !== orig[i].en) translated++;
    packed[i] = { key: orig[i].key, text: line };
  }

  const dest = outPath ?? binTemplate;
  if (dest === binTemplate) {
    const bak = binTemplate + ".bak";
    if (!fs.existsSync(bak)) {
      fs.copyFileSync(binTemplate, bak);
      console.log(`Backup → ${bak}`);
    } else {
      console.log(`Backup exists, keeping → ${bak}`);
    }
  }

  const buf = encodeBin(packed);
  fs.writeFileSync(dest, buf);
  console.log(`Packed ${packed.length} records (${translated} differ from original) → ${dest}`);
  console.log(`Size: ${buf.length.toLocaleString()} bytes  (original ${originalSize.toLocaleString()})`);
  return dest;
}

function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === "unpack") {
    const [bin, out] = rest;
    if (!bin) throw new Error("usage: unpack <bin> [out.txt]");
    unpack(bin, out);
  } else if (cmd === "pack") {
    const [bin, txt, out] = rest;
    if (!bin || !txt) throw new Error("usage: pack <bin-template> <in.txt> [out-bin]");
    pack(bin, txt, out);
  } else {
    console.error("Commands:");
    console.error("  node scripts/tgl-pack.cjs unpack <bin> [out.txt]");
    console.error("  node scripts/tgl-pack.cjs pack <bin-template> <in.txt> [out-bin]");
    process.exit(2);
  }
}

main();

module.exports = { decodeBin, encodeBin, escapeForTxt, unescapeFromTxt, recordsToTxt, txtToLines };
