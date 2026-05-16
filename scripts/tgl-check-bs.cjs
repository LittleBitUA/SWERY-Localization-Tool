// Sanity probe: does our English bin contain literal backslash characters
// in any record? Needed to know if our TXT escape strategy must round-trip "\\".
const fs = require("node:fs");

function r7(b, o) {
  let v = 0, s = 0, p = o;
  while (true) { const x = b[p++]; v |= (x & 0x7f) << s; if (!(x & 0x80)) break; s += 7; }
  return { v, n: p };
}

const bin = fs.readFileSync("F:/SteamLibrary/steamapps/common/The Good Life/StandaloneWindows64_Data/StreamingAssets/loc/English.bak");
const n = bin.readUInt32LE(0);
let o = 4;
const recs = [];
for (let i = 0; i < n; i++) {
  o += 8;
  const l = r7(bin, o); o = l.n;
  recs.push(bin.slice(o, o + l.v).toString("utf8"));
  o += l.v;
}
const bsCount = recs.filter((t) => t.includes("\\")).length;
const crCount = recs.filter((t) => t.includes("\r")).length;
const lfCount = recs.filter((t) => t.includes("\n")).length;
console.log("Total records:", recs.length);
console.log("Records with literal backslash:", bsCount);
console.log("Records with CR:", crCount);
console.log("Records with LF:", lfCount);

let shown = 0;
for (const t of recs) {
  if (t.includes("\\") && shown < 8) {
    shown++;
    console.log("  BS:", JSON.stringify(t.slice(0, 140)));
  }
}
