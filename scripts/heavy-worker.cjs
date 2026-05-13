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

async function readAllFromFolder(folder) {
  if (!folder) return [];
  const files = await collectJsonFiles(folder);
  // Паралельне читання — fs IO зазвичай повільніший за CPU-парсинг.
  const result = await Promise.all(files.map(async (fp) => {
    try {
      const content = await fs.readFile(fp, 'utf8');
      let bakContent = null;
      const bakPath = fp.replace(/\.json$/i, '.bak.json');
      try { bakContent = await fs.readFile(bakPath, 'utf8'); } catch {}
      return { path: fp, content, bakContent };
    } catch { return null; }
  }));
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
function isTranslated(e) {
  if (!e.originalEn) return false;
  if (e.en === e.originalEn) return false;
  // Те саме що у frontend/src/lib/parser.ts: вимагаємо реальну кирилицю,
  // щоб не ловити невидимі різниці у бекапі (пробіли/регістр/escape).
  return HAS_CYR.test(e.en);
}

// ── Task: build-tm ──────────────────────────────────────────────────────
async function taskBuildTm(dp2Folder, dp1EngPath) {
  const out = [];

  if (dp2Folder) {
    const all = await readAllFromFolder(dp2Folder);
    for (const f of all) {
      let tree = null;
      let bakTree = null;
      try { tree = JSON.parse(f.content); } catch { continue; }
      if (f.bakContent) {
        try { bakTree = JSON.parse(f.bakContent); } catch {}
      }
      const entries = flattenDp2(f.path, tree, bakTree);
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
    let tree = null;
    let bakTree = null;
    try { tree = JSON.parse(f.content); } catch { continue; }
    if (f.bakContent) {
      try { bakTree = JSON.parse(f.bakContent); } catch {}
    }
    const entries = flattenDp2(f.path, tree, bakTree);
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
    const key = src.toLowerCase() + ' ' + tgt.toLowerCase();
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
    let tree = null;
    let bakTree = null;
    try { tree = JSON.parse(f.content); } catch { continue; }
    if (f.bakContent) {
      try { bakTree = JSON.parse(f.bakContent); } catch {}
    }
    const entries = flattenDp2(f.path, tree, bakTree);
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
    let tree = null;
    let bakTree = null;
    try { tree = JSON.parse(f.content); } catch { continue; }
    if (f.bakContent) {
      try { bakTree = JSON.parse(f.bakContent); } catch {}
    }
    const entries = flattenDp2(f.path, tree, bakTree);
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
    } else {
      throw new Error('Unknown task type: ' + type);
    }
    parentPort.postMessage({ id, ok: true, result });
  } catch (e) {
    parentPort.postMessage({ id, ok: false, error: (e && e.message) || String(e) });
  }
});
