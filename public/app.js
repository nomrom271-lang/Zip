'use strict';
/* AI Studio — frontend (vanilla JS, no build step) */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
const fmtSize = n => n < 1024 ? n + ' B' : n < 1048576 ? (n / 1024).toFixed(1) + ' KB' : (n / 1048576).toFixed(1) + ' MB';
const slug = s => (String(s || 'project').toLowerCase().replace(/[^a-z0-9ऀ-ॿ]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 40)) || 'project';

/* ---------------- storage ---------------- */
const LS = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (_) { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (_) {} }
};
const DEF = { key: '', base: '', mode: 'auto', model: '', codingMode: 'auto', autofix: true, pass: '', theme: 'auto', custom: '', temp: 0.5, maxTok: 16000, lang: 'hi-IN' };
let S = Object.assign({}, DEF, LS.get('ais_settings', {}));
const saveSettings = () => LS.set('ais_settings', S);

const idb = {
  db: null,
  open() {
    return new Promise(res => {
      try {
        const r = indexedDB.open('aistudio', 1);
        r.onupgradeneeded = () => r.result.createObjectStore('kv');
        r.onsuccess = () => { this.db = r.result; res(); };
        r.onerror = () => res();
      } catch (_) { res(); }
    });
  },
  get(k) {
    return new Promise(res => {
      if (!this.db) return res(undefined);
      try { const t = this.db.transaction('kv').objectStore('kv').get(k); t.onsuccess = () => res(t.result); t.onerror = () => res(undefined); } catch (_) { res(undefined); }
    });
  },
  set(k, v) {
    return new Promise(res => {
      if (!this.db) return res(false);
      try { const t = this.db.transaction('kv', 'readwrite'); t.objectStore('kv').put(v, k); t.oncomplete = () => res(true); t.onerror = () => res(false); } catch (_) { res(false); }
    });
  }
};

/* ---------------- state ---------------- */
let chats = [], cur = null, busy = false, abortCtl = null, health = {}, MODELS = [], atts = [];
const BL = {};      // code blocks by id
const PDFS = {};    // generated pdfs by block id
const newProject = () => ({ name: 'project', files: {}, changed: [], deleted: [], baseZip: null, binaries: [], assets: {} });
let saveT = null;
function saveSoon() { clearTimeout(saveT); saveT = setTimeout(() => { idb.set('chats', chats); LS.set('ais_cur', cur && cur.id); }, 500); }
function newChat(select = true) {
  const c = { id: uid(), title: 'Naya chat', messages: [], project: newProject(), updated: Date.now(), pinned: false };
  chats.unshift(c);
  if (select) cur = c;
  saveSoon(); return c;
}
function toast(msg, ms = 2600) {
  const t = document.createElement('div'); t.className = 'toast'; t.textContent = msg; document.body.appendChild(t);
  setTimeout(() => t.remove(), ms);
}
function hdr(extra) {
  const h = Object.assign({}, extra);
  if (S.key) h['x-api-key'] = S.key;
  if (S.base) h['x-base-url'] = S.base;
  if (S.pass) h['x-app-pass'] = S.pass;
  return h;
}
function saveBlob(blob, name) {
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 30000);
}
function applyTheme() { if (S.theme === 'auto') document.documentElement.removeAttribute('data-theme'); else document.documentElement.setAttribute('data-theme', S.theme); }

/* ---------------- markdown ---------------- */
function inline(s) {
  s = esc(s); const codes = [];
  s = s.replace(/`([^`\n]+)`/g, (_, c) => { codes.push(c); return '\u0000' + (codes.length - 1) + '\u0000'; });
  s = s.replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>').replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<i>$2</i>');
  s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => '<code>' + codes[i] + '</code>');
}
function md(t) {
  const L = t.split('\n'); let out = '', i = 0; const para = [];
  const flush = () => { if (para.length) { out += '<p>' + inline(para.join('\n')).replace(/\n/g, '<br>') + '</p>'; para.length = 0; } };
  const LI = /^\s*([-*+]|\d+\.)\s+/;
  while (i < L.length) {
    const l = L[i]; let m;
    if (!l.trim()) { flush(); i++; continue; }
    if ((m = l.match(/^(#{1,4})\s+(.*)$/))) { flush(); const n = m[1].length + 1; out += `<h${n}>${inline(m[2])}</h${n}>`; i++; continue; }
    if (/^\s*([-*_])\1{2,}\s*$/.test(l)) { flush(); out += '<hr>'; i++; continue; }
    if (/^\s*>/.test(l)) { flush(); const q = []; while (i < L.length && /^\s*>/.test(L[i])) { q.push(L[i].replace(/^\s*>\s?/, '')); i++; } out += '<blockquote>' + inline(q.join('\n')).replace(/\n/g, '<br>') + '</blockquote>'; continue; }
    if (LI.test(l)) { flush(); const ord = /^\s*\d+\./.test(l); const it = []; while (i < L.length && LI.test(L[i])) { it.push(L[i].replace(LI, '')); i++; } out += (ord ? '<ol>' : '<ul>') + it.map(x => '<li>' + inline(x) + '</li>').join('') + (ord ? '</ol>' : '</ul>'); continue; }
    if (l.includes('|') && i + 1 < L.length && /^\s*\|?\s*:?-{2,}/.test(L[i + 1])) {
      flush(); const row = r => r.replace(/^\s*\||\|\s*$/g, '').split('|').map(c => inline(c.trim()));
      const head = row(l); i += 2; const body = [];
      while (i < L.length && L[i].includes('|') && L[i].trim()) { body.push(row(L[i])); i++; }
      out += '<table><thead><tr>' + head.map(c => '<th>' + c + '</th>').join('') + '</tr></thead><tbody>' + body.map(r => '<tr>' + r.map(c => '<td>' + c + '</td>').join('') + '</tr>').join('') + '</tbody></table>'; continue;
    }
    para.push(l); i++;
  }
  flush(); return out;
}

/* ---------------- fenced block parser ---------------- */
function parseInfo(info) {
  const o = { lang: '', file: '', pdf: '', preview: false, del: false };
  info.split(/\s+/).filter(Boolean).forEach((t, i) => {
    let m;
    if ((m = t.match(/^(?:file|path|filename):(.+)$/i))) o.file = m[1].replace(/^["'`]|["'`]$/g, '');
    else if ((m = t.match(/^pdf:(.+)$/i))) o.pdf = m[1];
    else if (/^preview$/i.test(t)) o.preview = true;
    else if (i === 0 && !t.includes(':')) o.lang = t.toLowerCase();
  });
  if (o.lang === 'delete') o.del = true;
  return o;
}
function parseSegments(text) {
  const L = text.split('\n'), segs = []; let buf = [], i = 0;
  const flush = () => { if (buf.length) { const t = buf.join('\n'); if (t.trim()) segs.push({ type: 'text', text: t }); buf = []; } };
  while (i < L.length) {
    const m = L[i].match(/^(`{3,})\s*([^`]*)$/);
    if (!m) { buf.push(L[i]); i++; continue; }
    flush();
    const fence = m[1].length, info = m[2].trim(), body = []; let closed = false; i++;
    while (i < L.length) {
      const c = L[i].match(/^(`{3,})\s*$/);
      if (c && c[1].length >= fence) { closed = true; i++; break; }
      body.push(L[i]); i++;
    }
    segs.push({ type: 'code', info, o: parseInfo(info), code: body.join('\n'), closed });
  }
  flush(); return segs;
}
function cleanPath(p) {
  return String(p || '').replace(/\\/g, '/').split('/').filter(s => s && s !== '.' && s !== '..').join('/');
}
function compactAssistant(text) {
  return parseSegments(text).map(s => {
    if (s.type === 'text') return s.text;
    if (s.o.file && s.closed) return `[file written: ${cleanPath(s.o.file)} (${s.code.split('\n').length} lines)]`;
    if (s.o.pdf && s.closed) return `[pdf html written: ${s.o.pdf} (${s.code.length} chars)]`;
    if (s.o.file) return `[file ${cleanPath(s.o.file)} was cut off]`;
    if (s.code.length > 6000) return '```' + s.info + '\n' + s.code.slice(0, 2500) + '\n…(trimmed)\n```';
    return '```' + s.info + '\n' + s.code + '\n```';
  }).join('\n\n');
}

/* ---------------- system prompt ---------------- */
const SYSTEM = `You are "AI Studio" — an elite senior software engineer, UI/UX designer and print/PDF designer in one. You work inside an app that turns your output into real downloadable ZIP projects, live HTML previews and rendered PDFs. Be fast, precise and complete.

# LANGUAGE & STYLE
- Reply in the user's language (Hinglish/Hindi if they write that way). Keep chat text SHORT. The real work goes into files.
- After files: 3-6 short bullets (what was built, how to run). Never paste a file's code twice.

# FILES (this is how ZIPs are made)
To create or modify a project file, output a fenced block whose info string is: <lang> file:<relative/path>
\`\`\`js file:src/index.js
...COMPLETE file content...
\`\`\`
- ALWAYS write the COMPLETE file (never diffs, never "rest unchanged", never "..." or TODO placeholders).
- If a file itself contains triple backticks (e.g. README.md), wrap it in a FOUR-backtick fence.
- To change an existing file, output the whole updated file again. Only output files that changed.
- To delete files: a block \`\`\`delete with one path per line.
- Paths are relative, forward slashes, no leading "/". Keep each file under ~500 lines; split big code into modules.
- Every runnable project needs: README.md (setup + run), dependency file (package.json / requirements.txt), .env.example when env vars are used, .gitignore, and a start command.
- Only text files. For images use SVG/CSS, or reference user-uploaded assets listed under CURRENT PROJECT (assets/...).
- For "advanced / big" ZIPs create the full real structure (modules, config, tests, docs, sample data). Quality over filler — never pad with junk.

# QUALITY BAR (coding)
- Production-grade: input validation, error handling, logging, clean architecture, secure defaults, comments only where useful.
- Before answering, mentally run the code: every import exists, every referenced file is created, every dependency is listed, no syntax errors.
- The app auto-checks your files (syntax, JSON, missing imports/files, missing dependencies) and will send you the errors. When that happens, fix ALL listed errors and re-output ONLY the changed files in full.
- If a previous reply was cut off, rewrite the unfinished file from the start (complete) and continue with remaining files.

# DESIGN (web UI)
- Output single-file or multi-file responsive HTML/CSS/JS. Mobile-first, modern typography, spacing system, real gradients/shadows, accessible contrast, smooth micro-animations, dark/light aware. No lorem ipsum; write real copy.
- For a quick visual preview in chat use a block: \`\`\`html preview  (one self-contained HTML document). For projects use file blocks.

# PDF DESIGN
- When asked for a PDF, output ONE block: \`\`\`html pdf:file-name.pdf  containing a complete standalone HTML document designed for print. The app renders it to a real vector PDF and shows it in chat. Do not explain the code.
- Use @page{size:A4;margin:0}; each page = <section class="page"> exactly 210mm x 297mm, overflow:hidden, page-break-after:always; -webkit-print-color-adjust:exact.
- Fonts via Google Fonts <link> (Noto Sans Devanagari / Noto Serif Devanagari for Hindi; Inter, Poppins, Playfair Display for English). Inline CSS only; icons/graphics via inline SVG or CSS.
- Premium look: cover page, clear typographic hierarchy, consistent grid & margins, coloured section headers, tables/callouts/badges, header/footer with page numbers, no blank pages, no clipped text. Hindi text must be proper Devanagari with comfortable line-height.
- To change a PDF the user already has, output the full updated HTML block again.

# IMAGES
- When the user sends an image: analyse it deeply — read ALL visible text exactly (OCR, Hindi/English), describe layout/colours/fonts, point out errors/bugs/issues (for code or error screenshots give the root cause and the fixed file), and for design references rebuild them in HTML/CSS when asked.

# ZIP LOADED BY USER
- If a project is loaded under CURRENT PROJECT, read it carefully, keep its style and structure, and modify only what is asked.`;

function projectCtx(chat) {
  const p = chat.project; const fk = Object.keys(p.files), ak = Object.keys(p.assets);
  if (!fk.length && !p.binaries.length && !ak.length) return '';
  let s = `\n\n# CURRENT PROJECT: ${p.name}\nText files (${fk.length}):\n`;
  fk.slice(0, 400).forEach(k => { s += `- ${k} (${fmtSize(p.files[k].length)})${p.changed.includes(k) ? ' *changed*' : ''}\n`; });
  if (fk.length > 400) s += `- …+${fk.length - 400} more\n`;
  if (p.binaries.length) s += `Other/binary files in the ZIP (untouched): ` + p.binaries.slice(0, 120).map(b => b.path + ' ' + fmtSize(b.size)).join(', ') + (p.binaries.length > 120 ? ` …+${p.binaries.length - 120}` : '') + '\n';
  if (ak.length) s += `User assets (usable by path): ` + ak.map(k => k + ' ' + fmtSize(p.assets[k].size)).join(', ') + '\n';
  let budget = 130000;
  const order = fk.slice().sort((a, b) => (p.changed.includes(b) - p.changed.includes(a)) || (p.files[a].length - p.files[b].length));
  const omitted = [];
  for (const k of order) {
    const c = p.files[k];
    if (c.length + k.length + 20 > budget) { omitted.push(k); continue; }
    budget -= c.length + k.length + 20;
    s += `\n### ${k}\n\`\`\`\`\n${c}\n\`\`\`\`\n`;
  }
  if (omitted.length) s += `\n(Contents omitted for size: ${omitted.slice(0, 60).join(', ')}. Ask the user if you need them.)\n`;
  return s;
}
function apiMessages(chat) {
  const sys = SYSTEM + (S.custom.trim() ? '\n\n# USER CUSTOM INSTRUCTIONS\n' + S.custom.trim() : '') + projectCtx(chat);
  const out = [{ role: 'system', content: sys }];
  const imgIdx = chat.messages.map((m, i) => (m.images && m.images.length ? i : -1)).filter(i => i >= 0).slice(-2);
  const push = (role, content) => {
    const last = out[out.length - 1];
    if (last.role === role && typeof last.content === 'string' && typeof content === 'string') last.content += '\n\n' + content;
    else out.push({ role, content });
  };
  chat.messages.forEach((m, i) => {
    if (m.role === 'user') {
      const t = (m.text || '') + (m.attText || '');
      if (m.images && m.images.length) {
        if (imgIdx.includes(i)) {
          out.push({ role: 'user', content: [{ type: 'text', text: t || 'Is image ko detail me analyze karo.' }].concat(m.images.map(u => ({ type: 'image_url', image_url: { url: u } }))) });
        } else push('user', t + `\n[${m.images.length} image(s) were attached here]`);
      } else push('user', t || '.');
    } else if (m.role === 'assistant' && !m.err && m.text) push('assistant', compactAssistant(m.text));
  });
  let total = 0; out.forEach(o => total += typeof o.content === 'string' ? o.content.length : 2000);
  while (total > 320000 && out.length > 3) { const r = out.splice(1, 1)[0]; total -= typeof r.content === 'string' ? r.content.length : 2000; }
  if (out[1] && out[1].role === 'assistant') out.splice(1, 1);
  return out;
}
function wantCoding(chat) {
  if (S.codingMode === 'on') return true;
  if (S.codingMode === 'off') return false;
  const last = [...chat.messages].reverse().find(m => m.role === 'user' && !m.auto);
  const t = ((last && last.text) || '') + ' ' + ((last && last.attText) || '');
  return Object.keys(chat.project.files).length > 0 || /zip|code|coding|\bapp\b|\bbot\b|script|bug|error|fix|\bapi\b|python|node|java|html|css|react|flask|django|website|server|telegram|github|deploy|function|class|sql|json|\.js|\.py/i.test(t);
}

/* ---------------- file apply / undo ---------------- */
function applyFiles(chat, m, segs) {
  const p = chat.project, undo = { files: {}, wasChanged: {}, deleted: [] }, paths = [];
  const remember = path => {
    if (!(path in undo.files)) { undo.files[path] = (path in p.files) ? p.files[path] : null; undo.wasChanged[path] = p.changed.includes(path); }
  };
  for (const s of segs) {
    if (s.type !== 'code' || !s.closed) continue;
    if (s.o.del) {
      s.code.split('\n').map(cleanPath).filter(Boolean).forEach(path => {
        remember(path); delete p.files[path]; p.changed = p.changed.filter(x => x !== path);
        if (!p.deleted.includes(path)) { p.deleted.push(path); undo.deleted.push(path); }
        paths.push('✕ ' + path);
      });
      continue;
    }
    if (!s.o.file) continue;
    const path = cleanPath(s.o.file); if (!path) continue;
    remember(path);
    p.files[path] = s.code.endsWith('\n') ? s.code : s.code + '\n';
    if (!p.changed.includes(path)) p.changed.push(path);
    p.deleted = p.deleted.filter(x => x !== path);
    if (!paths.includes(path)) paths.push(path);
  }
  m.files = paths; if (paths.length) m.undo = undo;
  if (paths.length && p.name === 'project') p.name = slug(chat.title);
  return paths;
}
function applyUndo(chat, m) {
  if (!m.undo) return;
  const p = chat.project, u = m.undo;
  for (const path of Object.keys(u.files)) {
    if (u.files[path] === null) { delete p.files[path]; p.changed = p.changed.filter(x => x !== path); }
    else { p.files[path] = u.files[path]; if (u.wasChanged[path] && !p.changed.includes(path)) p.changed.push(path); if (!u.wasChanged[path]) p.changed = p.changed.filter(x => x !== path); }
  }
  p.deleted = p.deleted.filter(x => !u.deleted.includes(x));
  m.undo = null; m.undone = true;
}
function rollbackFrom(chat, idx) {
  for (let i = chat.messages.length - 1; i >= idx; i--) { const m = chat.messages[i]; if (m.role === 'assistant' && m.undo) applyUndo(chat, m); }
}

/* ---------------- rendering ---------------- */
const wrap = $('#wrap'), msgsEl = $('#msgs'), inp = $('#inp');
function hello() {
  return `<div class="hello"><h1>✦ AI Studio</h1><p>Code • ZIP projects • Design • Premium PDF • Image analyzer</p>
  <div class="chips">${TEMPLATES.slice(0, 6).map((t, i) => `<div class="chip" data-act="tpl" data-i="${i}">${esc(t.t)}<small>${esc(t.s)}</small></div>`).join('')}</div></div>`;
}
function metaHTML(m, last) {
  let h = '<div class="meta">';
  if (m.role === 'assistant') {
    if (m.model) h += `<span>🤖 ${esc(m.model)}</span>`;
    if (m.dur) { const tk = (m.usage && m.usage.completion_tokens) || Math.round((m.text || '').length / 3.6); h += `<span>${(m.dur / 1000).toFixed(1)}s • ~${tk} tok${m.dur > 500 ? ' • ' + Math.round(tk / (m.dur / 1000)) + ' t/s' : ''}</span>`; }
    h += `<button class="ghost" data-act="copy" data-id="${m.id}">⧉ Copy</button><button class="ghost" data-act="speak" data-id="${m.id}">🔊</button>`;
    if (last) h += `<button class="ghost" data-act="regen" data-id="${m.id}">↻ Dobara</button>`;
  } else if (!m.auto) h += `<button class="ghost" data-act="edit" data-id="${m.id}">✎ Edit</button>`;
  return h + '</div>';
}
function zipCard(m) {
  const p = cur.project, n = Object.keys(p.files).length + p.binaries.length;
  const hasIdx = Object.keys(p.files).some(k => /(^|\/)index\.html?$/i.test(k));
  return `<div class="zipcard"><b>📦 ${esc(p.name)}.zip — ${n} files <span class="mut">(${m.files.filter(x => x[0] !== '✕').length} naye/badle)</span></b>
    <button class="pri" data-act="zip">⬇ ZIP download</button><button data-act="proj">📁 Files</button>${hasIdx ? '<button data-act="live">▶ Live Preview</button>' : ''}${m.undo ? `<button data-act="undo" data-id="${m.id}">↩ Undo</button>` : ''}${m.undone ? '<span class="mut">↩ undo ho gaya</span>' : ''}</div>`;
}
function asstHTML(m, last) {
  const segs = parseSegments(m.text || ''); let h = '', bi = 0;
  for (const s of segs) {
    if (s.type === 'text') { h += md(s.text); continue; }
    const bid = m.id + ':' + (bi++); BL[bid] = s.code; const o = s.o;
    if (o.del) { h += `<div class="fchip"><span>🗑</span><span class="n">${esc(s.code.split('\n').filter(Boolean).join(', '))}</span><span class="s">delete</span></div>`; }
    else if (o.file) {
      const n = s.code ? s.code.split('\n').length : 0;
      h += `<div class="fchip${s.closed ? '' : ' w'}"><span>${s.closed ? '📄' : '✍'}</span><span class="n">${esc(o.file)}</span><span class="s">${s.closed ? n + ' lines · ' + fmtSize(s.code.length) : 'likh raha hai… ' + n + ' lines'}</span>${s.closed ? `<button data-act="vf" data-bid="${bid}" data-p="${esc(o.file)}">View</button><button data-act="cp" data-bid="${bid}">Copy</button>${/\.html?$/i.test(o.file) ? `<button data-act="pvbid" data-bid="${bid}">▶</button>` : ''}` : ''}</div>`;
    } else if (o.pdf) {
      h += `<div class="pdfcard" data-bid="${bid}" data-name="${esc(o.pdf)}"><div class="ph"><span>📄 ${esc(o.pdf)}</span>${m.done && s.closed ? `<button data-act="pdfdl" data-bid="${bid}">⬇ PDF</button><button data-act="pdfadd" data-bid="${bid}">📦 ZIP me jodo</button><button data-act="pdfhtml" data-bid="${bid}">⬇ HTML</button><button data-act="pdfre" data-bid="${bid}">↻</button>` : ''}</div><div class="pages"><div class="st dots">${m.done && s.closed ? 'PDF ban rahi hai' : 'PDF design likh raha hoon'}</div></div></div>`;
    } else if (o.lang === 'html' && o.preview) {
      h += m.done && s.closed
        ? `<div class="pv" data-bid="${bid}"><div class="ph"><span>▶ Live preview</span><button data-act="pvopen" data-bid="${bid}">⛶ Open</button><button data-act="dlh" data-bid="${bid}">⬇ HTML</button><button data-act="cp" data-bid="${bid}">Copy code</button></div><iframe sandbox="allow-scripts allow-forms allow-modals allow-popups"></iframe></div>`
        : `<div class="fchip w"><span>✍</span><span class="n">HTML design</span><span class="s">likh raha hai…</span></div>`;
    } else {
      h += `<div class="code"><div class="ch"><span>${esc(o.lang || 'code')}</span>${o.lang === 'html' && s.closed ? `<button data-act="pvtoggle" data-bid="${bid}">▶ Preview</button>` : ''}<button data-act="cp" data-bid="${bid}">Copy</button></div><pre><code>${esc(s.code)}</code></pre></div>`;
    }
  }
  if (!m.done && !m.text) h += `<div class="mut dots">${esc(m.status || 'soch raha hoon')}</div>`;
  else if (!m.done && m.status) h += `<div class="mut dots">${esc(m.status)}</div>`;
  (m.notes || []).forEach(n => h += `<div class="mut" style="font-size:12.5px">↪ ${esc(n)}</div>`);
  if (m.err) h += `<div class="err"><span>⚠ ${esc(m.err)}</span><button data-act="retry" data-id="${m.id}">↻ Dobara try</button><button data-act="settings">⚙ Settings</button></div>`;
  if (m.aborted) h += `<div class="mut">⏹ Roka gaya</div>`;
  if (m.files && m.files.length) h += zipCard(m);
  if (m.fix) {
    if (m.fix.state === 'run') h += '<div class="fix run dots">🔍 Auto-check chal raha hai</div>';
    else if (m.fix.state === 'ok') h += '<div class="fix ok">✅ Auto-check pass — syntax, imports, files sab theek</div>';
    else h += `<div class="fix bad">⚠ ${m.fix.issues.length} issue mile${m.fix.fixing ? ' — auto-fix chal raha hai…' : ''}<br>${m.fix.issues.slice(0, 6).map(i => '• <b>' + esc(i.file) + '</b>: ' + esc(i.message.split('\n')[0])).join('<br>')}</div>`;
  }
  if (m.done) h += metaHTML(m, last);
  return h;
}
function msgHTML(m, last) {
  if (m.role === 'user') {
    if (m.auto) return `<div class="m sys" data-id="${m.id}"><div class="bub">${esc(m.label || m.text)}</div></div>`;
    let h = '';
    if (m.images && m.images.length) h += '<div class="thumbs">' + m.images.map(u => `<img src="${u}" data-act="zoom" alt="">`).join('') + '</div>';
    (m.atts || []).forEach(a => h += `<span class="tag">📎 ${esc(a)}</span>`);
    h += (h ? '<br>' : '') + esc(m.text || '');
    return `<div class="m u" data-id="${m.id}"><div class="bub">${h}${metaHTML(m)}</div></div>`;
  }
  return `<div class="m a" data-id="${m.id}"><div class="bub">${asstHTML(m, last)}</div></div>`;
}
function renderMsgs() {
  if (!cur || !cur.messages.length) { wrap.innerHTML = hello(); return; }
  const lastA = [...cur.messages].reverse().find(m => m.role === 'assistant');
  wrap.innerHTML = cur.messages.map(m => msgHTML(m, m === lastA && !busy)).join('');
  hydrate(wrap); msgsEl.scrollTop = msgsEl.scrollHeight;
}
function updateMsg(m, force) {
  const el = wrap.querySelector(`.m[data-id="${m.id}"]`); if (!el) return;
  const near = msgsEl.scrollHeight - msgsEl.scrollTop - msgsEl.clientHeight < 160;
  const lastA = [...cur.messages].reverse().find(x => x.role === 'assistant');
  const bub = el.querySelector('.bub'); bub.innerHTML = m.role === 'assistant' ? asstHTML(m, m === lastA && !busy) : bub.innerHTML;
  if (m.done || force) hydrate(el);
  if (near) msgsEl.scrollTop = msgsEl.scrollHeight;
}
let raf = 0;
function scheduleUpdate(m) { if (raf) return; raf = requestAnimationFrame(() => { raf = 0; updateMsg(m); }); }
function appendMsg(m) {
  if (wrap.querySelector('.hello')) wrap.innerHTML = '';
  wrap.insertAdjacentHTML('beforeend', msgHTML(m, false)); msgsEl.scrollTop = msgsEl.scrollHeight;
}
function renderList() {
  const q = ($('#chatSearch').value || '').toLowerCase();
  const list = chats.filter(c => !q || c.title.toLowerCase().includes(q) || c.messages.some(m => (m.text || '').toLowerCase().includes(q)))
    .sort((a, b) => (b.pinned - a.pinned) || (b.updated - a.updated));
  $('#chatList').innerHTML = list.map(c => `<div class="ci${cur && c.id === cur.id ? ' on' : ''}" data-act="pick" data-id="${c.id}"><span>${c.pinned ? '⭐ ' : ''}${esc(c.title)}</span><b data-act="pin" data-id="${c.id}" title="Pin">☆</b><b data-act="ren" data-id="${c.id}" title="Rename">✎</b><b data-act="del" data-id="${c.id}" title="Delete">✕</b></div>`).join('') || '<div class="mut" style="padding:10px">Koi chat nahi</div>';
}
function updateProjBadge() {
  const p = cur ? cur.project : null;
  $('#projCnt').textContent = p ? Object.keys(p.files).length + p.binaries.length + Object.keys(p.assets).length : 0;
}
function renderAll() { renderList(); renderMsgs(); updateProjBadge(); syncMode(); }
function syncMode() {
  $$('#modeSeg button').forEach(b => b.classList.toggle('on', b.dataset.m === S.mode));
  $('#modelIn').style.display = S.mode === 'manual' ? '' : 'none';
  $('#modelIn').value = S.model || '';
}

/* ---------------- hydrate (previews / pdf) ---------------- */
function hydrate(root) {
  $$('.pv[data-bid]', root).forEach(el => { const f = $('iframe', el); if (f && !f.dataset.d) { f.dataset.d = 1; f.srcdoc = BL[el.dataset.bid] || ''; } });
  $$('.pdfcard[data-bid]', root).forEach(el => {
    if (el.dataset.d || !el.querySelector('[data-act="pdfdl"]')) return;
    el.dataset.d = 1; makePdf(el.dataset.bid, el);
  });
}
let pdfjsP = null;
function loadPdfjs() {
  if (window.pdfjsLib) return Promise.resolve();
  if (pdfjsP) return pdfjsP;
  pdfjsP = new Promise((res, rej) => {
    const s = document.createElement('script'); s.src = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js';
    s.onload = () => { try { pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js'; res(); } catch (e) { rej(e); } };
    s.onerror = () => rej(new Error('pdf.js load fail')); document.head.appendChild(s);
  });
  return pdfjsP;
}
async function renderPdf(box, blob) {
  try {
    await loadPdfjs();
    const doc = await pdfjsLib.getDocument({ data: new Uint8Array(await blob.arrayBuffer()) }).promise;
    box.innerHTML = ''; const w = Math.min(box.clientWidth - 24 || 700, 820), dpr = Math.min(window.devicePixelRatio || 1, 2);
    for (let i = 1; i <= Math.min(doc.numPages, 40); i++) {
      const pg = await doc.getPage(i), v0 = pg.getViewport({ scale: 1 }), sc = w / v0.width, v = pg.getViewport({ scale: sc * dpr });
      const c = document.createElement('canvas'); c.width = v.width; c.height = v.height; c.style.width = w + 'px';
      box.appendChild(c); await pg.render({ canvasContext: c.getContext('2d'), viewport: v }).promise;
    }
    if (doc.numPages > 40) box.insertAdjacentHTML('beforeend', `<div class="mut">…${doc.numPages} pages hain — baaki download me</div>`);
  } catch (_) {
    box.innerHTML = ''; const f = document.createElement('iframe'); f.style.cssText = 'width:100%;height:620px;border:0;background:#fff'; f.src = URL.createObjectURL(blob); box.appendChild(f);
  }
}
async function makePdf(bid, card, force) {
  const box = $('.pages', card), html = BL[bid] || '';
  if (!force && PDFS[bid] && PDFS[bid].blob) return renderPdf(box, PDFS[bid].blob);
  box.innerHTML = '<div class="st dots">PDF ban rahi hai</div>';
  if (!health.chrome) {
    box.innerHTML = ''; const f = document.createElement('iframe'); f.style.cssText = 'width:100%;height:640px;border:0;background:#fff'; f.srcdoc = html; box.appendChild(f);
    box.insertAdjacentHTML('afterbegin', '<div class="mut" style="font-size:12.5px">Server par Chrome nahi hai → upar ⬇ HTML ya browser Print (Ctrl+P) se PDF save karein.</div>');
    PDFS[bid] = { html }; return;
  }
  try {
    const r = await fetch('/api/pdf', { method: 'POST', headers: hdr({ 'Content-Type': 'application/json' }), body: JSON.stringify({ html }) });
    if (!r.ok) { let j = {}; try { j = await r.json(); } catch (_) {} throw new Error(j.error || 'PDF error ' + r.status); }
    const blob = await r.blob(); PDFS[bid] = { blob, html }; await renderPdf(box, blob);
  } catch (e) { box.innerHTML = `<div class="st" style="color:var(--danger)">⚠ ${esc(e.message)}</div>`; }
}

/* ---------------- validate + chat run ---------------- */
async function validateProject(chat) {
  const p = chat.project, files = [];
  for (const [path, content] of Object.entries(p.files)) files.push(p.changed.includes(path) || path === 'package.json' ? { path, content } : { path, exists: true });
  p.binaries.forEach(b => files.push({ path: b.path, exists: true }));
  Object.keys(p.assets).forEach(a => files.push({ path: a, exists: true }));
  const r = await fetch('/api/validate', { method: 'POST', headers: hdr({ 'Content-Type': 'application/json' }), body: JSON.stringify({ files }) });
  if (!r.ok) throw new Error('validate ' + r.status);
  return r.json();
}
function setBusy(b) {
  busy = b; const sb = $('#sendBtn'); sb.textContent = b ? '■' : '➤'; sb.title = b ? 'Roko' : 'Bhejo'; sb.classList.toggle('pri', true);
}
async function runAssistant(chat, auto) {
  const m = { id: uid(), role: 'assistant', text: '', model: '', t: Date.now(), status: '', done: false, notes: [] };
  chat.messages.push(m); appendMsg(m);
  const ac = new AbortController(); abortCtl = ac;
  try {
    const body = JSON.stringify({
      messages: apiMessages(chat), mode: S.mode, model: S.model,
      vision: chat.messages.some((x, i) => x.images && x.images.length && i >= chat.messages.length - 4),
      coding: wantCoding(chat), max_tokens: S.maxTok, temperature: S.temp
    });
    const r = await fetch('/api/chat', { method: 'POST', headers: hdr({ 'Content-Type': 'application/json' }), body, signal: ac.signal });
    if (!r.ok) { let j = {}; try { j = await r.json(); } catch (_) {} throw Object.assign(new Error(j.error || 'Error ' + r.status), { code: r.status }); }
    const rd = r.body.getReader(), dec = new TextDecoder(); let buf = '';
    for (;;) {
      const { done, value } = await rd.read(); if (done) break;
      buf += dec.decode(value, { stream: true }); let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const ev = buf.slice(0, i); buf = buf.slice(i + 2);
        const line = ev.split('\n').find(l => l.startsWith('data:')); if (!line) continue;
        let o; try { o = JSON.parse(line.slice(5)); } catch (_) { continue; }
        if (o.t === 'start') { m.model = o.model; m.status = ''; }
        else if (o.t === 'think') m.status = 'soch raha hoon';
        else if (o.t === 'delta') { m.text += o.x; m.status = ''; }
        else if (o.t === 'note') m.notes.push(o.message);
        else if (o.t === 'done') { m.model = o.model || m.model; m.finish = o.finish; m.usage = o.usage; }
        else if (o.t === 'error') throw Object.assign(new Error(o.message), { code: o.code });
        scheduleUpdate(m);
      }
    }
  } catch (e) {
    if (e.name === 'AbortError') m.aborted = true; else { m.err = e.message || String(e); if (/App password/i.test(m.err)) { $('#passF').style.display = ''; openSettings(); } }
  }
  m.dur = Date.now() - m.t; m.done = true; m.status = '';
  chat.updated = Date.now();
  await afterAssistant(chat, m, auto);
}
async function afterAssistant(chat, m, auto) {
  const segs = parseSegments(m.text || '');
  const changed = m.err || m.aborted ? [] : applyFiles(chat, m, segs);
  updateProjBadge();
  if (m.err || m.aborted) { updateMsg(m, true); saveSoon(); renderList(); return; }
  const last = segs[segs.length - 1];
  const cut = last && last.type === 'code' && !last.closed && (last.o.file || last.o.pdf || last.o.lang === 'html');
  if (cut && auto.cont < 2) {
    m.notes.push('Jawab beech me kat gaya — adhoori file dobara likhwa raha hoon…'); updateMsg(m, true);
    chat.messages.push({ id: uid(), role: 'user', auto: true, text: 'Tumhara pichla jawab length limit par beech me kat gaya. Jo file adhoori thi use shuru se POORA dobara likho (chhoti files me todo), aur jo files abhi baaki hain unhe bhi likho.', label: '↪ Auto-continue: adhoori file dobara' });
    appendMsg(chat.messages[chat.messages.length - 1]);
    return runAssistant(chat, { fix: auto.fix, cont: auto.cont + 1 });
  }
  if (changed.some(x => x[0] !== '✕') && S.autofix) {
    m.fix = { state: 'run' }; updateMsg(m, true);
    try {
      const v = await validateProject(chat);
      if (v.ok) m.fix = { state: 'ok' };
      else if (auto.fix < 3) {
        m.fix = { state: 'bad', issues: v.issues, fixing: true }; updateMsg(m, true);
        const txt = 'Auto-check ne yeh errors paaye (round ' + (auto.fix + 1) + '/3):\n' + v.issues.map(i => `- ${i.file}: ${i.message}`).join('\n') + '\n\nIn sabko theek karo. Sirf badli hui files POORI dobara likho.';
        chat.messages.push({ id: uid(), role: 'user', auto: true, text: txt, label: '🔧 Auto-fix round ' + (auto.fix + 1) + ': ' + v.issues.length + ' issue bhej raha hoon' });
        appendMsg(chat.messages[chat.messages.length - 1]); saveSoon();
        return runAssistant(chat, { fix: auto.fix + 1, cont: auto.cont });
      } else m.fix = { state: 'bad', issues: v.issues };
    } catch (_) { m.fix = null; }
  }
  updateMsg(m, true); saveSoon(); renderList();
}
async function runChain(chat) {
  setBusy(true);
  try { await runAssistant(chat, { fix: 0, cont: 0 }); } finally { setBusy(false); abortCtl = null; renderMsgs(); saveSoon(); }
}

/* ---------------- attachments ---------------- */
const TEXT_EXT = /\.(txt|md|markdown|json|jsonc|js|mjs|cjs|jsx|ts|tsx|css|scss|less|html?|xml|svg|csv|tsv|ya?ml|toml|ini|cfg|conf|env|py|rb|php|java|kt|go|rs|c|h|cpp|hpp|cs|swift|sh|bat|sql|vue|svelte|log|tex|srt|gradle|dart|lua|r)$/i;
function renderAtts() {
  const box = $('#atts'); box.style.display = atts.length ? '' : 'none';
  box.innerHTML = atts.map(a => `<div class="att" data-id="${a.id}">${a.kind === 'image' ? `<img src="${a.dataUrl}" alt="">` : a.kind === 'zip' ? '📦' : '📄'}<span class="nm" title="${esc(a.name)}">${esc(a.name)}</span><span class="mut">${a.status === 'loading' ? (a.progress != null ? '<progress max="100" value="' + a.progress + '"></progress>' : '…') : a.status === 'err' ? '⚠ ' + esc(a.msg || '') : a.info || fmtSize(a.size)}</span>${a.kind !== 'zip' && a.status !== 'loading' ? `<label title="ZIP/project me file ke roop me jodo"><input type="checkbox" data-act="addzip" ${a.add ? 'checked' : ''}>ZIP</label>` : ''}<span class="x" data-act="rmatt">✕</span></div>`).join('');
}
async function imgToDataUrl(file, max = 1600) {
  const bmp = await createImageBitmap(file); const sc = Math.min(1, max / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas'); c.width = Math.round(bmp.width * sc); c.height = Math.round(bmp.height * sc);
  const x = c.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, c.width, c.height); x.drawImage(bmp, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', 0.86);
}
function xhrExtract(file, onProg) {
  return new Promise((res, rej) => {
    const x = new XMLHttpRequest(); x.open('POST', '/api/extract?name=' + encodeURIComponent(file.name));
    Object.entries(hdr()).forEach(([k, v]) => x.setRequestHeader(k, v));
    x.upload.onprogress = e => { if (e.lengthComputable) onProg(Math.round(e.loaded * 100 / e.total)); };
    x.onload = () => { let j = {}; try { j = JSON.parse(x.responseText); } catch (_) {} x.status < 300 ? res(j) : rej(new Error(j.error || 'Upload error ' + x.status)); };
    x.onerror = () => rej(new Error('Network error')); x.send(file);
  });
}
async function processFiles(files) {
  for (const f of files) {
    if (f.size > 150 * 1048576) { toast(f.name + ': 150 MB se badi file'); continue; }
    const a = { id: uid(), name: f.name, size: f.size, file: f, kind: 'asset', status: 'loading', add: false };
    atts.push(a); renderAtts();
    try {
      if (/\.zip$/i.test(f.name) || f.type === 'application/zip' || f.type === 'application/x-zip-compressed') {
        a.kind = 'zip';
        const res = await xhrExtract(f, p => { a.progress = p; renderAtts(); });
        if (res.kind !== 'zip') throw new Error('ZIP read nahi hui');
        a.info = res.files.length + ' files'; a.zipRes = res;
      } else if (f.type.startsWith('image/')) {
        a.kind = 'image'; a.dataUrl = await imgToDataUrl(f);
      } else if (TEXT_EXT.test(f.name) || f.type.startsWith('text/')) {
        if (f.size > 1.5 * 1048576) { a.kind = 'asset'; a.add = true; a.info = 'badi file → ZIP asset'; }
        else { a.kind = 'text'; a.text = await f.text(); }
      } else if (/\.(docx|xlsx|pptx|pdf)$/i.test(f.name)) {
        const r = await fetch('/api/extract?name=' + encodeURIComponent(f.name), { method: 'POST', headers: hdr(), body: f });
        const j = await r.json(); if (!r.ok) throw new Error(j.error || 'extract error');
        if (j.kind === 'unsupported') { a.kind = 'asset'; a.add = true; a.info = j.message.slice(0, 60); } else { a.kind = 'text'; a.text = j.text || ''; a.info = (a.text.length / 1000).toFixed(0) + 'k chars'; }
      } else { if (f.size > 12 * 1048576) throw new Error('12 MB se badi binary asset'); a.kind = 'asset'; a.add = true; }
      a.status = 'ok';
    } catch (e) { a.status = 'err'; a.msg = e.message; }
    renderAtts();
  }
}
function loadZipIntoProject(chat, a) {
  const p = chat.project, res = a.zipRes;
  const texts = res.files.filter(f => f.text != null), bins = res.files.filter(f => f.text == null);
  const np = newProject(); np.name = slug(a.name.replace(/\.zip$/i, '')); np.baseZip = a.file;
  texts.forEach(f => np.files[cleanPath(f.path)] = f.text);
  np.binaries = bins.map(f => ({ path: cleanPath(f.path), size: f.size }));
  np.assets = p.assets;
  chat.project = np; updateProjBadge();
}

/* ---------------- send ---------------- */
async function send() {
  if (busy) { if (abortCtl) abortCtl.abort(); return; }
  const text = inp.value.trim();
  if (!text && !atts.length) return;
  if (atts.some(a => a.status === 'loading')) return toast('File load ho rahi hai…');
  if (S.mode === 'manual' && !S.model.trim()) return toast('Manual mode me pehle model chuno');
  if (!S.key && !health.hasEnvKey) { openSettings(); return toast('Pehle API key daalo'); }
  const chat = cur; const p = chat.project;
  const zipAtt = atts.find(a => a.kind === 'zip' && a.status === 'ok');
  if (zipAtt) {
    if ((Object.keys(p.files).length || p.baseZip) && !confirm('Current project ki jagah yeh ZIP load karein?')) atts = atts.filter(a => a !== zipAtt);
    else loadZipIntoProject(chat, zipAtt);
  }
  const imgs = atts.filter(a => a.kind === 'image' && a.status === 'ok').map(a => a.dataUrl);
  let attText = ''; const names = [];
  for (const a of atts) {
    if (a.status !== 'ok') continue;
    if (a.kind === 'text') attText += `\n\n[Attached file: ${a.name}]\n\`\`\`\`\n${a.text.slice(0, 200000)}\n\`\`\`\``;
    names.push(a.kind === 'zip' ? a.name + ' (project load)' : a.name);
    if (a.add && a.kind !== 'zip') { p.assets['assets/' + cleanPath(a.name)] = a.file; }
  }
  const t = text || (imgs.length ? '' : zipAtt ? 'Is ZIP project ko samjho: kya hai, structure, errors/risks, aur kya improve ho sakta hai — chhota summary do.' : 'Is file ko dekho aur batao.');
  const m = { id: uid(), role: 'user', text: t, images: imgs, atts: names, attText, t: Date.now() };
  chat.messages.push(m);
  if (chat.title === 'Naya chat') chat.title = (t || names[0] || 'Chat').replace(/\s+/g, ' ').slice(0, 42);
  chat.updated = Date.now();
  inp.value = ''; autosize(); atts = []; renderAtts(); updateProjBadge();
  appendMsg(m); renderList(); saveSoon();
  await runChain(chat);
}

/* ---------------- ZIP / project ---------------- */
function liveHTML(p, entry) {
  const files = p.files; let name = entry || Object.keys(files).find(k => /^index\.html?$/i.test(k)) || Object.keys(files).find(k => /(^|\/)index\.html?$/i.test(k));
  if (!name) return null;
  let html = files[name]; const dir = name.includes('/') ? name.replace(/\/[^/]*$/, '') : '';
  const res = ref => cleanPath((dir ? dir + '/' : '') + ref.replace(/^\.\//, '').replace(/^\//, ''));
  html = html.replace(/<link\b[^>]*rel=["']?stylesheet["']?[^>]*>/gi, tag => { const m = tag.match(/href=["']([^"']+)["']/i); if (!m || /^(https?:|\/\/|data:)/i.test(m[1])) return tag; const c = files[res(m[1])]; return c != null ? '<style>' + c + '</style>' : tag; });
  html = html.replace(/<script\b([^>]*)\bsrc=["']([^"']+)["']([^>]*)><\/script>/gi, (tag, a, src, b) => { if (/^(https?:|\/\/|data:)/i.test(src)) return tag; const c = files[res(src)]; return c != null ? `<script ${a} ${b}>` + c.replace(/<\/script/gi, '<\\/script') + '</script>' : tag; });
  return html;
}
function openHtml(html) { window.open(URL.createObjectURL(new Blob([html], { type: 'text/html' })), '_blank'); }
async function downloadZip(btn) {
  const chat = cur, p = chat.project;
  const n = Object.keys(p.files).length + p.binaries.length + Object.keys(p.assets).length;
  if (!n) return toast('Project khali hai');
  const old = btn && btn.textContent; if (btn) { btn.disabled = true; btn.textContent = '⏳ ZIP ban rahi hai…'; }
  try {
    const files = []; const send = p.baseZip ? p.changed : Object.keys(p.files);
    for (const k of send) if (k in p.files) files.push({ path: k, content: p.files[k] });
    for (const [k, blob] of Object.entries(p.assets)) {
      const b64 = await new Promise(r => { const fr = new FileReader(); fr.onload = () => r(String(fr.result).split(',')[1] || ''); fr.readAsDataURL(blob); });
      files.push({ path: k, content: b64, base64: true });
    }
    const meta = JSON.stringify({ name: p.name, files, deleted: p.deleted });
    let body, headers = hdr();
    if (p.baseZip) {
      const mb = new TextEncoder().encode(meta), len = new Uint8Array(4); new DataView(len.buffer).setUint32(0, mb.length);
      body = new Blob([len, mb, p.baseZip]); headers['x-framed'] = '1';
    } else { body = meta; headers['Content-Type'] = 'application/json'; }
    const r = await fetch('/api/zip', { method: 'POST', headers, body });
    if (!r.ok) { let j = {}; try { j = await r.json(); } catch (_) {} throw new Error(j.error || 'ZIP error ' + r.status); }
    const blob = await r.blob(); saveBlob(blob, p.name + '.zip'); toast('✅ ' + p.name + '.zip (' + fmtSize(blob.size) + ') download ho rahi hai');
  } catch (e) { toast('⚠ ' + e.message, 4000); }
  finally { if (btn) { btn.disabled = false; btn.textContent = old; } }
}

/* project modal */
let pSel = null;
function openProject() {
  const p = cur.project; $('#pName').value = p.name; renderPList(); $('#projOv').classList.add('on');
}
function renderPList() {
  const p = cur.project, fk = Object.keys(p.files).sort();
  $('#pList').innerHTML = fk.map(k => `<div class="${k === pSel ? 'on' : ''}" data-act="pfile" data-p="${esc(k)}"><span>${p.changed.includes(k) ? '● ' : ''}${esc(k)}</span></div>`).join('')
    + p.binaries.slice(0, 300).map(b => `<div class="mut"><span>🔒 ${esc(b.path)}</span><small>${fmtSize(b.size)}</small></div>`).join('')
    + Object.keys(p.assets).map(k => `<div class="mut"><span>🖼 ${esc(k)}</span><small>${fmtSize(p.assets[k].size)}</small></div>`).join('');
  $('#pInfo').textContent = fk.length + ' text • ' + p.binaries.length + ' binary • ' + Object.keys(p.assets).length + ' assets' + (p.baseZip ? ' • base ZIP ' + fmtSize(p.baseZip.size) : '');
  const has = pSel && pSel in p.files; $('#pView').value = has ? p.files[pSel] : ''; $('#pView').disabled = !has;
  ['#pSave', '#pDel', '#pDl1'].forEach(s => $(s).disabled = !has);
}

/* ---------------- settings ---------------- */
function openSettings() {
  $('#sKey').value = S.key; $('#sBase').value = S.base; $('#sCoding').value = S.codingMode; $('#sFix').value = S.autofix ? '1' : '0';
  $('#sTheme').value = S.theme; $('#sPass').value = S.pass; $('#sCustom').value = S.custom; $('#sTemp').value = S.temp; $('#sMax').value = S.maxTok; $('#sLang').value = S.lang;
  if (health.passwordRequired) $('#passF').style.display = '';
  $('#sMsg').textContent = ''; $('#setOv').classList.add('on');
}
async function loadModels(verbose) {
  try {
    const r = await fetch('/api/models', { headers: hdr() }); const j = await r.json();
    if (!r.ok) throw new Error(j.error || 'Error ' + r.status);
    MODELS = j.models || []; $('#modelList').innerHTML = MODELS.map(m => `<option value="${esc(m.id)}">${m.vision ? '👁 ' : ''}${esc(m.id)}</option>`).join('');
    if (verbose) $('#sMsg').textContent = '✅ Connected — ' + MODELS.length + ' models mile';
  } catch (e) { if (verbose) $('#sMsg').textContent = '⚠ ' + e.message; }
}

/* ---------------- voice ---------------- */
let rec = null;
function toggleMic() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) return toast('Is browser me voice typing nahi hai (Chrome use karein)');
  if (rec) { rec.stop(); return; }
  rec = new SR(); rec.lang = S.lang; rec.interimResults = true; rec.continuous = true;
  const base = inp.value ? inp.value + ' ' : ''; let fin = '';
  rec.onresult = e => { let it = ''; for (let i = e.resultIndex; i < e.results.length; i++) { const t = e.results[i][0].transcript; if (e.results[i].isFinal) fin += t + ' '; else it += t; } inp.value = base + fin + it; autosize(); };
  rec.onend = () => { rec = null; $('#micBtn').textContent = '🎤'; }; rec.onerror = () => { };
  rec.start(); $('#micBtn').textContent = '⏺';
}
function speak(text) {
  if (!('speechSynthesis' in window)) return toast('TTS support nahi hai');
  if (speechSynthesis.speaking) { speechSynthesis.cancel(); return; }
  const plain = compactAssistant(text).replace(/\[file[^\]]*\]/g, '').replace(/[`*#>|_-]+/g, ' ').slice(0, 4000);
  const u = new SpeechSynthesisUtterance(plain); u.lang = /[ऀ-ॿ]/.test(plain) ? 'hi-IN' : 'en-IN'; speechSynthesis.speak(u);
}

/* ---------------- templates ---------------- */
const TEMPLATES = [
  { t: '🤖 Telegram bot (full ZIP)', s: 'Python, .env, README, Render deploy', p: 'Ek advanced Telegram bot banao (Python, python-telegram-bot v21). Features: /start menu with inline buttons, admin panel, SQLite database, broadcast, error logging. Poora project ZIP me do — README, requirements.txt, .env.example, Procfile/render.yaml ke saath.' },
  { t: '🌐 Premium landing page', s: 'Responsive HTML + animations', p: 'Ek premium dark-theme landing page banao (single HTML, responsive, smooth animations, glassmorphism cards, pricing, FAQ, contact form). Topic: ' },
  { t: '📄 Premium PDF design', s: 'A4, cover page, Hindi/English', p: 'Ek premium A4 PDF banao — cover page, colourful section headers, tables, callout boxes, header/footer with page numbers. Topic: ' },
  { t: '📚 Study material PDF', s: 'Class 10, Hindi, chapter notes', p: 'Class 10 ke liye premium Hindi PDF banao: chapter-wise notes, important dates/points table, 10 MCQ with answers, aur 5 short questions. Chapter: ' },
  { t: '🖼 Image analyze', s: 'OCR + errors + design copy', p: 'Is image ko detail me analyze karo: saara text (OCR) likho, layout/colours batao, aur koi galti ya improvement ho to bolo.' },
  { t: '📦 Big full-stack ZIP', s: 'Frontend + backend + tests + docs', p: 'Ek advanced full-stack project banao (Node.js + Express backend, modern frontend, SQLite, auth with JWT, tests, Dockerfile, README). Idea: ' },
  { t: '🐞 Code fix karo', s: 'Error dhoondo, fixed file do', p: 'Mera code/error neeche hai. Root cause batao aur poori fixed file do:\n\n' },
  { t: '🔍 Code review', s: 'Bugs, security, performance', p: 'Is project ka deep code review karo: bugs, security issues, performance, structure. Fir sab fix karke updated files do.' },
  { t: '🧪 Tests likho', s: 'Unit + integration tests', p: 'Is project ke liye complete tests likho (unit + integration) aur test run karne ka command batao.' },
  { t: '🎨 UI design (mobile app)', s: 'Dribbble-level screens in HTML', p: 'Ek mobile app ki 4 screens ka premium UI design banao (HTML/CSS, phone frame ke andar, dark + gradient). App idea: ' },
  { t: '🔁 Code convert', s: 'Python ↔ JS ↔ Java', p: 'Is code ko ___ me convert karo, same features ke saath, poora project ZIP me:\n\n' },
  { t: '🧾 Resume / CV PDF', s: 'Modern 1-2 page CV', p: 'Ek modern, ATS-friendly resume PDF banao (A4, 2 columns, icons, skills bars). Meri details: ' }
];
function toggleTpl() {
  const m = $('#tplMenu'); if (m.style.display === 'block') { m.style.display = 'none'; return; }
  m.innerHTML = TEMPLATES.map((t, i) => `<div data-act="tpl" data-i="${i}"><b>${esc(t.t)}</b><small>${esc(t.s)}</small></div>`).join(''); m.style.display = 'block';
}

/* ---------------- export / import ---------------- */
function chatToMd(c) {
  return `# ${c.title}\n\n` + c.messages.filter(m => !m.auto).map(m => (m.role === 'user' ? '## 🧑 You\n' : '## 🤖 AI' + (m.model ? ' (' + m.model + ')' : '') + '\n') + (m.text || '') + '\n').join('\n');
}
function backupJson() {
  const data = chats.map(c => ({ ...c, project: { ...c.project, baseZip: null, assets: {} } }));
  saveBlob(new Blob([JSON.stringify({ v: 1, chats: data })], { type: 'application/json' }), 'ai-studio-backup.json');
}

/* ---------------- events ---------------- */
function autosize() { inp.style.height = 'auto'; inp.style.height = Math.min(inp.scrollHeight, 200) + 'px'; }
inp.addEventListener('input', autosize);
inp.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey && window.innerWidth > 760 && !e.isComposing) { e.preventDefault(); send(); }
});
inp.addEventListener('paste', e => {
  const fs = [...(e.clipboardData && e.clipboardData.files || [])]; if (fs.length) { e.preventDefault(); processFiles(fs); }
});
['dragover', 'drop'].forEach(ev => document.addEventListener(ev, e => {
  if (!e.dataTransfer || !e.dataTransfer.types.includes('Files')) return; e.preventDefault();
  if (ev === 'drop') processFiles([...e.dataTransfer.files]);
}));
document.addEventListener('keydown', e => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); if (!busy) { newChat(); renderAll(); inp.focus(); } }
  if ((e.ctrlKey || e.metaKey) && e.key === '/') { e.preventDefault(); inp.focus(); }
  if (e.key === 'Escape') { $$('.ov.on').forEach(o => o.classList.remove('on')); $('#lb').classList.remove('on'); $('#tplMenu').style.display = 'none'; if (busy && abortCtl && document.activeElement === inp) abortCtl.abort(); }
});
$('#sendBtn').onclick = send;
$('#attBtn').onclick = () => $('#file').click();
$('#file').onchange = e => { processFiles([...e.target.files]); e.target.value = ''; };
$('#micBtn').onclick = toggleMic;
$('#tplBtn').onclick = toggleTpl;
$('#newChat').onclick = () => { if (busy) return toast('Pehle chal raha kaam rok do'); newChat(); renderAll(); $('#side').classList.remove('on'); inp.focus(); };
$('#menuBtn').onclick = () => $('#side').classList.toggle('on');
$('#chatSearch').oninput = renderList;
$('#setBtn').onclick = openSettings;
$('#projBtn').onclick = openProject;
$('#modeSeg').onclick = e => { const b = e.target.closest('button'); if (!b) return; S.mode = b.dataset.m; saveSettings(); syncMode(); if (S.mode === 'manual' && !MODELS.length) loadModels(); };
$('#modelIn').onchange = e => { S.model = e.target.value.trim(); saveSettings(); };
$('#sShow').onclick = () => { const i = $('#sKey'); i.type = i.type === 'password' ? 'text' : 'password'; };
$('#sCancel').onclick = () => $('#setOv').classList.remove('on');
$('#sSave').onclick = () => {
  S.key = $('#sKey').value.trim(); S.base = $('#sBase').value.trim(); S.codingMode = $('#sCoding').value; S.autofix = $('#sFix').value === '1';
  S.theme = $('#sTheme').value; S.pass = $('#sPass').value; S.custom = $('#sCustom').value; S.temp = Math.max(0, Math.min(2, parseFloat($('#sTemp').value) || 0.5));
  S.maxTok = Math.max(1000, Math.min(64000, parseInt($('#sMax').value) || 16000)); S.lang = $('#sLang').value;
  saveSettings(); applyTheme(); $('#setOv').classList.remove('on'); loadModels(); toast('✅ Settings save ho gayi');
};
$('#sTest').onclick = async () => { const old = { k: S.key, b: S.base, p: S.pass }; S.key = $('#sKey').value.trim(); S.base = $('#sBase').value.trim(); S.pass = $('#sPass').value; $('#sMsg').textContent = 'testing…'; await loadModels(true); S.key = old.k; S.base = old.b; S.pass = old.p; };
$('#xMd').onclick = () => { if (cur && cur.messages.length) saveBlob(new Blob([chatToMd(cur)], { type: 'text/markdown' }), slug(cur.title) + '.md'); else toast('Chat khali hai'); };
$('#xJson').onclick = backupJson;
$('#xImp').onclick = () => $('#impFile').click();
$('#impFile').onchange = async e => {
  try { const j = JSON.parse(await e.target.files[0].text()); (j.chats || []).forEach(c => { c.id = uid(); c.project = Object.assign(newProject(), c.project); chats.push(c); }); saveSoon(); renderAll(); toast('✅ ' + (j.chats || []).length + ' chats restore hue'); } catch (_) { toast('Backup file galat hai'); }
  e.target.value = '';
};
$('#pClose').onclick = () => $('#projOv').classList.remove('on');
$('#pZip').onclick = e => { cur.project.name = slug($('#pName').value); downloadZip(e.currentTarget); };
$('#pName').onchange = () => { cur.project.name = slug($('#pName').value); saveSoon(); };
$('#pClear').onclick = () => { if (confirm('Project ke saare files hata dein?')) { cur.project = newProject(); pSel = null; renderPList(); updateProjBadge(); saveSoon(); } };
$('#pSave').onclick = () => { const p = cur.project; if (pSel && pSel in p.files) { p.files[pSel] = $('#pView').value; if (!p.changed.includes(pSel)) p.changed.push(pSel); renderPList(); saveSoon(); toast('Saved'); } };
$('#pDel').onclick = () => { const p = cur.project; if (pSel && confirm(pSel + ' delete karein?')) { delete p.files[pSel]; p.changed = p.changed.filter(x => x !== pSel); if (!p.deleted.includes(pSel)) p.deleted.push(pSel); pSel = null; renderPList(); updateProjBadge(); saveSoon(); } };
$('#pDl1').onclick = () => { if (pSel) saveBlob(new Blob([cur.project.files[pSel]], { type: 'text/plain' }), pSel.split('/').pop()); };
$('#pNew').onclick = () => { const n = cleanPath(prompt('Nayi file ka path (e.g. src/app.js):') || ''); if (!n) return; const p = cur.project; p.files[n] = ''; if (!p.changed.includes(n)) p.changed.push(n); pSel = n; renderPList(); updateProjBadge(); saveSoon(); };
$('#pLive').onclick = () => { const h = liveHTML(cur.project); h ? openHtml(h) : toast('index.html nahi mila'); };
$('#lb').onclick = () => $('#lb').classList.remove('on');
document.addEventListener('click', e => { const m = $('#tplMenu'); if (m.style.display === 'block' && !e.target.closest('#tplMenu') && e.target.id !== 'tplBtn') m.style.display = 'none'; });

document.addEventListener('click', async e => {
  const el = e.target.closest('[data-act]'); if (!el) return;
  const act = el.dataset.act, id = el.dataset.id, bid = el.dataset.bid;
  const msg = id && cur && cur.messages.find(m => m.id === id);
  const copy = t => navigator.clipboard.writeText(t).then(() => toast('Copied ✔'), () => toast('Copy nahi hua'));
  switch (act) {
    case 'pick': if (busy) return toast('Pehle chal raha kaam rok do'); cur = chats.find(c => c.id === id); LS.set('ais_cur', id); renderAll(); $('#side').classList.remove('on'); break;
    case 'pin': { e.stopPropagation(); const c = chats.find(c => c.id === id); c.pinned = !c.pinned; saveSoon(); renderList(); break; }
    case 'ren': { e.stopPropagation(); const c = chats.find(c => c.id === id); const t = prompt('Chat ka naam:', c.title); if (t) { c.title = t.slice(0, 60); saveSoon(); renderList(); } break; }
    case 'del': { e.stopPropagation(); if (busy) return; if (!confirm('Yeh chat delete karein?')) return; chats = chats.filter(c => c.id !== id); if (!chats.length) newChat(); if (!chats.includes(cur)) cur = chats[0]; saveSoon(); renderAll(); break; }
    case 'tpl': { const t = TEMPLATES[+el.dataset.i]; inp.value = t.p; autosize(); $('#tplMenu').style.display = 'none'; inp.focus(); inp.setSelectionRange(inp.value.length, inp.value.length); break; }
    case 'zoom': $('#lb img').src = el.src; $('#lb').classList.add('on'); break;
    case 'copy': if (msg) copy(msg.text); break;
    case 'cp': copy(BL[bid] || ''); break;
    case 'speak': if (msg) speak(msg.text); break;
    case 'vf': { const p = el.dataset.p; pSel = cleanPath(p); openProject(); break; }
    case 'zip': downloadZip(el); break;
    case 'proj': openProject(); break;
    case 'live': { const h = liveHTML(cur.project); h ? openHtml(h) : toast('index.html nahi mila'); break; }
    case 'pvbid': { const h = BL[bid]; const p = cur.project; const path = el.closest('.fchip').querySelector('.n').textContent; openHtml(liveHTML(p, cleanPath(path)) || h); break; }
    case 'pvopen': openHtml(BL[bid]); break;
    case 'dlh': saveBlob(new Blob([BL[bid]], { type: 'text/html' }), 'design.html'); break;
    case 'pvtoggle': {
      const code = el.closest('.code'), nx = code.nextElementSibling;
      if (nx && nx.classList.contains('pv')) { nx.remove(); break; }
      const d = document.createElement('div'); d.className = 'pv'; d.innerHTML = '<iframe sandbox="allow-scripts allow-forms allow-modals allow-popups"></iframe>'; d.firstChild.srcdoc = BL[bid]; code.after(d); break;
    }
    case 'pdfdl': { const x = PDFS[bid]; if (x && x.blob) saveBlob(x.blob, el.closest('.pdfcard').dataset.name || 'document.pdf'); else toast('PDF abhi ban rahi hai / Chrome nahi hai → HTML download karo'); break; }
    case 'pdfadd': { const x = PDFS[bid]; if (x && x.blob) { cur.project.assets['pdfs/' + (el.closest('.pdfcard').dataset.name || 'document.pdf')] = x.blob; updateProjBadge(); saveSoon(); toast('📦 PDF ZIP me jud gayi'); } else toast('PDF abhi ready nahi'); break; }
    case 'pdfhtml': saveBlob(new Blob([BL[bid]], { type: 'text/html' }), (el.closest('.pdfcard').dataset.name || 'document').replace(/\.pdf$/i, '') + '.html'); break;
    case 'pdfre': delete PDFS[bid]; makePdf(bid, el.closest('.pdfcard'), true); break;
    case 'undo': if (msg && !busy) { applyUndo(cur, msg); updateProjBadge(); updateMsg(msg, true); saveSoon(); toast('↩ Undo ho gaya'); } break;
    case 'regen': case 'retry': {
      if (busy || !msg) return; const i = cur.messages.indexOf(msg); rollbackFrom(cur, i); cur.messages.length = i; updateProjBadge(); renderMsgs(); runChain(cur); break;
    }
    case 'edit': {
      if (busy || !msg) return; const i = cur.messages.indexOf(msg); rollbackFrom(cur, i); cur.messages.length = i; updateProjBadge(); renderMsgs();
      inp.value = msg.text || ''; autosize(); (msg.images || []).forEach(u => atts.push({ id: uid(), name: 'image', kind: 'image', dataUrl: u, status: 'ok', size: 0, add: false })); renderAtts(); inp.focus(); break;
    }
    case 'settings': openSettings(); break;
    case 'pfile': pSel = el.dataset.p; renderPList(); break;
    case 'rmatt': atts = atts.filter(a => a.id !== el.closest('.att').dataset.id); renderAtts(); break;
    case 'addzip': { const a = atts.find(a => a.id === el.closest('.att').dataset.id); if (a) a.add = el.checked; break; }
  }
});

/* ---------------- init ---------------- */
(async function init() {
  applyTheme();
  await idb.open();
  const saved = await idb.get('chats');
  if (Array.isArray(saved) && saved.length) { chats = saved; chats.forEach(c => { c.project = Object.assign(newProject(), c.project); c.messages.forEach(m => { if (m.role === 'assistant' && !m.done) { m.done = true; if (!m.text) m.err = 'Beech me band ho gaya'; } }); }); const id = LS.get('ais_cur', null); cur = chats.find(c => c.id === id) || chats[0]; }
  else newChat();
  try { health = await (await fetch('/api/health')).json(); } catch (_) { health = {}; }
  if (health.passwordRequired) $('#passF').style.display = '';
  renderAll(); autosize();
  if (!S.key && !health.hasEnvKey) openSettings(); else loadModels();
  if (health.passwordRequired && !S.pass) openSettings();
  if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => { });
})();
