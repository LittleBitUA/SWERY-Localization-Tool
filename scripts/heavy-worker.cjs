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

function isTranslated(e) {
  if (!e.originalEn) return false;
  return e.en !== e.originalEn;
}

// ── Tag helpers ─────────────────────────────────────────────────────────
const TAG_RE = /\{[^{}]*\}|<\/?[a-zA-Z][^>]*>|\[[^\]]+\]/g;

function extractTags(s) {
  if (!s) return [];
  const m = s.match(TAG_RE);
  return m ? m.slice().sort() : [];
}

function countNewlines(s) {
  if (!s) return 0;
  let n = 0;
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) === 10) n++;
  return n;
}

// ── Task: scan-all ──────────────────────────────────────────────────────
async function taskScanAll(folder) {
  const all = await readAllFromFolder(folder);
  const issues = [];
  let totalEntries = 0;
  let totalTranslated = 0;

  for (const f of all) {
    let tree = null;
    let bakTree = null;
    try { tree = JSON.parse(f.content); } catch { continue; }
    if (f.bakContent) {
      try { bakTree = JSON.parse(f.bakContent); } catch {}
    }
    const entries = flattenDp2(f.path, tree, bakTree);
    totalEntries += entries.length;

    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      const trans = isTranslated(e);
      if (trans) totalTranslated++;

      const orig = (e.originalEn != null ? e.originalEn : e.jp) || '';
      const cur = e.en || '';
      const eid = e.id || `#${i + 1}`;

      if (!cur.trim() && orig.trim()) {
        issues.push({ kind: 'empty', filePath: f.path, entryIndex: i, id: eid, detail: 'Переклад порожній' });
      }
      if (!cur.trim() || !orig.trim()) continue;

      const nlOrig = countNewlines(orig);
      const nlCur = countNewlines(cur);
      if (nlOrig !== nlCur) {
        issues.push({
          kind: 'newline', filePath: f.path, entryIndex: i, id: eid,
          detail: `\\n: оригінал=${nlOrig}, переклад=${nlCur}`,
        });
      }

      const tOrig = extractTags(orig);
      const tCur = extractTags(cur);
      if (tOrig.length || tCur.length) {
        let same = tOrig.length === tCur.length;
        if (same) for (let k = 0; k < tOrig.length; k++) if (tOrig[k] !== tCur[k]) { same = false; break; }
        if (!same) {
          const missing = [];
          const extra = [];
          for (const t of tOrig) if (!tCur.includes(t)) missing.push(t);
          for (const t of tCur) if (!tOrig.includes(t)) extra.push(t);
          const parts = [];
          if (missing.length) parts.push(`втрачено: ${missing.join(', ')}`);
          if (extra.length) parts.push(`додано: ${extra.join(', ')}`);
          issues.push({
            kind: 'tag', filePath: f.path, entryIndex: i, id: eid,
            detail: parts.join('; ') || 'теги відрізняються',
          });
        }
      }
    }
  }
  return { totalEntries, totalTranslated, issues };
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
    if (type === 'scan-all') {
      result = await taskScanAll(payload);
    } else if (type === 'build-tm') {
      result = await taskBuildTm(payload.dp2Folder, payload.dp1EngPath);
    } else if (type === 'search-all') {
      result = await taskSearchAll(payload.folder, payload.opts);
    } else {
      throw new Error('Unknown task type: ' + type);
    }
    parentPort.postMessage({ id, ok: true, result });
  } catch (e) {
    parentPort.postMessage({ id, ok: false, error: (e && e.message) || String(e) });
  }
});
