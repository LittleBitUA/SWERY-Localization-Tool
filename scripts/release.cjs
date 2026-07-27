#!/usr/bin/env node
// Один крок для повного релізу (локальний підписаний пайплайн):
//   npm run release -- <version> [--title "..."] [--notes-file <path>]
// Кроки: bump package.json → npm run check (tsc+i18n) → build:exe (підпис
// локальним сертифікатом) → commit → push → gh release create з .exe.
//
// Підпис лишається локальним навмисно: сертифікат живе в середовищі
// розробника, не в репо/CI. Тому білд НЕ переносимо в GitHub Actions.
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const run = (cmd, opts = {}) => execSync(cmd, { cwd: ROOT, stdio: "inherit", ...opts });
const cap = (cmd) => execSync(cmd, { cwd: ROOT }).toString().trim();
const die = (msg) => { console.error("release: " + msg); process.exit(1); };

// ── args ────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const version = argv.find((a) => /^\d+\.\d+\.\d+$/.test(a));
if (!version) die("вкажи версію: npm run release -- <x.y.z> [--title \"...\"] [--notes-file <path>]");
const titleIdx = argv.indexOf("--title");
const title = titleIdx >= 0 ? argv[titleIdx + 1] : `v${version}`;
const notesIdx = argv.indexOf("--notes-file");
const notesFile = notesIdx >= 0 ? argv[notesIdx + 1] : null;
const tag = `v${version}`;

// ── preflight ─────────────────────────────────────────────────────────────
try { cap("gh auth status"); } catch { die("gh не авторизовано (gh auth login)"); }
const branch = cap("git rev-parse --abbrev-ref HEAD");
const existingTags = cap("git tag -l").split(/\r?\n/);
if (existingTags.includes(tag)) die(`тег ${tag} вже існує`);
// gh release view виходить з ненульовим кодом, якщо релізу нема → це ок.
let remoteExists = false;
try { execSync(`gh release view ${tag} --json tagName`, { cwd: ROOT, stdio: "ignore" }); remoteExists = true; } catch { /* нема — добре */ }
if (remoteExists) die(`GitHub-реліз ${tag} вже існує`);

console.log(`\n▶ Реліз ${tag} (гілка ${branch}, заголовок «${title}»)\n`);

// ── 1. bump ─────────────────────────────────────────────────────────────
const pkgPath = path.join(ROOT, "package.json");
const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
const prev = pkg.version;
pkg.version = version;
fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
console.log(`✓ версія ${prev} → ${version}`);

// ── 2. checks ───────────────────────────────────────────────────────────
console.log("\n▶ npm run check (tsc + i18n)…");
try { run("npm run check"); }
catch { fs.writeFileSync(pkgPath, JSON.stringify({ ...pkg, version: prev }, null, 2) + "\n"); die("перевірки провалились — версію відкотив, нічого не запушено"); }

// ── 3. build ────────────────────────────────────────────────────────────
console.log("\n▶ npm run build:exe…");
run("npm run build:exe");
const exe = path.join(ROOT, "release", `SweryLocalizationTool-${version}-portable.exe`);
if (!fs.existsSync(exe)) die(`не знайдено зібраний .exe: ${exe}`);
console.log(`✓ ${path.basename(exe)}`);

// ── 4. commit + push ──────────────────────────────────────────────────────
console.log("\n▶ commit + push…");
run("git add -u");
run("git add package.json");
run(`git commit -m ${JSON.stringify(title)}`);
run(`git push origin ${branch}`);

// ── 5. GitHub release ─────────────────────────────────────────────────────
console.log("\n▶ gh release create…");
const notesArg = notesFile ? `--notes-file ${JSON.stringify(notesFile)}` : "--generate-notes";
run(`gh release create ${tag} ${JSON.stringify(exe)} --title ${JSON.stringify(title)} ${notesArg}`);

const url = cap(`gh release view ${tag} --json url --jq .url`);
console.log(`\n✅ Реліз опубліковано: ${url}`);
