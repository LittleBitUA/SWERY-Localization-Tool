'use strict';

// Heavy worker: парсинг JSON-корпусу DP1+DP2 виноситься у Node worker_threads,
// щоб не блокувати ні main, ні renderer. Завдання:
//   • 'scan-all'    — pre-flight перевірки (validate.ts)
//   • 'build-tm'    — пам'ять перекладів з обох ігор (tm.ts)
//   • 'search-all'  — глобальний пошук по корпусу (search.ts)
//
// API: parentPort приймає { id, type, payload }, відповідає { id, ok, result | error }.

const { parentPort } = require('node:worker_threads');
const fs = require('node:fs/promises');
const path = require('node:path');

if (!parentPort) {
  throw new Error('heavy-worker.cjs must be loaded as Worker');
}

// ── FS ──────────────────────────────────────────────────────────────────
async function collectJsonFiles(dir) {
  const out = [];
  let entries;
  try { entries = await fs.readdir(dir, { withFileTypes: true }); }
  catch { return out; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      try { out.push(...await collectJsonFiles(full)); } catch {}
    } else if (
      e.isFile() &&
      e.name.toLowerCase().endsWith('.json') &&
      !e.name.endsWith('.bak.json') &&
      !e.name.endsWith('.autosave.json') &&
      !e.name.endsWith('.dp-status.json') &&
      !e.name.endsWith('_ua_work.json') &&
      !e.name.endsWith('.dp2-glossary.json')
    ) {
      out.push(full);
    }
  }
  return out;
}

// ── In-memory cache ─────────────────────────────────────────────────────
// Ключ — абсолютний шлях. Значення містить mtime для валідації, raw content,
// плюс lazy-parsed tree і entries. Між тасками всі read-only операції
// (search, stats, glossary-check, name-check) тепер 0 disk-read і 0 parse,
// якщо файл не змінювався. Write-таски оновлюють кеш після запису.
const fileCache = new Map();
const CACHE_MAX = 300; // максимум файлів у кеші (LRU-eviction)

function touchLRU(fp) {
  // переміщаємо ключ у кінець — простий LRU через перевставлення
  const v = fileCache.get(fp);
  if (v) { fileCache.delete(fp); fileCache.set(fp, v); }
}

function evictIfNeeded() {
  while (fileCache.size > CACHE_MAX) {
    const oldest = fileCache.keys().next().value;
    if (!oldest) break;
    fileCache.delete(oldest);
  }
}

async function getCached(fp) {
  let stat;
  try { stat = await fs.stat(fp); } catch { return null; }
  const cur = fileCache.get(fp);
  if (cur && cur.mtime === stat.mtimeMs) {
    touchLRU(fp);
    return cur;
  }
  let content;
  try { content = await fs.readFile(fp, 'utf8'); } catch { return null; }
  const bakPath = fp.replace(/\.json$/i, '.bak.json');
  let bakContent = null;
  try { bakContent = await fs.readFile(bakPath, 'utf8'); } catch {}
  const entry = {
    path: fp,
    mtime: stat.mtimeMs,
    content,
    bakContent,
    // Лазі-парс — обчислюється на першому запиті, далі переюзаємо.
    tree: null,
    bakTree: null,
    entries: null,
  };
  fileCache.set(fp, entry);
  evictIfNeeded();
  return entry;
}

function getEntries(cached) {
  if (!cached) return null;
  if (cached.entries) return cached.entries;
  if (!cached.tree) {
    try { cached.tree = JSON.parse(cached.content); } catch { return null; }
  }
  if (cached.bakContent && !cached.bakTree) {
    try { cached.bakTree = JSON.parse(cached.bakContent); } catch {}
  }
  cached.entries = flattenDp2(cached.path, cached.tree, cached.bakTree);
  return cached.entries;
}

// Після того як task сам ЗАПИСАВ файл, оновлюємо кеш: новий content + invalidate tree/entries.
async function updateCacheAfterWrite(fp, newContent) {
  let stat;
  try { stat = await fs.stat(fp); } catch { return; }
  const existing = fileCache.get(fp);
  fileCache.set(fp, {
    path: fp,
    mtime: stat.mtimeMs,
    content: newContent,
    bakContent: existing ? existing.bakContent : null,
    tree: null,
    bakTree: null,
    entries: null,
  });
  touchLRU(fp);
}

// Зворотньо-сумісний рід: викликалось як readAllFromFolder, тепер через кеш.
async function readAllFromFolder(folder) {
  if (!folder) return [];
  const files = await collectJsonFiles(folder);
  const result = await Promise.all(files.map(getCached));
  return result.filter(Boolean);
}

// ── DP2 flatten (порт з src/lib/parser.ts) ──────────────────────────────
const LANG_JP = 0;
const LANG_EN = 1;

function flattenDp2(filePath, root, origRoot) {
  const out = [];
  const sheets = root && root.m_sheets && root.m_sheets.Array ? root.m_sheets.Array : [];
  const origSheets = origRoot && origRoot.m_sheets && origRoot.m_sheets.Array ? origRoot.m_sheets.Array : [];
  for (let sheetIndex = 0; sheetIndex < sheets.length; sheetIndex++) {
    const sheet = sheets[sheetIndex];
    const list = sheet && sheet.m_list && sheet.m_list.Array ? sheet.m_list.Array : [];
    for (let listIndex = 0; listIndex < list.length; listIndex++) {
      const item = list[listIndex];
      if (!item) continue;
      if (item.m_scenarioList) {
        const scenarios = item.m_scenarioList.Array || [];
        for (let scenarioIndex = 0; scenarioIndex < scenarios.length; scenarioIndex++) {
          const scen = scenarios[scenarioIndex];
          const sentences = (scen && scen.m_sentences && scen.m_sentences.Array) || [];
          const jp = sentences[LANG_JP];
          const en = sentences[LANG_EN];
          if (!jp && !en) continue;
          const origScen = origSheets[sheetIndex]
            && origSheets[sheetIndex].m_list
            && origSheets[sheetIndex].m_list.Array
            && origSheets[sheetIndex].m_list.Array[listIndex]
            && origSheets[sheetIndex].m_list.Array[listIndex].m_scenarioList
            && origSheets[sheetIndex].m_list.Array[listIndex].m_scenarioList.Array
            && origSheets[sheetIndex].m_list.Array[listIndex].m_scenarioList.Array[scenarioIndex];
          const origEn = origScen && origScen.m_sentences && origScen.m_sentences.Array
            && origScen.m_sentences.Array[LANG_EN];
          out.push({
            kind: 'sentence',
            filePath, sheetIndex, listIndex, scenarioIndex,
            id: (scen && scen.m_messageId) || '',
            category: (sheet && sheet.m_sheetName) || '',
            context: (item && item.m_demoId) || '',
            jp: (jp && jp.m_serif) || '',
            en: (en && en.m_serif) || '',
            originalEn: origEn ? origEn.m_serif : undefined,
            charaName: (en && en.m_charaName) || '',
            charaNameJp: (jp && jp.m_charaName) || '',
          });
        }
        continue;
      }
      if (item.m_text) {
        const arr = item.m_text.Array || [];
        if (arr.length < 2) continue;
        const origItem = origSheets[sheetIndex]
          && origSheets[sheetIndex].m_list
          && origSheets[sheetIndex].m_list.Array
          && origSheets[sheetIndex].m_list.Array[listIndex];
        const origText = origItem && origItem.m_text && origItem.m_text.Array
          ? origItem.m_text.Array[LANG_EN] : undefined;
        out.push({
          kind: 'item',
          filePath, sheetIndex, listIndex,
          id: item.m_enumName || `id_${item.m_uniqueId !== undefined ? item.m_uniqueId : listIndex}`,
          category: (sheet && sheet.m_sheetName) || '',
          context: item.m_uniqueId !== undefined ? `#${item.m_uniqueId}` : '',
          jp: arr[LANG_JP] || '',
          en: arr[LANG_EN] || '',
          originalEn: origText,
        });
      }
    }
  }
  return out;
}

const HAS_CYR = /[Ѐ-ӿ]/;
const HAS_LATIN = /[A-Za-z]/;
function isTranslated(e) {
  if (!e.originalEn) return false;
  if (e.en === e.originalEn) return false;
  // Те саме що у frontend/src/lib/parser.ts: вимагаємо реальну кирилицю,
  // щоб не ловити невидимі різниці у бекапі (пробіли/регістр/escape).
  return HAS_CYR.test(e.en);
}
function needsTranslation(e) {
  if (!e.originalEn) return false;
  return HAS_LATIN.test(e.originalEn);
}

// ── Task: build-tm ──────────────────────────────────────────────────────
async function taskBuildTm(dp2Folder, dp1EngPath) {
  const out = [];

  if (dp2Folder) {
    const all = await readAllFromFolder(dp2Folder);
    for (const f of all) {
      const entries = getEntries(f);
      if (!entries) continue;
      const fileName = (f.path.split(/[\\/]/).pop() || f.path).replace(/\.json$/i, '');
      for (const e of entries) {
        if (!isTranslated(e)) continue;
        const src = ((e.originalEn != null ? e.originalEn : e.en) || '').trim();
        const tgt = (e.en || '').trim();
        if (!src || !tgt) continue;
        out.push({
          source: 'dp2', src, tgt, jp: e.jp, filePath: f.path, fileName,
          charaName: e.charaName,
        });
      }
    }
  }

  if (dp1EngPath) {
    let engRaw;
    try { engRaw = await fs.readFile(dp1EngPath, 'utf8'); }
    catch { return out; }
    let engRecords;
    try { engRecords = JSON.parse(engRaw); } catch { return out; }
    if (!Array.isArray(engRecords)) return out;
    const donePath = dp1EngPath.replace(/\.json$/i, '_ua_done.json');
    let doneRecords = null;
    try {
      const raw = await fs.readFile(donePath, 'utf8');
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) doneRecords = parsed;
    } catch {}
    const fileName = (dp1EngPath.split(/[\\/]/).pop() || dp1EngPath).replace(/\.json$/i, '');
    const hasCyr = /[Ѐ-ӿ]/;
    for (let i = 0; i < engRecords.length; i++) {
      const er = engRecords[i] || {};
      if (er.EmptyRecord) continue;
      const src = String(er.Text != null ? er.Text : '').trim();
      const tgt = doneRecords
        ? String((doneRecords[i] && doneRecords[i].Text) != null ? doneRecords[i].Text : '').trim()
        : src;
      if (!src) continue;
      if (!tgt || tgt === src) continue;
      if (!hasCyr.test(tgt)) continue;
      out.push({
        source: 'dp1', src, tgt, jp: '', filePath: donePath || dp1EngPath, fileName,
      });
    }
  }

  return out;
}

// ── Task: corpus-stats ──────────────────────────────────────────────────
// Підрахунок агрегованих метрик готовності по всьому DP2-корпусу:
//   • кількість файлів, записів, перекладених записів, %
//   • слова та символи (окремо UA-перекладені і EN-оригінал)
//   • топ-файлів за обсягом + їх локальний прогрес
function countWords(s) {
  if (!s) return 0;
  const trimmed = s.trim();
  if (!trimmed) return 0;
  return trimmed.split(/\s+/).filter(Boolean).length;
}

async function taskCorpusStats(folder) {
  const summary = {
    files: 0,
    totalEntries: 0,
    translatedEntries: 0,
    percent: 0,
    uaWords: 0,
    enWords: 0,
    uaChars: 0,
    enChars: 0,
    topFiles: [],
  };
  if (!folder) return summary;
  const all = await readAllFromFolder(folder);
  const perFile = [];
  for (const f of all) {
    const entries = getEntries(f);
    if (!entries) continue;
    let fileTotal = 0;
    let fileTrans = 0;
    for (const e of entries) {
      fileTotal++;
      if (isTranslated(e)) {
        fileTrans++;
        const text = e.en || '';
        summary.uaWords += countWords(text);
        summary.uaChars += text.length;
      } else {
        const text = (e.originalEn != null ? e.originalEn : e.en) || '';
        summary.enWords += countWords(text);
        summary.enChars += text.length;
      }
    }
    summary.totalEntries += fileTotal;
    summary.translatedEntries += fileTrans;
    summary.files++;
    const fileName = (f.path.split(/[\\/]/).pop() || f.path).replace(/\.json$/i, '');
    perFile.push({
      fileName, filePath: f.path,
      total: fileTotal, translated: fileTrans,
      percent: fileTotal ? +(fileTrans / fileTotal * 100).toFixed(2) : 0,
    });
  }
  summary.percent = summary.totalEntries
    ? +(summary.translatedEntries / summary.totalEntries * 100).toFixed(2)
    : 0;
  // Топ-15 за обсягом — більше не вміщається у модалку без скролу.
  perFile.sort((a, b) => b.total - a.total);
  summary.topFiles = perFile.slice(0, 15);
  return summary;
}

// ── Task: glossary-consistency ──────────────────────────────────────────
// Для кожного glossary-терма перевіряємо: якщо у англ-оригіналі є `src`,
// то у перекладі (e.en) має бути `tgt`. Якщо ні — порушення.
// Логіка:
//   • Рахуємо лише ПЕРЕКЛАДЕНІ записи (isTranslated) — щоб не позначати
//     ще-не-роблене як "помилку".
//   • Пошук substring case-insensitive — простий, без морфології.
//   • Для UA-tgt свідомо НЕ робимо whole-word: словоформи (Йорк/Йорка/Йорку)
//     порушенням не вважаємо. Достатньо, щоб корінь зустрічався.
async function taskGlossaryConsistency(folder, glossary) {
  const result = {
    termResults: [],
    totals: { terms: 0, violations: 0, entriesScanned: 0, entriesTranslated: 0 },
  };
  if (!folder || !Array.isArray(glossary) || glossary.length === 0) return result;

  // Підготуємо терми: нормалізуємо й відкидаємо порожні. Пара (src, tgt)
  // має бути унікальною — на випадок дублікатів у .dp2-glossary.json.
  const terms = [];
  const seen = new Set();
  for (const g of glossary) {
    const src = String((g && g.src) || '').trim();
    const tgt = String((g && g.tgt) || '').trim();
    if (!src || !tgt) continue;
    const key = src.toLowerCase() + '' + tgt.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    terms.push({ src, tgt, srcLc: src.toLowerCase(), tgtLc: tgt.toLowerCase() });
  }
  result.totals.terms = terms.length;
  if (terms.length === 0) return result;

  const termStats = terms.map((t) => ({
    src: t.src, tgt: t.tgt,
    okCount: 0, violationCount: 0,
    violations: [],
  }));
  const MAX_VIOLATIONS_PER_TERM = 200;

  const all = await readAllFromFolder(folder);
  for (const f of all) {
    const entries = getEntries(f);
    if (!entries) continue;
    const fileName = (f.path.split(/[\\/]/).pop() || f.path).replace(/\.json$/i, '');
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      result.totals.entriesScanned++;
      if (!isTranslated(e)) continue;
      result.totals.entriesTranslated++;
      const enLc = (e.en || '').toLowerCase();
      const origLc = (e.originalEn || '').toLowerCase();
      for (let ti = 0; ti < terms.length; ti++) {
        const t = terms[ti];
        if (origLc.indexOf(t.srcLc) === -1) continue;
        const ts = termStats[ti];
        if (enLc.indexOf(t.tgtLc) !== -1) {
          ts.okCount++;
        } else {
          ts.violationCount++;
          result.totals.violations++;
          if (ts.violations.length < MAX_VIOLATIONS_PER_TERM) {
            ts.violations.push({
              filePath: f.path, fileName,
              entryIndex: i,
              entryId: e.id || '',
              kind: e.kind,
              charaName: e.charaName || '',
              originalEn: e.originalEn || '',
              en: e.en || '',
              sheetIndex: e.sheetIndex,
              listIndex: e.listIndex,
              scenarioIndex: e.kind === 'sentence' ? e.scenarioIndex : undefined,
            });
          }
        }
      }
    }
  }

  // Сортуємо за серйозністю: спершу терми з найбільшою кількістю порушень.
  termStats.sort((a, b) => b.violationCount - a.violationCount || a.src.localeCompare(b.src));
  result.termResults = termStats;
  return result;
}

// ── Smart subtitle break (CJS-порт src/lib/subtitleFormat.ts) ──────────
const SB_SHORT_LEADING = new Set([
  'і','й','а','в','у','з','на','до','по','за','при','від','для','без','та',
  'як','що','не','чи','бо','is','to','of','in','on','at','a','an','the','or','if',
]);
const SB_PUNCT_END = new Set(['.', ',', '!', '?', ';', ':', '—', '–']);
function sbIsShortLeading(w) {
  const c = w.replace(/[.,!?:;—–-]+$/u, '').toLowerCase();
  return SB_SHORT_LEADING.has(c);
}
function sbEndsWithPunct(w) {
  return !!w && SB_PUNCT_END.has(w[w.length - 1]);
}
function smartBreakLine(line, maxLine) {
  const flat = String(line || '').replace(/[ \t]+/g, ' ').trim();
  if (!flat || flat.length <= maxLine) return flat;
  const words = flat.split(' ');
  if (words.length < 2) return flat;
  const n = words.length;
  const cum = [0];
  for (let k = 0; k < n; k++) cum.push(cum[k] + words[k].length);
  const total = cum[n];
  let bestI = -1, bestScore = Infinity;
  for (let i = 0; i < n - 1; i++) {
    const l1 = cum[i+1] + i;
    const l2 = (total - cum[i+1]) + (n - i - 2);
    if (l1 > maxLine || l2 > maxLine) continue;
    let s = Math.abs(l1 - l2);
    if (sbEndsWithPunct(words[i])) s -= 12;
    if (sbIsShortLeading(words[i])) s += 15;
    if (s < bestScore) { bestScore = s; bestI = i; }
  }
  if (bestI >= 0) {
    return words.slice(0, bestI+1).join(' ') + '\n' + words.slice(bestI+1).join(' ');
  }
  const lines = [];
  let cur = '';
  for (const w of words) {
    const nx = cur ? cur + ' ' + w : w;
    if (nx.length > maxLine && cur) { lines.push(cur); cur = w; }
    else cur = nx;
  }
  if (cur) lines.push(cur);
  return lines.join('\n');
}

function smartBreak(text, maxLine) {
  maxLine = maxLine || 38;
  if (!text) return text;
  // Зберігаємо leading/trailing \n.
  let leading = 0;
  let middle = String(text);
  while (middle.startsWith('\n')) { leading++; middle = middle.slice(1); }
  let trailing = 0;
  while (middle.endsWith('\n')) { trailing++; middle = middle.slice(0, -1); }
  if (!middle) return text;
  // Параграфи відокремлені порожніми рядками — обробляються незалежно.
  // Якщо параграф уже має свій \n — це навмисний поділ юзера, не чіпаємо.
  const paragraphs = middle.split(/\n{2,}/);
  const rebuilt = paragraphs.map((p) =>
    p.includes('\n') ? p : smartBreakLine(p, maxLine)
  );
  return '\n'.repeat(leading) + rebuilt.join('\n\n') + '\n'.repeat(trailing);
}

// ── Task: smart-break-all ─────────────────────────────────────────────
// Драбинка для всіх перекладених рядків у корпусі. Dry-run / apply.
async function taskSmartBreakAll(folder, opts) {
  const result = { files: [], totalEntries: 0, totalChanges: 0 };
  if (!folder) return result;
  const maxLine = (opts && opts.maxLine) || 38;
  const dryRun = !(opts && opts.dryRun === false);
  const fs2 = require('node:fs/promises');
  const all = await readAllFromFolder(folder);
  for (const f of all) {
    let tree;
    try { tree = JSON.parse(f.content); } catch { continue; }
    let bakTree = null;
    if (f.bakContent) { try { bakTree = JSON.parse(f.bakContent); } catch {} }
    const entries = flattenDp2(f.path, tree, bakTree);
    let changed = 0;
    for (const e of entries) {
      if (!isTranslated(e)) continue;
      const next = smartBreak(e.en, maxLine);
      if (next === e.en) continue;
      // write into tree (in-memory)
      applyToTree(tree, e, 'en', next);
      changed++;
    }
    result.totalEntries += entries.length;
    result.totalChanges += changed;
    if (changed > 0) {
      const fileName = (f.path.split(/[\\/]/).pop() || f.path).replace(/\.json$/i, '');
      result.files.push({ path: f.path, fileName, changed });
      if (!dryRun) {
        const json = JSON.stringify(tree, null, 2);
        const bakPath = f.path.replace(/\.json$/i, '.bak.json');
        try { await fs2.access(bakPath); }
        catch { try { await fs2.writeFile(bakPath, f.content, 'utf8'); } catch {} }
        await fs2.writeFile(f.path, json, 'utf8');
        await updateCacheAfterWrite(f.path, json);
      }
    }
  }
  return result;
}

// ── Task: file-counts ──────────────────────────────────────────────────
// Швидке сканування всіх файлів теки: повертає total/translated на файл.
// Викликається при заході в DP2-редактор, щоб одразу показати прогрес у дереві
// без потреби клікати по кожному файлу.
async function taskFileCounts(folder) {
  const out = [];
  if (!folder) return out;
  const all = await readAllFromFolder(folder);
  for (const f of all) {
    const entries = getEntries(f);
    if (!entries) continue;
    // Рахуємо лише ті записи, що ПОТРЕБУЮТЬ перекладу (мають латинські літери
    // в оригіналі). Числа/empty/"-" виключаються — інакше counter показує
    // "untranslated=3", а фільтр "Untranslated" порожній.
    let translatable = 0;
    let translated = 0;
    for (const e of entries) {
      if (!needsTranslation(e)) continue;
      translatable++;
      if (isTranslated(e)) translated++;
    }
    out.push({ path: f.path, total: translatable, translated });
  }
  return out;
}

// ── Task: name-consistency ─────────────────────────────────────────────
// Збирає всі унікальні `charaName` у корпусі DP2 і групує "схожі" варіанти:
//   case-only різниця (`Йорк` / `йорк`), друкарські помилки (`Йорк` / `Йорг`).
// Допомагає знайти варіанти імені, які треба об'єднати під одне канонічне.
function levenshtein(a, b) {
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let prev = new Array(b.length + 1);
  let cur = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(cur[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    [prev, cur] = [cur, prev];
  }
  return prev[b.length];
}

function looksLikeNameTypo(a, b) {
  if (a === b) return false;
  const A = a.toLowerCase().trim();
  const B = b.toLowerCase().trim();
  if (A === B) return true; // різниця лише у регістрі / пробілах
  const len = Math.max(A.length, B.length);
  // Дуже короткі назви (≤3 симв) — нічого не групуємо (false-positives).
  if (len < 4) return false;
  const d = levenshtein(A, B);
  if (len <= 6) return d === 1;
  if (len <= 12) return d <= 2;
  return d <= Math.floor(len / 5); // ~1 typo на 5 симв
}

async function taskNameConsistency(folder) {
  const result = { groups: [], totalNames: 0, totalEntries: 0 };
  if (!folder) return result;

  const map = new Map(); // name -> { count, samples: [{...}] }
  const all = await readAllFromFolder(folder);
  for (const f of all) {
    const entries = getEntries(f);
    if (!entries) continue;
    const fileName = (f.path.split(/[\\/]/).pop() || f.path).replace(/\.json$/i, '');
    for (const e of entries) {
      if (e.kind !== 'sentence') continue;
      const name = String(e.charaName || '').trim();
      if (!name) continue;
      result.totalEntries++;
      let v = map.get(name);
      if (!v) { v = { count: 0, samples: [] }; map.set(name, v); }
      v.count++;
      if (v.samples.length < 5) {
        v.samples.push({
          filePath: f.path, fileName,
          entryIndex: entries.indexOf(e),
          entryId: e.id || '',
          en: (e.en || '').slice(0, 140),
        });
      }
    }
  }

  result.totalNames = map.size;
  const names = Array.from(map.entries())
    .map(([name, v]) => ({ name, count: v.count, samples: v.samples }))
    .sort((a, b) => b.count - a.count);

  // Жадібне групування: беремо найчастіший варіант як канонічний, шукаємо
  // схожі серед менш частих.
  const assigned = new Set();
  for (let i = 0; i < names.length; i++) {
    if (assigned.has(i)) continue;
    const variants = [names[i]];
    assigned.add(i);
    for (let j = i + 1; j < names.length; j++) {
      if (assigned.has(j)) continue;
      if (looksLikeNameTypo(names[i].name, names[j].name)) {
        variants.push(names[j]);
        assigned.add(j);
      }
    }
    if (variants.length > 1) {
      result.groups.push({
        canonical: variants[0].name,
        variants,
      });
    }
  }

  return result;
}

// ── Task: rename-chara (exact equality, безпечно для cross-file replace) ──
async function taskRenameChara(folder, oldName, newName) {
  const result = { files: [], totalEntries: 0 };
  if (!folder || !oldName || oldName === newName) return result;
  const fs2 = require('node:fs/promises');
  const all = await readAllFromFolder(folder);
  for (const f of all) {
    let tree;
    try { tree = JSON.parse(f.content); } catch { continue; }
    let changed = 0;
    const sheets = tree && tree.m_sheets && tree.m_sheets.Array || [];
    for (const sheet of sheets) {
      const list = sheet && sheet.m_list && sheet.m_list.Array || [];
      for (const item of list) {
        if (!item || !item.m_scenarioList) continue;
        const scenarios = item.m_scenarioList.Array || [];
        for (const scen of scenarios) {
          const sents = scen && scen.m_sentences && scen.m_sentences.Array || [];
          // Тільки EN-слот (LANG_EN = 1)
          const en = sents[LANG_EN];
          if (!en) continue;
          if (en.m_charaName === oldName) {
            en.m_charaName = newName;
            changed++;
          }
        }
      }
    }
    if (changed > 0) {
      result.totalEntries += changed;
      result.files.push({
        path: f.path,
        fileName: (f.path.split(/[\\/]/).pop() || f.path).replace(/\.json$/i, ''),
        changed,
      });
      const json = JSON.stringify(tree, null, 2);
      const bakPath = f.path.replace(/\.json$/i, '.bak.json');
      try { await fs2.access(bakPath); }
      catch { try { await fs2.writeFile(bakPath, f.content, 'utf8'); } catch {} }
      await fs2.writeFile(f.path, json, 'utf8');
      await updateCacheAfterWrite(f.path, json);
    }
  }
  return result;
}

// ── Task: batch-replace ────────────────────────────────────────────────
// Find & Replace по всьому DP2-корпусу одразу. Два режими:
//   • dryRun=true  — нічого не пише, повертає preview: { matches per file }
//   • dryRun=false — застосовує і пише файли (з .bak.json як у звичайному save)
async function taskBatchReplace(folder, opts) {
  const result = {
    files: [],         // {path, fileName, entriesChanged, replacements, hits}
    totalEntries: 0,
    totalReplacements: 0,
    truncated: false,
  };
  if (!folder || !opts || !opts.find) return result;

  let re;
  if (opts.regex) {
    try {
      re = new RegExp(opts.find, opts.caseSensitive ? 'g' : 'gi');
    } catch { return result; }
  } else {
    const esc = opts.find.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pat = opts.wholeWord ? `\\b${esc}\\b` : esc;
    re = new RegExp(pat, opts.caseSensitive ? 'g' : 'gi');
  }
  const fields = opts.field === 'all' ? ['en'] : [opts.field];
  // Безпека: дозволяємо тільки 'en' / 'charaName'. JP/originalEn — read-only.
  const writable = fields.filter((f) => f === 'en' || f === 'charaName');
  if (writable.length === 0) return result;

  const all = await readAllFromFolder(folder);
  const MAX_HITS_PER_FILE = 200;

  for (const f of all) {
    let tree;
    try { tree = JSON.parse(f.content); } catch { continue; }
    const bakTree = f.bakContent ? safeJson(f.bakContent) : null;
    const entries = flattenDp2(f.path, tree, bakTree);
    const fileName = (f.path.split(/[\\/]/).pop() || f.path).replace(/\.json$/i, '');

    let fileEntriesChanged = 0;
    let fileReps = 0;
    const hits = [];

    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      let touched = false;

      for (const fld of writable) {
        const cur = String(e[fld] ?? '');
        if (!cur) continue;
        re.lastIndex = 0;
        if (!re.test(cur)) continue;
        re.lastIndex = 0;
        const next = cur.replace(re, opts.replace);
        // Лічильник саме застосувань — рахуємо їх через regex
        re.lastIndex = 0;
        const matches = cur.match(re) || [];
        if (matches.length === 0 || next === cur) continue;
        fileReps += matches.length;
        touched = true;

        if (hits.length < MAX_HITS_PER_FILE) {
          hits.push({
            entryIndex: i,
            entryId: e.id || '',
            field: fld,
            before: cur,
            after: next,
          });
        }
        // Записуємо у tree
        applyToTree(tree, e, fld, next);
      }

      if (touched) fileEntriesChanged++;
    }

    result.totalEntries += fileEntriesChanged;
    result.totalReplacements += fileReps;

    if (fileEntriesChanged > 0) {
      result.files.push({
        path: f.path, fileName,
        entriesChanged: fileEntriesChanged,
        replacements: fileReps,
        hits,
      });

      if (!opts.dryRun) {
        const fs2 = require('node:fs/promises');
        const json = JSON.stringify(tree, null, 2);
        // створити .bak якщо нема
        const bakPath = f.path.replace(/\.json$/i, '.bak.json');
        try { await fs2.access(bakPath); }
        catch {
          try { await fs2.writeFile(bakPath, f.content, 'utf8'); } catch {}
        }
        await fs2.writeFile(f.path, json, 'utf8');
        await updateCacheAfterWrite(f.path, json);
      }
    }
  }
  return result;
}

function safeJson(s) { try { return JSON.parse(s); } catch { return null; } }

// Записує `value` у дерево JSON у те саме місце, звідки entry читався.
function applyToTree(tree, entry, field, value) {
  const sheets = tree && tree.m_sheets && tree.m_sheets.Array;
  if (!sheets) return false;
  const sheet = sheets[entry.sheetIndex];
  const item = sheet && sheet.m_list && sheet.m_list.Array && sheet.m_list.Array[entry.listIndex];
  if (!item) return false;
  if (entry.kind === 'sentence') {
    const scen = item.m_scenarioList && item.m_scenarioList.Array && item.m_scenarioList.Array[entry.scenarioIndex];
    const sent = scen && scen.m_sentences && scen.m_sentences.Array && scen.m_sentences.Array[LANG_EN];
    if (!sent) return false;
    if (field === 'en') sent.m_serif = value;
    else if (field === 'charaName') sent.m_charaName = value;
    return true;
  }
  if (entry.kind === 'item') {
    const arr = item.m_text && item.m_text.Array;
    if (!arr) return false;
    if (field === 'en') arr[LANG_EN] = value;
    return true;
  }
  return false;
}

// ── Task: search-all ────────────────────────────────────────────────────
async function taskSearchAll(folder, opts) {
  const result = { hits: [], byFile: [], truncated: false };
  const q = (opts && opts.query ? opts.query : '').trim();
  if (!q || !folder) return result;

  let match;
  if (opts.regex) {
    try {
      const re = new RegExp(q, opts.caseSensitive ? 'g' : 'gi');
      match = (s) => !!s && re.test(s);
    } catch { return result; }
  } else {
    if (opts.caseSensitive) {
      match = (s) => !!s && s.indexOf(q) !== -1;
    } else {
      const needle = q.toLowerCase();
      match = (s) => !!s && s.toLowerCase().indexOf(needle) !== -1;
    }
  }
  const fields = opts.field === 'all' ? ['jp', 'en', 'originalEn', 'charaName'] : [opts.field];
  const MAX_HITS = 1000;

  const all = await readAllFromFolder(folder);
  outer: for (const f of all) {
    const entries = getEntries(f);
    if (!entries) continue;
    const fileName = (f.path.split(/[\\/]/).pop() || f.path).replace(/\.json$/i, '');

    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      for (const fld of fields) {
        const val = e[fld];
        if (!val) continue;
        if (match(val)) {
          result.hits.push({
            filePath: f.path, fileName,
            entryIndex: i,
            matchedField: fld,
            matchedText: val,
            entry: e,
          });
          if (result.hits.length >= MAX_HITS) {
            result.truncated = true;
            break outer;
          }
          break;
        }
      }
    }
  }
  return result;
}

// ── TGL (The Good Life) — bin codec + txt workflow ─────────────────────
// Великі операції (28k записів + UTF-8 декод) дряпають main process, тож
// винесено сюди. Worker отримує лише шлях/масив рядків — Buffer'и через IPC
// не курсують.

const fsSync = require('node:fs');

function tglRead7Bit(buf, off) {
  // C# BinaryReader 7-bit-encoded int — використовуємо МНОЖЕННЯ замість
  // зсуву, бо JS `<< 28` коерсить до signed int32 і ламає старші біти.
  let val = 0, shift = 0, p = off;
  while (true) {
    if (p >= buf.length) throw new Error('7-bit read past EOF at ' + off);
    const b = buf[p++];
    val += (b & 0x7f) * 2 ** shift;
    if ((b & 0x80) === 0) break;
    shift += 7;
    if (shift > 35) throw new Error('7-bit int too long at ' + off);
  }
  return { value: val, next: p };
}
function tglKeyHex(buf, off) {
  const lo = buf.readUInt32LE(off);
  const hi = buf.readUInt32LE(off + 4);
  return (BigInt(hi) << 32n | BigInt(lo)).toString(16).padStart(16, '0');
}
function tglDecodeBin(file) {
  const buf = fsSync.readFileSync(file);
  const count = buf.readUInt32LE(0);
  let off = 4;
  const records = new Array(count);
  for (let i = 0; i < count; i++) {
    const key = tglKeyHex(buf, off); off += 8;
    const li = tglRead7Bit(buf, off); off = li.next;
    const text = buf.slice(off, off + li.value).toString('utf8');
    off += li.value;
    records[i] = { i, key, en: text };
  }
  if (off !== buf.length) {
    throw new Error('TGL trailing bytes: parsed ' + off + ', file ' + buf.length);
  }
  return { records, originalSize: buf.length };
}
function tglEncodeBin(records) {
  let total = 4;
  const enc = new Array(records.length);
  for (let i = 0; i < records.length; i++) {
    const utf = Buffer.from(records[i].text, 'utf8');
    const lenBytes = [];
    let v = utf.length;
    while (v >= 0x80) { lenBytes.push((v & 0x7f) | 0x80); v = v >>> 7; }
    lenBytes.push(v & 0x7f);
    enc[i] = { keyHex: records[i].key, lenBytes, utf };
    total += 8 + lenBytes.length + utf.length;
  }
  const out = Buffer.allocUnsafe(total);
  out.writeUInt32LE(records.length, 0);
  let off = 4;
  for (const e of enc) {
    const key = BigInt('0x' + e.keyHex);
    out.writeUInt32LE(Number(key & 0xffffffffn), off);
    out.writeUInt32LE(Number((key >> 32n) & 0xffffffffn), off + 4);
    off += 8;
    for (const b of e.lenBytes) out[off++] = b;
    e.utf.copy(out, off);
    off += e.utf.length;
  }
  return out;
}
function tglEscape(s) {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '\\') out += '\\\\';
    else if (ch === '\r') out += '\\r';
    else if (ch === '\n') out += '\\n';
    else out += ch;
  }
  return out;
}
function tglUnescape(s) {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '\\' && i + 1 < s.length) {
      const nxt = s[i + 1];
      if (nxt === '\\') { out += '\\'; i++; }
      else if (nxt === 'r') { out += '\r'; i++; }
      else if (nxt === 'n') { out += '\n'; i++; }
      else { out += ch; }
    } else {
      out += ch;
    }
  }
  return out;
}
function tglTxtToLines(txt) {
  if (txt.charCodeAt(0) === 0xfeff) txt = txt.slice(1);
  if (txt.endsWith('\r\n')) txt = txt.slice(0, -2);
  else if (txt.endsWith('\n')) txt = txt.slice(0, -1);
  return txt.split(/\r\n|\r|\n/);
}

async function taskTglLoad(binPath) {
  const parsed = tglDecodeBin(binPath);
  const workPath = binPath + '.txt';
  let ua = parsed.records.map((r) => r.en);
  let workfileMismatch = null;
  try {
    const raw = await fs.readFile(workPath, 'utf8');
    const lines = tglTxtToLines(raw);
    if (lines.length === parsed.records.length) {
      ua = lines.map(tglUnescape);
    } else {
      workfileMismatch = { binLines: parsed.records.length, txtLines: lines.length };
    }
  } catch {}
  return { records: parsed.records, ua, originalSize: parsed.originalSize, workPath, workfileMismatch };
}

async function taskTglSaveWorkfile(binPath, ua) {
  const parsed = tglDecodeBin(binPath);
  if (ua.length !== parsed.records.length) {
    throw new Error('ua length (' + ua.length + ') != bin records (' + parsed.records.length + ')');
  }
  const body = ua.map((s, i) => tglEscape(typeof s === 'string' ? s : parsed.records[i].en)).join('\r\n');
  const workPath = binPath + '.txt';
  await fs.writeFile(workPath, body, 'utf8');
  return { workPath };
}

// Find balanced {} block starting from `openAt` (where char is '{').
function tglFindBalancedBlock(raw, openAt) {
  if (raw.charCodeAt(openAt) !== 0x7B) return -1;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = openAt; i < raw.length; i++) {
    const ch = raw.charCodeAt(i);
    if (inStr) {
      if (esc) { esc = false; continue; }
      if (ch === 0x5C) { esc = true; continue; }
      if (ch === 0x22) { inStr = false; }
      continue;
    }
    if (ch === 0x22) { inStr = true; continue; }
    if (ch === 0x7B) depth++;
    else if (ch === 0x7D) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

async function taskTglFontParse(jsonPath) {
  const raw = await fs.readFile(jsonPath, 'utf8');
  const data = JSON.parse(raw);
  // Locate "m_CharacterRects": { ... } section in raw for patch-safe save.
  let charsSection = null;
  const re = /"m_CharacterRects"\s*:\s*\{/g;
  const m = re.exec(raw);
  if (m) {
    const openAt = m.index + m[0].length - 1;
    const closeAt = tglFindBalancedBlock(raw, openAt);
    if (closeAt > 0) charsSection = { start: openAt, end: closeAt };
  }
  return { raw, data, charsSection };
}

async function taskTglPack(binPath, ua) {
  const parsed = tglDecodeBin(binPath);
  if (ua.length !== parsed.records.length) {
    throw new Error('ua length (' + ua.length + ') != bin records (' + parsed.records.length + ')');
  }
  let translated = 0, fallback = 0;
  const packed = parsed.records.map((r) => {
    const u = ua[r.i];
    if (typeof u === 'string' && u.length > 0 && u !== r.en) { translated++; return { key: r.key, text: u }; }
    fallback++;
    return { key: r.key, text: r.en };
  });
  const bak = binPath + '.bak';
  try { await fs.access(bak); } catch { await fs.copyFile(binPath, bak); }
  const buf = tglEncodeBin(packed);
  await fs.writeFile(binPath, buf);
  return {
    outputPath: binPath,
    bakPath: bak,
    translated,
    fallback,
    size: buf.length,
    originalSize: parsed.originalSize,
  };
}

// ── Dispatcher ──────────────────────────────────────────────────────────
parentPort.on('message', async (msg) => {
  const id = msg && msg.id;
  try {
    const type = msg && msg.type;
    const payload = msg && msg.payload;
    let result;
    if (type === 'build-tm') {
      result = await taskBuildTm(payload.dp2Folder, payload.dp1EngPath);
    } else if (type === 'search-all') {
      result = await taskSearchAll(payload.folder, payload.opts);
    } else if (type === 'corpus-stats') {
      result = await taskCorpusStats(payload.folder);
    } else if (type === 'glossary-consistency') {
      result = await taskGlossaryConsistency(payload.folder, payload.glossary);
    } else if (type === 'batch-replace') {
      result = await taskBatchReplace(payload.folder, payload.opts);
    } else if (type === 'file-counts') {
      result = await taskFileCounts(payload.folder);
    } else if (type === 'smart-break-all') {
      result = await taskSmartBreakAll(payload.folder, payload.opts || {});
    } else if (type === 'name-consistency') {
      result = await taskNameConsistency(payload.folder);
    } else if (type === 'rename-chara') {
      result = await taskRenameChara(payload.folder, payload.oldName, payload.newName);
    } else if (type === 'tgl-load') {
      result = await taskTglLoad(payload.binPath);
    } else if (type === 'tgl-save-workfile') {
      result = await taskTglSaveWorkfile(payload.binPath, payload.ua);
    } else if (type === 'tgl-pack') {
      result = await taskTglPack(payload.binPath, payload.ua);
    } else if (type === 'tgl-font-parse') {
      result = await taskTglFontParse(payload.jsonPath);
    } else {
      throw new Error('Unknown task type: ' + type);
    }
    parentPort.postMessage({ id, ok: true, result });
  } catch (e) {
    parentPort.postMessage({ id, ok: false, error: (e && e.message) || String(e) });
  }
});
