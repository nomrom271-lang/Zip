'use strict';
/*
 * AI Studio — zero-dependency Node.js server (Node 18+)
 * - freemodel.in (OpenAI-compatible) proxy with streaming + auto model fallback
 * - ZIP builder / reader (10–50 MB+ zips), file extract (zip/docx/xlsx/pptx/pdf)
 * - Project validator for auto-fix (node --check, python ast, JSON, missing files/deps)
 * - HTML -> PDF via local Chrome/Chromium (vector, Hindi-safe)
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const zlib = require('zlib');
const { execFile, spawn } = require('child_process');
const { pathToFileURL } = require('url');

// ---------- config ----------
try { // tiny .env loader (no dependency)
  const envFile = path.join(__dirname, '.env');
  if (fs.existsSync(envFile)) {
    for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  }
} catch (_) {}

const PORT = +process.env.PORT || 3000;
const DEFAULT_BASE = (process.env.FREEMODEL_BASE || 'https://freemodel.in/v1').replace(/\/+$/, '');
const ENV_KEY = process.env.FREEMODEL_API_KEY || '';
const LOCK_BASE = process.env.LOCK_BASE === '1';
const APP_PASSWORD = process.env.APP_PASSWORD || '';
const MAX_BODY = 160 * 1024 * 1024;
const FIRST_TOKEN_MS = +process.env.FIRST_TOKEN_MS || 35000;
const PUB = path.join(__dirname, 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json', '.txt': 'text/plain; charset=utf-8'
};

// ---------- helpers ----------
const httpErr = (status, message) => Object.assign(new Error(message || ('HTTP ' + status)), { status });
const sleep = ms => new Promise(r => setTimeout(r, ms));
function readBody(req, limit = MAX_BODY) {
  return new Promise((resolve, reject) => {
    const chunks = []; let n = 0;
    req.on('data', d => {
      n += d.length;
      if (n > limit) { reject(httpErr(413, 'File bahut badi hai (limit ' + Math.round(limit / 1048576) + ' MB)')); req.destroy(); return; }
      chunks.push(d);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
function sendJson(res, code, obj) {
  const b = Buffer.from(JSON.stringify(obj));
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': b.length, 'Cache-Control': 'no-store' });
  res.end(b);
}
async function safeText(r) { try { return await r.text(); } catch (_) { return ''; } }
function extractMsg(t) {
  try { const j = JSON.parse(t); return (j.error && (j.error.message || j.error)) || j.message || t; } catch (_) { return (t || '').slice(0, 300); }
}
function getKey(req) { return (req.headers['x-api-key'] || '').toString().trim() || ENV_KEY; }
function getBase(req) {
  const h = (req.headers['x-base-url'] || '').toString().trim().replace(/\/+$/, '');
  if (!LOCK_BASE && /^https?:\/\//i.test(h)) return h;
  return DEFAULT_BASE;
}
function friendly(status, msg) {
  if (status === 401 || status === 403) return 'API key galat ya missing hai. ⚙ Settings me sahi key daalein (freemodel.in/register se free key milti hai).';
  if (status === 402) return 'Tokens / balance khatam ho gaya. freemodel.in par plan ya top-up check karein.';
  if (status === 429) return 'Rate limit lag gayi — thodi der baad try karein.';
  return msg || ('Error ' + status);
}

// ---------- ZIP (reader + writer) ----------
let CRC_TABLE = null;
function crc32(buf) {
  if (typeof zlib.crc32 === 'function') return zlib.crc32(buf) >>> 0;
  if (!CRC_TABLE) {
    CRC_TABLE = new Uint32Array(256);
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; CRC_TABLE[n] = c >>> 0; }
  }
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}
function safeName(n) {
  return String(n || '').replace(/\\/g, '/').split('/').filter(s => s && s !== '.' && s !== '..').join('/');
}
const STORE_EXT = /\.(zip|png|jpe?g|gif|webp|mp4|mov|mp3|aac|ogg|pdf|gz|7z|rar|woff2?|docx|xlsx|pptx|apk)$/i;
function entryFromData(name, data) {
  const crc = crc32(data);
  let method = 0, raw = data;
  if (data.length >= 64 && !STORE_EXT.test(name)) {
    const z = zlib.deflateRawSync(data, { level: 6 });
    if (z.length < data.length) { method = 8; raw = z; }
  }
  return { name, method, crc, csize: raw.length, usize: data.length, raw };
}
function readZip(buf) {
  let e = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { e = i; break; }
  }
  if (e < 0) throw httpErr(400, 'Yeh valid ZIP file nahi lag rahi.');
  const total = buf.readUInt16LE(e + 10);
  let p = buf.readUInt32LE(e + 16);
  if (p === 0xFFFFFFFF || total === 0xFFFF) throw httpErr(400, 'ZIP64 (4GB+) abhi support nahi hai.');
  const out = [];
  for (let i = 0; i < total; i++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) break;
    const flags = buf.readUInt16LE(p + 8), method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16), csize = buf.readUInt32LE(p + 20), usize = buf.readUInt32LE(p + 24);
    const nl = buf.readUInt16LE(p + 28), el = buf.readUInt16LE(p + 30), cl = buf.readUInt16LE(p + 32);
    const lho = buf.readUInt32LE(p + 42);
    const name = safeName(buf.slice(p + 46, p + 46 + nl).toString('utf8'));
    const isDir = buf.slice(p + 46, p + 46 + nl).toString('utf8').endsWith('/');
    p += 46 + nl + el + cl;
    if (isDir || !name || (flags & 1)) continue;
    if (buf.readUInt32LE(lho) !== 0x04034b50) continue;
    const lnl = buf.readUInt16LE(lho + 26), lel = buf.readUInt16LE(lho + 28);
    const ds = lho + 30 + lnl + lel;
    out.push({ name, method, crc, csize, usize, raw: buf.slice(ds, ds + csize) });
  }
  return out;
}
function entryData(en) {
  if (en.method === 0) return en.raw;
  if (en.method === 8) return zlib.inflateRawSync(en.raw, { maxOutputLength: 300 * 1024 * 1024 });
  throw httpErr(400, 'Unsupported ZIP compression: ' + en.method);
}
function dosDT(d = new Date()) {
  return [(d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()];
}
function buildZip(entries) {
  const [t, dt] = dosDT();
  const parts = []; const central = []; let offset = 0;
  for (const en of entries) {
    const nameB = Buffer.from(en.name, 'utf8');
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x0800, 6);
    lh.writeUInt16LE(en.method, 8); lh.writeUInt16LE(t, 10); lh.writeUInt16LE(dt, 12);
    lh.writeUInt32LE(en.crc >>> 0, 14); lh.writeUInt32LE(en.csize, 18); lh.writeUInt32LE(en.usize, 22);
    lh.writeUInt16LE(nameB.length, 26); lh.writeUInt16LE(0, 28);
    parts.push(lh, nameB, en.raw);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(0x031e, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x0800, 8);
    ch.writeUInt16LE(en.method, 10); ch.writeUInt16LE(t, 12); ch.writeUInt16LE(dt, 14);
    ch.writeUInt32LE(en.crc >>> 0, 16); ch.writeUInt32LE(en.csize, 20); ch.writeUInt32LE(en.usize, 24);
    ch.writeUInt16LE(nameB.length, 28); ch.writeUInt32LE(((0o100644 << 16) >>> 0), 38); ch.writeUInt32LE(offset, 42);
    central.push(ch, nameB);
    offset += 30 + nameB.length + en.raw.length;
  }
  const cd = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(entries.length, 8); eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, cd, eocd]);
}

// ---------- text / binary heuristics ----------
const TEXT_EXT = /\.(txt|md|markdown|json|jsonc|js|mjs|cjs|jsx|ts|tsx|css|scss|sass|less|html?|xml|svg|csv|tsv|yml|yaml|toml|ini|cfg|conf|env|py|rb|php|java|kt|go|rs|c|h|cpp|hpp|cs|swift|sh|bat|ps1|sql|vue|svelte|gitignore|dockerfile|lock|log|tex|rtf|srt|properties|gradle|dart|lua|r)$/i;
function looksText(name, buf) {
  const base = path.basename(name).toLowerCase();
  if (TEXT_EXT.test(name) || ['dockerfile', 'makefile', 'procfile', 'license', 'readme', '.gitignore', '.env', '.env.example'].includes(base)) return true;
  const n = Math.min(buf.length, 4096);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return false;
  return /\.[a-z0-9]{1,5}$/i.test(name) ? false : true;
}
function decodeXml(s) {
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}
function officeText(kind, entries) {
  const get = n => { const e = entries.find(x => x.name === n); return e ? entryData(e).toString('utf8') : ''; };
  if (kind === 'docx') {
    return decodeXml(get('word/document.xml').replace(/<\/w:p>/g, '\n').replace(/<w:tab\/>/g, '\t').replace(/<w:br\/>/g, '\n').replace(/<[^>]+>/g, ''));
  }
  if (kind === 'pptx') {
    return entries.filter(e => /^ppt\/slides\/slide\d+\.xml$/.test(e.name))
      .sort((a, b) => parseInt(a.name.match(/\d+/)[0]) - parseInt(b.name.match(/\d+/)[0]))
      .map((e, i) => '--- Slide ' + (i + 1) + ' ---\n' + decodeXml(entryData(e).toString('utf8').replace(/<\/a:p>/g, '\n').replace(/<[^>]+>/g, ''))).join('\n');
  }
  if (kind === 'xlsx') {
    const ss = get('xl/sharedStrings.xml');
    const strs = [...ss.matchAll(/<si>([\s\S]*?)<\/si>/g)].map(m => decodeXml(m[1].replace(/<[^>]+>/g, '')));
    return entries.filter(e => /^xl\/worksheets\/sheet\d+\.xml$/.test(e.name)).map((e, si) => {
      const x = entryData(e).toString('utf8');
      const rows = [...x.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)].map(r =>
        [...r[1].matchAll(/<c([^>]*)>([\s\S]*?)<\/c>/g)].map(c => {
          const v = (c[2].match(/<v>([\s\S]*?)<\/v>/) || [])[1] || '';
          return /t="s"/.test(c[1]) ? (strs[+v] || '') : decodeXml(v);
        }).join('\t'));
      return '--- Sheet ' + (si + 1) + ' ---\n' + rows.join('\n');
    }).join('\n');
  }
  return '';
}

// ---------- model list + ranking ----------
const modelCache = new Map();
const cooldown = new Map();
const NON_CHAT = /embed|rerank|dall|flux|sdxl|stable-diffusion|whisper|tts|speech|moderation|image-gen|imagen/i;
function normModel(m) {
  const id = m.id || m.name || '';
  const mods = [].concat(m.input_modalities || m.modalities || (m.architecture && m.architecture.input_modalities) || []);
  const vision = !!(m.vision || m.supports_vision || (m.capabilities && (m.capabilities.vision || m.capabilities.image)) ||
    (Array.isArray(mods) && mods.map(String).some(x => /image/i.test(x))) ||
    /claude|gpt-?[4-9]|gemini|vision|-vl|vl-|llava|pixtral|kimi|grok|qwen.*vl|llama.*(vision|4)|o3|o4|fable|mythos/i.test(id));
  return { id, vision, owned: m.owned_by || '', ctx: m.context_length || m.context_window || (m.top_provider && m.top_provider.context_length) || 0 };
}
async function listModels(base, key) {
  const ck = base + '|' + key.slice(-10);
  const c = modelCache.get(ck);
  if (c && Date.now() - c.t < 300000) return c.v;
  const r = await fetch(base + '/models', { headers: { Authorization: 'Bearer ' + key }, signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw httpErr(r.status, friendly(r.status, extractMsg(await safeText(r))));
  const j = await r.json();
  const arr = Array.isArray(j.data) ? j.data : Array.isArray(j) ? j : [];
  const v = arr.map(normModel).filter(m => m.id && !NON_CHAT.test(m.id));
  modelCache.set(ck, { t: Date.now(), v });
  return v;
}
function tier(id) {
  const s = id.toLowerCase();
  if (/haiku|flash|mini|nano|lite|small|instant|-8b|-7b|3b/.test(s)) return 30;
  if (/opus|fable|mythos|gpt-?[5-9]|o3|o4|gemini.*(pro|ultra)|kimi-?k|deepseek-?(r1|v3|v4|r2)|qwen.*(max|coder|235|480)|glm-?[4-9]|grok-?[3-9]|command-r-plus|405b|sonnet/.test(s)) return /sonnet/.test(s) ? 85 : 95;
  return 60;
}
function rankCandidates(models, { vision, coding }) {
  let pool = models;
  if (vision) { const v = models.filter(m => m.vision); if (v.length) pool = v; }
  const ids = pool.map(m => m.id).filter(id => id !== 'auto' && (cooldown.get(id) || 0) < Date.now());
  const score = id => coding ? tier(id) : (tier(id) === 30 ? 90 : tier(id));
  ids.sort((a, b) => score(b) - score(a));
  const out = [];
  if (!coding && !vision) out.push('auto');
  out.push(...ids.slice(0, 5));
  if (coding && !vision) out.push('auto');
  return [...new Set(out)].slice(0, 6);
}

// ---------- chat (streaming, auto fallback) ----------
async function attempt({ base, key, payload, model, signal, st, send }) {
  const ctl = new AbortController();
  const onAbort = () => ctl.abort();
  signal.addEventListener('abort', onAbort);
  let alive = false;
  const ft = setTimeout(() => { if (!alive) ctl.abort(); }, FIRST_TOKEN_MS);
  try {
    const r = await fetch(base + '/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
      body: JSON.stringify({ ...payload, model, stream: true }),
      signal: ctl.signal
    });
    if (!r.ok) throw httpErr(r.status, extractMsg(await safeText(r)));
    const ct = r.headers.get('content-type') || '';
    if (!ct.includes('event-stream')) {
      const j = await r.json();
      const txt = j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
      if (!txt) throw httpErr(502, 'Model ne khali jawab diya');
      alive = true; clearTimeout(ft);
      st.got = true; send({ t: 'start', model: j.model || model }); send({ t: 'delta', x: txt });
      st.finish = (j.choices[0].finish_reason) || 'stop'; st.usage = j.usage;
      return;
    }
    const reader = r.body.getReader(); const dec = new TextDecoder(); let buf = ''; let thinkSent = false;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        if (!line.startsWith('data:')) continue;
        const d = line.slice(5).trim();
        if (!d || d === '[DONE]') continue;
        let j; try { j = JSON.parse(d); } catch (_) { continue; }
        if (j.error) throw httpErr(502, (j.error.message || 'stream error'));
        if (j.usage) st.usage = j.usage;
        const ch = j.choices && j.choices[0]; if (!ch) continue;
        if (ch.finish_reason) st.finish = ch.finish_reason;
        const dl = ch.delta || {};
        if (!alive && (dl.content || dl.reasoning_content || dl.reasoning)) { alive = true; clearTimeout(ft); }
        if (!dl.content && (dl.reasoning_content || dl.reasoning) && !thinkSent && !st.got) { thinkSent = true; send({ t: 'think' }); }
        if (dl.content) {
          if (!st.got) { st.got = true; send({ t: 'start', model: j.model || model }); }
          send({ t: 'delta', x: dl.content });
        }
      }
    }
    if (!st.got) throw httpErr(502, 'Model ne khali jawab diya');
  } finally {
    clearTimeout(ft); signal.removeEventListener('abort', onAbort);
  }
}

async function handleChat(req, res) {
  let body;
  try { body = JSON.parse((await readBody(req, 60 * 1024 * 1024)).toString('utf8')); }
  catch (e) { return sendJson(res, e.status || 400, { error: e.message || 'Bad request' }); }
  const key = getKey(req), base = getBase(req);
  if (!key) return sendJson(res, 401, { error: friendly(401) });
  res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  const send = o => { if (!res.writableEnded) res.write('data: ' + JSON.stringify(o) + '\n\n'); };
  const ping = setInterval(() => { if (!res.writableEnded) res.write(': ping\n\n'); }, 8000);
  const ac = new AbortController();
  res.on('close', () => { if (!res.writableEnded) ac.abort(); clearInterval(ping); });

  const payload = {
    messages: body.messages,
    max_tokens: Math.min(+body.max_tokens || 12000, 64000),
    temperature: typeof body.temperature === 'number' ? body.temperature : 0.5
  };
  const manual = body.mode === 'manual' && body.model;
  let cands;
  if (manual) cands = [body.model];
  else {
    try { cands = rankCandidates(await listModels(base, key), { vision: !!body.vision, coding: !!body.coding }); }
    catch (e) {
      if ([401, 402, 403].includes(e.status)) { send({ t: 'error', message: e.message, code: e.status }); clearInterval(ping); return res.end(); }
      cands = ['auto'];
    }
    if (!cands.length) cands = ['auto'];
  }

  const st = { got: false, finish: '', usage: null };
  let lastErr = null;
  for (let ci = 0; ci < cands.length; ci++) {
    if (ac.signal.aborted) break;
    const model = cands[ci];
    let retriedTokens = false;
    for (;;) {
      try {
        await attempt({ base, key, payload, model, signal: ac.signal, st, send });
        send({ t: 'done', model, finish: st.finish || 'stop', usage: st.usage, tried: ci });
        clearInterval(ping); return res.end();
      } catch (e) {
        if (ac.signal.aborted) { clearInterval(ping); return res.end(); }
        lastErr = e;
        const msg = String(e.message || '');
        if (!retriedTokens && /max[_ ]?tokens|maximum.*(output|completion)/i.test(msg) && payload.max_tokens > 8192 && !st.got) {
          retriedTokens = true; payload.max_tokens = 8192; continue;
        }
        break;
      }
    }
    if (st.got) { // mid-stream failure: cannot switch model without garbling output
      send({ t: 'error', message: 'Beech me connection toot gaya: ' + (lastErr.message || ''), code: lastErr.status || 0, partial: true });
      clearInterval(ping); return res.end();
    }
    const status = lastErr.status || 0;
    if ([401, 402, 403].includes(status)) {
      send({ t: 'error', message: friendly(status, lastErr.message), code: status });
      clearInterval(ping); return res.end();
    }
    if (manual) {
      send({ t: 'error', message: friendly(status, lastErr.message || 'Model jawab nahi de paaya') + ' (model: ' + model + ')', code: status });
      clearInterval(ping); return res.end();
    }
    cooldown.set(model, Date.now() + 60000);
    if (ci + 1 < cands.length) send({ t: 'note', message: model + ' chala nahi, ' + cands[ci + 1] + ' try kar raha hoon…' });
  }
  send({ t: 'error', message: friendly(lastErr && lastErr.status, lastErr && lastErr.message) || 'Sab models fail ho gaye', code: lastErr && lastErr.status || 0 });
  clearInterval(ping); res.end();
}

// ---------- validator (auto-fix) ----------
function run(cmd, args, timeout = 12000) {
  return new Promise(resolve => {
    execFile(cmd, args, { timeout, maxBuffer: 2 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      resolve({ err, stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
  });
}
const BUILTINS = new Set(require('module').builtinModules);
function pkgName(spec) { return spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0]; }
function resolveLocal(fromFile, spec, paths) {
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(fromFile), spec));
  const tries = [base, base + '.js', base + '.json', base + '.mjs', base + '.cjs', base + '.ts', base + '.jsx', base + '.tsx', base + '/index.js', base + '/index.json'];
  return tries.some(t => paths.has(t));
}
async function validateProject(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aistudio-'));
  const issues = []; const add = (file, message) => issues.push({ file, message: String(message).trim().slice(0, 700) });
  try {
    files = files.filter(f => f && typeof f.path === 'string' && (typeof f.content === 'string' || f.exists)).map(f => ({ path: safeName(f.path), content: f.content, exists: !!f.exists && typeof f.content !== 'string' })).filter(f => f.path);
    const paths = new Set(files.map(f => f.path));
    for (const f of files) {
      if (f.exists) continue;
      const p = path.join(dir, f.path);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, f.content);
    }
    let pkg = null;
    if (paths.has('package.json')) {
      try { pkg = JSON.parse(files.find(f => f.path === 'package.json').content); }
      catch (e) { add('package.json', 'Invalid JSON: ' + e.message); }
    }
    const deps = pkg ? Object.assign({}, pkg.dependencies, pkg.devDependencies, pkg.optionalDependencies, pkg.peerDependencies) : null;
    const jobs = [];
    let inl = 0;
    for (const f of files) {
      if (f.exists) continue;
      const ext = path.extname(f.path).toLowerCase();
      const abs = path.join(dir, f.path);
      if (/(^|\/)node_modules\//.test(f.path)) continue;
      if (ext === '.json') {
        if (f.path !== 'package.json') { try { JSON.parse(f.content); } catch (e) { add(f.path, 'Invalid JSON: ' + e.message); } }
      } else if (['.js', '.mjs', '.cjs'].includes(ext)) {
        jobs.push(run(process.execPath, ['--check', abs]).then(r => {
          if (r.err && r.stderr) add(f.path, r.stderr.split('\n').filter(l => !l.startsWith('Node.js v')).slice(0, 7).join('\n').replace(new RegExp(dir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), '.'));
        }));
        for (const m of f.content.matchAll(/(?:require\(\s*|from\s+|import\s+|import\(\s*)['"]([^'"\n]+)['"]/g)) {
          const spec = m[1];
          if (spec.startsWith('.')) { if (!resolveLocal(f.path, spec, paths)) add(f.path, 'Missing file: "' + spec + '" import/require hua hai par project me nahi hai.'); }
          else if (!spec.startsWith('node:') && !BUILTINS.has(spec.split('/')[0]) && deps && !(pkgName(spec) in deps) && !/^(https?:|data:)/.test(spec))
            add(f.path, 'Package "' + pkgName(spec) + '" use hua hai par package.json ke dependencies me nahi hai.');
        }
      } else if (ext === '.py') {
        const code = 'import ast,sys\ntry:\n    ast.parse(open(sys.argv[1],encoding="utf8").read(),sys.argv[1])\nexcept SyntaxError as e:\n    print("%s: line %s: %s" % (type(e).__name__, e.lineno, e.msg)); sys.exit(1)';
        jobs.push(run('python3', ['-I', '-c', code, abs]).then(async r => {
          if (r.err && r.err.code === 'ENOENT') { r = await run('python', ['-I', '-c', code, abs]); if (r.err && r.err.code === 'ENOENT') return; }
          if (r.err && (r.stdout || r.stderr)) add(f.path, (r.stdout || r.stderr).split('\n').slice(0, 4).join('\n'));
        }));
      } else if (['.html', '.htm'].includes(ext)) {
        for (const m of f.content.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
          const attrs = m[1], code = m[2];
          if (/\bsrc\s*=/.test(attrs) || !code.trim()) continue;
          const tm = attrs.match(/type\s*=\s*["']?([^"'\s>]+)/i);
          if (tm && !/^(module|text\/javascript|application\/javascript)$/i.test(tm[1])) continue;
          const isMod = tm && /module/i.test(tm[1]);
          const tmp = path.join(dir, '.inline', 'i' + (inl++) + (isMod ? '.mjs' : '.js'));
          fs.mkdirSync(path.dirname(tmp), { recursive: true }); fs.writeFileSync(tmp, code);
          jobs.push(run(process.execPath, ['--check', tmp]).then(r => {
            if (r.err && r.stderr) add(f.path, '<script> me JS error:\n' + r.stderr.split('\n').filter(l => !l.startsWith('Node.js v')).slice(0, 6).join('\n').replace(new RegExp(dir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), '.'));
          }));
        }
        for (const m of f.content.matchAll(/<(?:script|link|img|source|audio|video)\b[^>]*?\b(?:src|href)\s*=\s*["']([^"'#?]+)["']/gi)) {
          const ref = m[1].trim();
          if (!ref || /^([a-z][a-z0-9+.-]*:|\/\/|data:|#|\{\{|<%)/i.test(ref)) continue;
          const target = ref.startsWith('/') ? ref.slice(1) : path.posix.normalize(path.posix.join(path.posix.dirname(f.path), ref));
          if (!paths.has(target)) add(f.path, 'Missing file: "' + ref + '" HTML me link hai par project me nahi hai.');
        }
        const opens = (f.content.match(/<div\b/gi) || []).length, closes = (f.content.match(/<\/div>/gi) || []).length;
        if (Math.abs(opens - closes) > 2) add(f.path, '<div> tags balance nahi hain (' + opens + ' open, ' + closes + ' close).');
      } else if (ext === '.css') {
        const o = (f.content.replace(/\/\*[\s\S]*?\*\//g, '').match(/\{/g) || []).length, c = (f.content.replace(/\/\*[\s\S]*?\*\//g, '').match(/\}/g) || []).length;
        if (o !== c) add(f.path, 'CSS braces balance nahi hain ({ ' + o + ', } ' + c + ').');
      }
    }
    if (pkg) {
      if (pkg.main && !paths.has(path.posix.normalize(pkg.main))) add('package.json', '"main" file "' + pkg.main + '" project me nahi hai.');
      const st = pkg.scripts && pkg.scripts.start;
      const sm = st && st.match(/^node\s+(\S+\.(?:js|mjs|cjs))/);
      if (sm && !paths.has(path.posix.normalize(sm[1]))) add('package.json', 'start script ki file "' + sm[1] + '" project me nahi hai.');
    }
    for (let i = 0; i < jobs.length; i += 6) await Promise.all(jobs.slice(i, i + 6));
    return { ok: issues.length === 0, issues: issues.slice(0, 25), checked: files.length };
  } finally {
    fs.rm(dir, { recursive: true, force: true }, () => {});
  }
}

// ---------- HTML -> PDF (local Chrome / Chromium) ----------
let chromePath;
function findChrome() {
  if (chromePath !== undefined) return chromePath;
  const cands = [];
  if (process.env.CHROME_PATH) cands.push(process.env.CHROME_PATH);
  const names = ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'chrome', 'microsoft-edge', 'msedge'];
  const dirs = (process.env.PATH || '').split(path.delimiter);
  for (const n of names) for (const d of dirs) { cands.push(path.join(d, n)); cands.push(path.join(d, n + '.exe')); }
  cands.push('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe');
  chromePath = cands.find(c => { try { return fs.statSync(c).isFile(); } catch (_) { return false; } }) || null;
  return chromePath;
}
async function cdpPdf(chrome, fileUrl, dir) {
  const args = ['--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--no-first-run', '--no-default-browser-check',
    '--disable-extensions', '--disable-background-networking', '--disable-component-update', '--disable-sync', '--mute-audio', '--hide-scrollbars',
    '--remote-debugging-port=0', '--user-data-dir=' + path.join(dir, 'cdp-profile'), 'about:blank'];
  const ch = spawn(chrome, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
  try {
    const wsUrl = await new Promise((res, rej) => {
      let buf = ''; const to = setTimeout(() => rej(new Error('Chrome start timeout')), 20000);
      ch.stderr.on('data', d => { buf += d; const m = buf.match(/DevTools listening on (ws:\/\/\S+)/); if (m) { clearTimeout(to); res(m[1]); } });
      ch.on('exit', () => rej(new Error('Chrome exited'))); ch.on('error', rej);
    });
    const ws = new WebSocket(wsUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws error')); });
    let id = 0; const pend = new Map(); const events = [];
    ws.onmessage = e => {
      const m = JSON.parse(e.data);
      if (m.id && pend.has(m.id)) { const p = pend.get(m.id); pend.delete(m.id); m.error ? p.rej(new Error(m.error.message)) : p.res(m.result); } else events.push(m);
    };
    const call = (method, params = {}, sessionId) => new Promise((res, rej) => {
      const i = ++id; pend.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params, sessionId }));
      setTimeout(() => { if (pend.has(i)) { pend.delete(i); rej(new Error('CDP timeout: ' + method)); } }, 45000);
    });
    const { targetId } = await call('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await call('Target.attachToTarget', { targetId, flatten: true });
    await call('Page.enable', {}, sessionId);
    await call('Page.navigate', { url: fileUrl }, sessionId);
    const t0 = Date.now();
    while (!events.some(e => e.method === 'Page.loadEventFired' && e.sessionId === sessionId) && Date.now() - t0 < 25000) await sleep(60);
    await call('Runtime.evaluate', { expression: 'Promise.race([document.fonts.ready,new Promise(r=>setTimeout(r,6000))]).then(()=>1)', awaitPromise: true }, sessionId).catch(() => {});
    await sleep(250);
    const r = await call('Page.printToPDF', { printBackground: true, preferCSSPageSize: true, displayHeaderFooter: false, marginTop: 0, marginBottom: 0, marginLeft: 0, marginRight: 0 }, sessionId);
    try { ws.close(); } catch (_) {}
    return Buffer.from(r.data, 'base64');
  } finally { try { ch.kill('SIGKILL'); } catch (_) {} }
}
async function htmlToPdf(html) {
  const chrome = findChrome();
  if (!chrome) throw httpErr(501, 'Server par Chrome/Chromium nahi mila');
  const inject = '<style>*{-webkit-print-color-adjust:exact!important;print-color-adjust:exact!important}' +
    (/@page/i.test(html) ? '' : '@page{size:A4;margin:0}') + '</style>';
  html = /<head[^>]*>/i.test(html) ? html.replace(/<head[^>]*>/i, m => m + inject) : (/<html[^>]*>/i.test(html) ? html.replace(/<html[^>]*>/i, m => m + '<head><meta charset="utf-8">' + inject + '</head>') : '<!doctype html><html><head><meta charset="utf-8">' + inject + '</head><body>' + html + '</body></html>');
  if (!/<meta[^>]+charset/i.test(html)) html = html.replace(/<head[^>]*>/i, m => m + '<meta charset="utf-8">');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aipdf-'));
  try {
    const inFile = path.join(dir, 'in.html'), out = path.join(dir, 'out.pdf');
    fs.writeFileSync(inFile, html);
    if (typeof WebSocket !== 'undefined') { try { return await cdpPdf(chrome, pathToFileURL(inFile).href, dir); } catch (e) { console.error('[pdf] CDP failed, CLI fallback:', e.message); } }
    const args = ['--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--hide-scrollbars', '--no-pdf-header-footer',
      '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--disable-component-update', '--disable-sync',
      '--disable-extensions', '--disable-breakpad', '--metrics-recording-only', '--mute-audio',
      '--virtual-time-budget=12000', '--run-all-compositor-stages-before-draw', '--user-data-dir=' + path.join(dir, 'profile'),
      '--print-to-pdf=' + out, pathToFileURL(inFile).href];
    await new Promise(resolve => {
      const ch = spawn(chrome, args, { stdio: 'ignore', windowsHide: true });
      let lastSize = -1, done = false;
      const finish = () => { if (done) return; done = true; clearInterval(iv); clearTimeout(to); try { ch.kill('SIGKILL'); } catch (_) {} resolve(); };
      const iv = setInterval(() => {
        try { const sz = fs.statSync(out).size; if (sz > 0 && sz === lastSize) finish(); lastSize = sz; } catch (_) {}
      }, 400);
      const to = setTimeout(finish, 60000);
      ch.on('exit', () => setTimeout(finish, 200)); ch.on('error', finish);
    });
    if (!fs.existsSync(out) || fs.statSync(out).size === 0) throw httpErr(500, 'PDF ban nahi paayi (Chrome ne output nahi diya)');
    return fs.readFileSync(out);
  } finally {
    fs.rm(dir, { recursive: true, force: true }, () => {});
  }
}

// ---------- routes ----------
async function handleApi(req, res, url) {
  const p = url.pathname;
  if (APP_PASSWORD && p !== '/api/health' && req.headers['x-app-pass'] !== APP_PASSWORD)
    return sendJson(res, 401, { error: 'App password galat hai' });

  if (p === '/api/health') return sendJson(res, 200, { ok: true, chrome: !!findChrome(), hasEnvKey: !!ENV_KEY, passwordRequired: !!APP_PASSWORD, base: DEFAULT_BASE, node: process.version });

  if (p === '/api/models' && req.method === 'GET') {
    const key = getKey(req);
    if (!key) return sendJson(res, 401, { error: friendly(401) });
    try { return sendJson(res, 200, { models: await listModels(getBase(req), key) }); }
    catch (e) { return sendJson(res, e.status && e.status < 600 ? e.status : 502, { error: e.message || 'Models load nahi hue' }); }
  }

  if (p === '/api/chat' && req.method === 'POST') return handleChat(req, res);

  if (p === '/api/validate' && req.method === 'POST') {
    const b = JSON.parse((await readBody(req, 60 * 1024 * 1024)).toString('utf8'));
    return sendJson(res, 200, await validateProject(b.files || []));
  }

  if (p === '/api/pdf' && req.method === 'POST') {
    const b = JSON.parse((await readBody(req, 40 * 1024 * 1024)).toString('utf8'));
    if (!b.html || typeof b.html !== 'string') return sendJson(res, 400, { error: 'html missing' });
    try {
      const pdf = await htmlToPdf(b.html);
      res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Length': pdf.length, 'Cache-Control': 'no-store' });
      return res.end(pdf);
    } catch (e) { return sendJson(res, e.status || 500, { error: e.message }); }
  }

  if (p === '/api/zip' && req.method === 'POST') {
    const buf = await readBody(req);
    let meta, base = null;
    if (req.headers['x-framed'] === '1') {
      const jl = buf.readUInt32BE(0);
      meta = JSON.parse(buf.slice(4, 4 + jl).toString('utf8'));
      base = buf.slice(4 + jl);
    } else meta = JSON.parse(buf.toString('utf8'));
    const over = new Map();
    for (const f of meta.files || []) {
      const n = safeName(f.path); if (!n) continue;
      over.set(n, Buffer.from(f.content == null ? '' : String(f.content), f.base64 ? 'base64' : 'utf8'));
    }
    const del = new Set((meta.deleted || []).map(safeName));
    const entries = [];
    if (base && base.length) {
      for (const en of readZip(base)) {
        if (over.has(en.name) || del.has(en.name)) continue;
        entries.push(en);
      }
    }
    for (const [n, d] of over) entries.push(entryFromData(n, d));
    if (!entries.length) return sendJson(res, 400, { error: 'ZIP me koi file nahi hai' });
    const zip = buildZip(entries);
    const nm = (safeName(meta.name || 'project').replace(/[^\w.\-]+/g, '_') || 'project').replace(/\.zip$/i, '') + '.zip';
    res.writeHead(200, {
      'Content-Type': 'application/zip', 'Content-Length': zip.length,
      'Content-Disposition': 'attachment; filename="' + nm + '"', 'Cache-Control': 'no-store', 'X-Zip-Files': String(entries.length)
    });
    return res.end(zip);
  }

  if (p === '/api/extract' && req.method === 'POST') {
    const name = url.searchParams.get('name') || 'file';
    const buf = await readBody(req);
    const lower = name.toLowerCase();
    try {
      if (/\.(zip|jar)$/.test(lower) || (buf.length > 4 && buf.readUInt32LE(0) === 0x04034b50 && !/\.(docx|xlsx|pptx)$/.test(lower))) {
        const entries = readZip(buf);
        let textTotal = 0; const files = [];
        for (const en of entries) {
          if (/(^|\/)(node_modules|\.git|__pycache__|\.next|dist|build)\//.test(en.name) || /(^|\/)\.DS_Store$/.test(en.name) || /^__MACOSX\//.test(en.name)) { continue; }
          const f = { path: en.name, size: en.usize };
          if (en.usize <= 400 * 1024 && textTotal < 20 * 1024 * 1024) {
            try { const d = entryData(en); if (looksText(en.name, d)) { f.text = d.toString('utf8'); textTotal += d.length; } else f.binary = true; } catch (_) { f.binary = true; }
          } else f.binary = true;
          files.push(f);
        }
        return sendJson(res, 200, { kind: 'zip', files, total: buf.length });
      }
      const office = lower.match(/\.(docx|xlsx|pptx)$/);
      if (office) return sendJson(res, 200, { kind: 'text', text: officeText(office[1], readZip(buf)) });
      if (/\.pdf$/.test(lower)) {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aixt-'));
        try {
          const f = path.join(dir, 'in.pdf'); fs.writeFileSync(f, buf);
          const r = await run('pdftotext', ['-layout', f, '-'], 60000);
          if (r.err && r.err.code === 'ENOENT') return sendJson(res, 200, { kind: 'unsupported', message: 'PDF text nikalne ke liye server par pdftotext (poppler-utils) chahiye. Abhi PDF ke pages ka screenshot/image bhej dijiye.' });
          return sendJson(res, 200, { kind: 'text', text: r.stdout });
        } finally { fs.rm(dir, { recursive: true, force: true }, () => {}); }
      }
      return sendJson(res, 200, { kind: 'unsupported', message: 'Is file type ka text nahi nikal sakta.' });
    } catch (e) { return sendJson(res, e.status || 400, { error: e.message }); }
  }

  return sendJson(res, 404, { error: 'Not found' });
}

function serveStatic(req, res, url) {
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/') rel = '/index.html';
  const file = path.normalize(path.join(PUB, rel));
  if (!file.startsWith(PUB)) { res.writeHead(403); return res.end('Forbidden'); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname.startsWith('/api/')) await handleApi(req, res, url);
    else serveStatic(req, res, url);
  } catch (e) {
    console.error('[error]', req.method, url.pathname, e.message);
    if (!res.headersSent) sendJson(res, e.status || 500, { error: e.message || 'Server error' });
    else res.end();
  }
});
server.requestTimeout = 0;
server.headersTimeout = 60000;
server.keepAliveTimeout = 65000;
server.listen(PORT, () => {
  console.log('\n  ✨ AI Studio chal raha hai:  http://localhost:' + PORT);
  console.log('  API base : ' + DEFAULT_BASE);
  console.log('  API key  : ' + (ENV_KEY ? '.env se mili' : 'browser Settings me daalein'));
  console.log('  PDF      : ' + (findChrome() ? 'Chrome mila → vector PDF ✔' : 'Chrome nahi mila → browser-side PDF fallback') + '\n');
});
