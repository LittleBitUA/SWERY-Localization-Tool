// Dev-утиліта: імітує "вийшов новий патч гри" для тесту migration-банера у UI.
// Підмінює meta.bundles[0] на фейковий хеш АБО повертає назад. Int64-safe —
// обгортає pathId/scriptPathId/m_PathID/rid у string ПЕРЕД JSON.parse, інакше
// JavaScript truncate'ує великі числа до Double (втрата 2-3 останніх цифр).
//
// Використання:
//   node scripts/hbr-fake-patch.cjs simulate   # підміняє bundles[0] на FAKE-OLD-HASH
//   node scripts/hbr-fake-patch.cjs restore    # повертає з settings.hbrBundlePath

const fs = require("fs");
const path = require("path");
const os = require("os");

const userDocs = path.join(os.homedir(), "Documents", "SWERY-Localization-Tool");
const metaPath = path.join(userDocs, "HBR", "Text", "Meta", "hbr-meta.json");
const settingsPath = path.join(process.env.APPDATA, "SWERY Localization Tool", "settings.json");

function readInt64Safe(p) {
  const raw = fs.readFileSync(p, "utf8");
  const safe = raw
    .replace(/"(pathId|scriptPathId|m_PathID)"\s*:\s*(-?\d+)/g, '"$1":"$2"')
    .replace(/"rid"\s*:\s*(-?\d+)/g, '"rid":"$1"');
  return JSON.parse(safe);
}
function writeInt64Safe(p, obj) {
  let raw = JSON.stringify(obj, null, 2);
  raw = raw.replace(/"(pathId|scriptPathId)"\s*:\s*"(-?\d+)"/g, '"$1": $2');
  raw = raw.replace(/"m_PathID"\s*:\s*"(-?\d+)"/g, '"m_PathID": $1');
  raw = raw.replace(/"rid"\s*:\s*"(-?\d+)"/g, '"rid": $1');
  fs.writeFileSync(p, raw, "utf8");
}

function main() {
  const cmd = process.argv[2];
  if (!cmd || (cmd !== "simulate" && cmd !== "restore")) {
    console.error("usage: node hbr-fake-patch.cjs simulate|restore");
    process.exit(1);
  }
  const m = readInt64Safe(metaPath);
  console.log("Before:", m.bundles);
  if (cmd === "simulate") {
    m.bundles = ["_resources_assets_all_FAKE-OLD-HASH.bundle"];
  } else {
    // Беремо актуальний хеш з settings.hbrBundlePath
    const s = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    if (!s.hbrBundlePath) { console.error("settings.hbrBundlePath not set"); process.exit(1); }
    m.bundles = [path.basename(s.hbrBundlePath)];
  }
  writeInt64Safe(metaPath, m);
  console.log("After: ", m.bundles);
  console.log("OK — Int64 fields preserved (pathId/scriptPathId/rid all wrapped as strings before parse).");
}

main();
