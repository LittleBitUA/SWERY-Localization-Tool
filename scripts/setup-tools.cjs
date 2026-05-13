'use strict';

// Setup-tools: завантаження зовнішніх інструментів (UABEA Next, PowerShell 7)
// з GitHub Releases. Без сторонніх npm-залежностей — використовуємо вбудований
// `https`. Підтримуємо redirect-ланцюжки (GitHub releases → S3) і progress.
//
// Архітектура запозичена з KH1-Text-Editor electron-app/tools/lib/setup-tools.js
// та адаптована під DP2 (потрібні UABEA + PowerShell 7).

const https = require('node:https');
const http = require('node:http');
const fs = require('node:fs');
const fsP = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');

const USER_AGENT = 'DP2-Localization-Tool/setup';

// ---- HTTP helpers ------------------------------------------------------

function _get(url, opts) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === 'http:' ? http : https;
    const reqOpts = {
      method: 'GET',
      hostname: u.hostname,
      port: u.port || (u.protocol === 'http:' ? 80 : 443),
      path: u.pathname + u.search,
      headers: Object.assign(
        { 'User-Agent': USER_AGENT, Accept: '*/*' },
        (opts && opts.headers) || {}
      ),
    };
    const req = lib.request(reqOpts, (res) => resolve(res));
    req.on('error', reject);
    req.setTimeout(30000, () => {
      req.destroy(new Error('HTTP timeout after 30s: ' + url));
    });
    req.end();
  });
}

async function getFollow(url, opts) {
  let cur = url;
  for (let hop = 0; hop < 5; hop++) {
    const res = await _get(cur, opts);
    if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
      res.resume();
      cur = new URL(res.headers.location, cur).toString();
      continue;
    }
    return { res, finalUrl: cur };
  }
  throw new Error('Too many redirects starting at ' + url);
}

async function fetchLatestRelease(owner, repo) {
  const url = `https://api.github.com/repos/${owner}/${repo}/releases/latest`;
  const { res } = await getFollow(url, {
    headers: { Accept: 'application/vnd.github+json' },
  });
  if (res.statusCode !== 200) {
    res.resume();
    throw new Error(`GitHub API ${owner}/${repo}: HTTP ${res.statusCode}`);
  }
  const chunks = [];
  for await (const chunk of res) chunks.push(chunk);
  let json;
  try {
    json = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new Error('GitHub API: invalid JSON for ' + owner + '/' + repo);
  }
  const assets = (json.assets || []).map((a) => ({
    name: a.name,
    url: a.browser_download_url,
    size: a.size,
    contentType: a.content_type,
  }));
  return {
    tag: json.tag_name,
    name: json.name,
    publishedAt: json.published_at,
    htmlUrl: json.html_url,
    assets,
  };
}

function pickAsset(assets, predicate) {
  if (!assets || !assets.length) return null;
  if (predicate instanceof RegExp) return assets.find((a) => predicate.test(a.name)) || null;
  if (typeof predicate === 'function') return assets.find(predicate) || null;
  return null;
}

async function downloadFile(url, destPath, onProgress, options) {
  const opts = options || {};
  const skipIfExists = opts.skipIfExists !== false;

  if (skipIfExists) {
    try {
      const st = await fsP.stat(destPath);
      if (st.size > 0) return { bytes: st.size, alreadyExisted: true, destPath };
    } catch {}
  }

  await fsP.mkdir(path.dirname(destPath), { recursive: true });

  const tmpPath = destPath + '.part';
  try { await fsP.unlink(tmpPath); } catch {}

  const { res } = await getFollow(url);
  if (res.statusCode !== 200) {
    res.resume();
    throw new Error(`Download failed (HTTP ${res.statusCode}) for ${url}`);
  }

  const total = parseInt(res.headers['content-length'] || '0', 10) || 0;
  let downloaded = 0;
  let lastEmit = 0;

  await new Promise((resolve, reject) => {
    const out = fs.createWriteStream(tmpPath);
    let aborted = false;
    const fail = (err) => {
      if (aborted) return;
      aborted = true;
      out.destroy();
      try { fs.unlinkSync(tmpPath); } catch {}
      reject(err);
    };
    res.on('data', (chunk) => {
      downloaded += chunk.length;
      if (typeof onProgress === 'function') {
        const now = Date.now();
        if (now - lastEmit >= 100 || (total && downloaded === total)) {
          lastEmit = now;
          const percent = total > 0 ? Math.min(100, Math.round((downloaded / total) * 100)) : null;
          try { onProgress({ downloaded, total, percent }); } catch {}
        }
      }
    });
    res.on('error', fail);
    out.on('error', fail);
    res.pipe(out);
    out.on('finish', () => {
      if (aborted) return;
      out.close((err) => (err ? fail(err) : resolve()));
    });
  });

  await fsP.rename(tmpPath, destPath);
  return { bytes: downloaded, alreadyExisted: false, destPath };
}

function extractZip(zipPath, destDir) {
  return new Promise((resolve, reject) => {
    const args = [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-Command',
      `Expand-Archive -LiteralPath '${zipPath.replace(/'/g, "''")}' -DestinationPath '${destDir.replace(/'/g, "''")}' -Force`,
    ];
    const ps = spawn('powershell.exe', args, { windowsHide: true });
    let stderr = '';
    ps.stderr.on('data', (b) => { stderr += b.toString(); });
    ps.on('error', reject);
    ps.on('close', (code) => {
      if (code === 0) resolve({ destDir });
      else reject(new Error('Expand-Archive exit ' + code + ': ' + stderr.trim()));
    });
  });
}

async function flattenIfSingleSubdir(dir) {
  let items;
  try { items = await fsP.readdir(dir, { withFileTypes: true }); } catch { return; }
  if (items.length !== 1 || !items[0].isDirectory()) return;
  const inner = path.join(dir, items[0].name);
  const tmp = path.join(dir, '__flatten_tmp__');
  await fsP.rename(inner, tmp);
  const innerItems = await fsP.readdir(tmp);
  for (const name of innerItems) {
    await fsP.rename(path.join(tmp, name), path.join(dir, name));
  }
  await fsP.rmdir(tmp);
}

// Знайти .exe у каталозі (рекурсивно, до глибини 4). Перший збіг = переможець.
async function findExeInDir(dir, namePattern, maxDepth = 4) {
  const stack = [{ d: dir, depth: 0 }];
  while (stack.length) {
    const { d, depth } = stack.shift();
    let entries;
    try { entries = await fsP.readdir(d, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isFile() && /\.exe$/i.test(e.name) && namePattern.test(e.name)) {
        return full;
      }
      if (e.isDirectory() && depth < maxDepth) stack.push({ d: full, depth: depth + 1 });
    }
  }
  return null;
}

module.exports = {
  fetchLatestRelease,
  pickAsset,
  downloadFile,
  extractZip,
  flattenIfSingleSubdir,
  findExeInDir,
};
