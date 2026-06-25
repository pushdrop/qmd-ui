import http from 'node:http';
import { execFile, spawn } from 'node:child_process';
import { readFile, writeFile, readdir, access, stat } from 'node:fs/promises';
import { join, resolve, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));

const QMD        = process.env.QMD_BIN        || 'qmd';
// When packaged, QMD_NODE = Electron binary path. ELECTRON_RUN_AS_NODE=1 (already in env)
// makes it act as plain Node.js, so we can run qmd's JS entry without system node.
const QMD_NODE   = process.env.QMD_NODE       || null;
const PORT       = Number(process.env.PORT)    || 8765;
const DAEMON_URL = process.env.QMD_DAEMON_URL  || 'http://localhost:8181';
const HOME       = homedir();
const QMD_CONFIG = join(HOME, '.config', 'qmd', 'index.yml');

// ── YAML helpers for ~/.config/qmd/index.yml ─────────────────────────────
// Targeted parser for the ignore list in qmd's config — no full YAML library needed.
// Format:
//   collections:
//     name:          ← 2-space indent
//       ignore:      ← 4-space indent
//         - pat      ← 6-space indent

function yamlGetIgnores(text, collName) {
  const lines = text.split('\n');
  let inColl = false, inIgnore = false;
  const patterns = [];
  for (const line of lines) {
    if (!inColl) {
      if (line === `  ${collName}:`) inColl = true;
    } else if (!inIgnore) {
      if (/^  [a-zA-Z0-9_-]/.test(line)) break; // next collection
      if (line.trimEnd() === '    ignore:') inIgnore = true;
    } else {
      const m = line.match(/^      - (.+)/);
      if (m) patterns.push(m[1].trim().replace(/^["']|["']$/g, ''));
      else if (line.trim() && !/^\s+-/.test(line)) break;
    }
  }
  return patterns;
}

function yamlSetIgnores(text, collName, patterns) {
  const lines = text.split('\n');
  let inColl = false, ignoreKeyIdx = -1;
  let ignoreEndIdx = lines.length;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!inColl) {
      if (line === `  ${collName}:`) inColl = true;
    } else {
      if (/^  [a-zA-Z0-9_-]/.test(line) && line !== `  ${collName}:`) {
        // Moved to next collection — insert ignore block before this line
        if (ignoreKeyIdx === -1) {
          const ins = ['    ignore:', ...patterns.map(p => `      - ${p}`)];
          lines.splice(i, 0, ...ins);
        }
        break;
      }
      if (line.trimEnd() === '    ignore:') {
        ignoreKeyIdx = i;
      } else if (ignoreKeyIdx !== -1) {
        if (/^      - /.test(line)) continue; // existing list item
        ignoreEndIdx = i; break;             // first non-list line after ignore
      }
    }
  }
  if (ignoreKeyIdx === -1) return text; // collection not found
  const newItems = patterns.map(p => `      - ${p}`);
  lines.splice(ignoreKeyIdx + 1, ignoreEndIdx - ignoreKeyIdx - 1, ...newItems);
  return lines.join('\n');
}

let mcpSessionId = null;
let collectionRoots = new Map();
let folderCache = [];

async function exec(cmd, args, { timeout } = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, {
      maxBuffer: 10 * 1024 * 1024,
      env: process.env,
      ...(timeout != null && { timeout }),
    }, (error, stdout, stderr) => {
      if (error) {
        // ETIMEDOUT / SIGTERM from timeout: return whatever stdout we got so far
        if ((error.killed || error.code === 'ETIMEDOUT') && stdout) return resolve(stdout);
        error.stderr = stderr;
        reject(error);
      } else resolve(stdout);
    });
  });
}

// Run qmd — routes through Electron's bundled Node when packaged (QMD_NODE set)
function execQmd(args, opts) {
  return QMD_NODE ? exec(QMD_NODE, [QMD, ...args], opts) : exec(QMD, args, opts);
}

async function ensureDaemon() {
  try {
    const res = await fetch(`${DAEMON_URL}/health`);
    if (!res.ok) throw new Error('Not ok');
  } catch (err) {
    console.log('Spawning qmd daemon...');
    const [daemonBin, daemonArgs] = QMD_NODE
      ? [QMD_NODE, [QMD, 'mcp', '--http', '--daemon']]
      : [QMD, ['mcp', '--http', '--daemon']];
    const daemon = spawn(daemonBin, daemonArgs, {
      detached: true,
      stdio: 'ignore',
      env: process.env,
    });
    daemon.unref();
    
    for (let i = 0; i < 20; i++) {
      await new Promise(r => setTimeout(r, 500));
      try {
        const res = await fetch(`${DAEMON_URL}/health`);
        if (res.ok) return;
      } catch(e) {}
    }
    console.error('Daemon failed to start.');
  }
}

async function cacheFolders() {
  const dirSet = new Set();
  for (const root of collectionRoots.values()) {
    dirSet.add(root);
    const stdout = await new Promise(resolve => {
      execFile('find', [
        root, '-maxdepth', '8',
        // Prune TCC-protected app-data dirs and heavy trees BEFORE descending,
        // mirroring qmd's own collection ignore list. Without this, find walks
        // ~/Library/Containers, Group Containers, Application Support, etc. and
        // trips the macOS "app data access from node" privacy prompt.
        '(', '-path', '*/Library', '-o', '-path', '*/Applications',
             '-o', '-path', '*/.*', '-o', '-path', '*/node_modules',
             '-o', '-path', '*/Google Drive', '-o', '-path', '*/Dropbox',
             '-o', '-path', '*/Pictures', '-o', '-path', '*/Movies',
             '-o', '-path', '*/Music', ')', '-prune',
        '-o', '-name', '*.md', '-print',
      ], { maxBuffer: 20 * 1024 * 1024 }, (_err, out) => resolve(out || ''));
    });
    for (const f of stdout.split('\n').map(s => s.trim()).filter(Boolean)) {
      let d = dirname(f);
      while (d.startsWith(root) && d !== root) { dirSet.add(d); d = dirname(d); }
    }
  }
  folderCache = [...dirSet].sort();
  console.log(`Cached ${folderCache.length} folders`);
}

async function cacheRoots() {
  try {
    const out = await execQmd(['collection', 'list']);
    const names = [];
    for (const line of out.split('\n')) {
      const match = line.match(/^([a-zA-Z0-9_-]+)\s+\(qmd:\/\//);
      if (match) names.push(match[1]);
    }
    
    for (const name of names) {
      const showOut = await execQmd(['collection', 'show', name]);
      const match = showOut.match(/Path:\s+(.*)/);
      if (match) {
        collectionRoots.set(name, match[1].trim());
      }
    }
    console.log('Collection roots:', Object.fromEntries(collectionRoots));
  } catch (e) {
    console.error('Failed to cache roots:', e);
  }
}

async function getMcpSession() {
  if (mcpSessionId) return mcpSessionId;
  
  const res = await fetch(`${DAEMON_URL}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream'
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        clientInfo: { name: "qmd-ui", version: "1.0.0" },
        capabilities: {}
      }
    })
  });
  
  if (!res.ok) throw new Error('MCP init failed: ' + res.status);
  
  mcpSessionId = res.headers.get('mcp-session-id');
  if (!mcpSessionId) throw new Error('No MCP session ID returned');

  await fetch(`${DAEMON_URL}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
      'Mcp-Session-Id': mcpSessionId
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      method: "notifications/initialized"
    })
  });
  
  return mcpSessionId;
}

function toAbsolutePath(file) {
  let pathStr = file;
  if (pathStr.startsWith('qmd://')) pathStr = pathStr.slice(6);
  const parts = pathStr.split('/');
  if (collectionRoots.has(parts[0])) {
    return collectionRoots.get(parts[0]) + '/' + parts.slice(1).join('/');
  }
  return file;
}

// qmd normalizes underscores to dashes in its index paths. When the resolved
// path doesn't exist, try swapping dashes↔underscores in just the filename.
async function resolveRealPath(p) {
  try { await access(p); return p; } catch {}
  const dir = dirname(p);
  const base = basename(p);
  for (const alt of [base.replace(/-/g, '_'), base.replace(/_/g, '-')]) {
    if (alt === base) continue;
    const candidate = join(dir, alt);
    try { await access(candidate); return candidate; } catch {}
  }
  return p; // not found — return original so callers get a clear ENOENT
}

let mcpCallId = 2;
async function callMcpQuery(q, retry = true) {
  const sessionId = await getMcpSession();
  
  const res = await fetch(`${DAEMON_URL}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
      'Mcp-Session-Id': sessionId
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: ++mcpCallId,
      method: "tools/call",
      params: {
        name: "query",
        arguments: {
          searches: [{type: "lex", query: q}, {type: "vec", query: q}],
          intent: "interactive search from qmd-ui",
          limit: 20,
          rerank: true
        }
      }
    })
  });
  
  if (!res.ok) {
    if (retry) {
      mcpSessionId = null;
      return callMcpQuery(q, false);
    }
    throw new Error(`MCP tool call failed: ${res.status}`);
  }
  
  const data = await res.json();
  if (data.error) throw new Error(data.error.message);
  
  return data.result?.structuredContent?.results || [];
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
    
    if (req.method === 'GET' && url.pathname === '/') {
      const html = await readFile(join(__dirname, 'index.html'), 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(html);
      return;
    }
    
    if (req.method === 'GET' && url.pathname === '/api/search') {
      const q = url.searchParams.get('q') || '';
      if (!q.trim()) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('[]');
        return;
      }
      
      const out = await execQmd(['search', '--json', '-n', '20', q]);
      const results = JSON.parse(out);
      const resolved = await Promise.all(results.map(async r => {
        const abs = toAbsolutePath(r.file);
        const real = await resolveRealPath(abs);
        try { const info = await stat(real); return { ...r, file: real, mtime: info.mtime.toISOString() }; } catch { return null; }
      }));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(resolved.filter(Boolean)));
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/query') {
      let body = '';
      for await (const chunk of req) body += chunk;
      const { q } = JSON.parse(body);
      if (!q || !q.trim()) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('[]');
        return;
      }

      const results = await callMcpQuery(q);
      const resolved = await Promise.all(results.map(async r => {
        const abs = toAbsolutePath(r.file);
        const real = await resolveRealPath(abs);
        try { const info = await stat(real); return { ...r, file: real, mtime: info.mtime.toISOString() }; } catch { return null; }
      }));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(resolved.filter(Boolean)));
      return;
    }
    
    if (req.method === 'GET' && url.pathname === '/api/doc') {
      const file = url.searchParams.get('file');
      if (!file) {
        res.writeHead(400); res.end('Missing file param'); return;
      }
      let out = await execQmd(['get', file, '--no-line-numbers']);
      // qmd get prepends a header line (qmd:// or filesystem path) + a "---" rule; strip both
      const lines = out.split('\n');
      if (lines[0]?.startsWith('qmd://') || lines[0]?.startsWith('/')) {
        lines.shift();
        if (lines[0]?.trim() === '---') lines.shift();
        out = lines.join('\n').replace(/^\n+/, '');
      }
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end(out);
      return;
    }
    
    if (req.method === 'POST' && url.pathname === '/api/open') {
      let body = '';
      for await (const chunk of req) body += chunk;
      const { file, reveal } = JSON.parse(body);
      
      const resolved = resolve(file);
      let isValid = false;
      for (const root of collectionRoots.values()) {
        if (resolved.startsWith(root + '/')) {
          isValid = true;
          break;
        }
      }
      
      if (!isValid) {
        res.writeHead(400); res.end('Invalid or unauthorized path'); return;
      }
      
      if (reveal) {
        await exec('open', ['-R', resolved]);
      } else {
        await exec('open', [resolved]);
      }
      res.writeHead(200); res.end('OK');
      return;
    }
    
    if (req.method === 'GET' && url.pathname === '/api/raw') {
      const file = url.searchParams.get('file');
      if (!file) { res.writeHead(400); res.end('Missing file param'); return; }
      const resolved = resolve(file);
      let isValid = false;
      for (const root of collectionRoots.values()) {
        if (resolved.startsWith(root + '/')) { isValid = true; break; }
      }
      if (!isValid) { res.writeHead(400); res.end('Invalid or unauthorized path'); return; }
      try {
        const real = await resolveRealPath(resolved);
        const [content, info] = await Promise.all([readFile(real, 'utf8'), stat(real)]);
        res.writeHead(200, { 'Content-Type': 'text/plain', 'X-File-Mtime': info.mtime.toISOString() });
        res.end(content);
      } catch (e) {
        if (e.code === 'ENOENT') {
          res.writeHead(404); res.end(`File not found on disk: ${resolved}\n\nIt may have been moved or deleted. Run Reindex to update the search index.`);
        } else {
          throw e;
        }
      }
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/save') {
      let body = '';
      for await (const chunk of req) body += chunk;
      const { file, content } = JSON.parse(body);

      const resolved = resolve(file);
      let isValid = false;
      for (const root of collectionRoots.values()) {
        if (resolved.startsWith(root + '/')) { isValid = true; break; }
      }
      if (!isValid) { res.writeHead(400); res.end('Invalid or unauthorized path'); return; }

      const real = await resolveRealPath(resolved);
      await writeFile(real, content, 'utf8');
      await execQmd(['update']);
      res.writeHead(200); res.end('OK');
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/collections') {
      const list = [...collectionRoots.entries()].map(([name, p]) => ({ name, path: p }));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(list));
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/collections') {
      let body = '';
      for await (const chunk of req) body += chunk;
      const { dir } = JSON.parse(body);
      await execQmd(['collection', 'add', dir]);
      await cacheRoots();
      await cacheFolders();
      execQmd(['update']).then(() => execQmd(['embed'])).catch(console.error);
      res.writeHead(200); res.end('OK');
      return;
    }

    if (req.method === 'DELETE' && url.pathname.startsWith('/api/collections/')) {
      const name = decodeURIComponent(url.pathname.slice('/api/collections/'.length));
      await execQmd(['collection', 'remove', name]);
      collectionRoots.delete(name);
      await cacheFolders();
      res.writeHead(200); res.end('OK');
      return;
    }

    if (req.method === 'GET' && /^\/api\/collections\/[^/]+\/subdirs$/.test(url.pathname)) {
      const name = url.pathname.split('/')[3];
      const collPath = collectionRoots.get(name);
      if (!collPath) { res.writeHead(404); res.end('Collection not found'); return; }

      const yamlText = await readFile(QMD_CONFIG, 'utf8').catch(() => '');
      const ignores  = yamlGetIgnores(yamlText, name);

      let entries = [];
      try { entries = await readdir(collPath, { withFileTypes: true }); } catch {}

      const dirs = entries
        .filter(e => e.isDirectory() && !e.name.startsWith('.'))
        .map(e => ({
          name: e.name,
          excluded: ignores.some(p =>
            p === `${e.name}/**` || p === `${e.name}/` || p === e.name),
        }))
        .sort((a, b) => a.name.localeCompare(b.name));

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ collPath, dirs, ignores }));
      return;
    }

    if (req.method === 'PUT' && /^\/api\/collections\/[^/]+\/ignores$/.test(url.pathname)) {
      const name = url.pathname.split('/')[3];
      let body = '';
      for await (const chunk of req) body += chunk;
      const { excludedDirs, rawIgnores } = JSON.parse(body);
      // excludedDirs: string[] of top-level dir names to exclude
      // rawIgnores:   full existing ignore list (non-top-level patterns preserved)

      // Keep patterns that aren't simple "dirname/**" top-level entries
      const keepPatterns = (rawIgnores || []).filter(p => !/^[^*/]+\/\*\*$/.test(p) && !/^[^*/]+\/$/.test(p));
      const newTopLevel  = (excludedDirs || []).map(d => `${d}/**`);
      const merged = [...keepPatterns, ...newTopLevel];

      const yamlText = await readFile(QMD_CONFIG, 'utf8').catch(() => '');
      const updated  = yamlSetIgnores(yamlText, name, merged);
      await writeFile(QMD_CONFIG, updated, 'utf8');

      res.writeHead(200); res.end('OK');
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/config') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ home: HOME, port: PORT }));
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/folders') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(folderCache));
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/update') {
      const out = await execQmd(['update']);
      cacheFolders(); // refresh folder cache after reindex (new dirs may have appeared)
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end(out);
      return;
    }
    
    if (req.method === 'GET' && url.pathname === '/api/files') {
      const files = [];
      async function walkMd(dir, depth) {
        if (depth > 8) return;
        let entries;
        try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
        for (const e of entries) {
          if (e.name.startsWith('.')) continue;
          const full = join(dir, e.name);
          if (e.isSymbolicLink()) continue;
          if (e.isDirectory()) { await walkMd(full, depth + 1); }
          else if (e.isFile() && e.name.endsWith('.md')) {
            try {
              const s = await stat(full);
              files.push({ file: full, title: e.name.replace(/\.md$/, ''), mtime: s.mtime.toISOString(), score: null, snippet: '' });
            } catch { }
          }
        }
      }
      for (const root of collectionRoots.values()) await walkMd(root, 0);
      files.sort((a, b) => b.mtime.localeCompare(a.mtime));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(files.slice(0, 500)));
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/status') {
      const out = await execQmd(['status'], { timeout: 8000 });
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end(out);
      return;
    }
    
    res.writeHead(404);
    res.end('Not found');
  } catch (err) {
    console.error(err);
    res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end(err.stderr || err.message || 'Internal Error');
  }
});

await ensureDaemon();
await cacheRoots();
await cacheFolders();

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Server listening on http://127.0.0.1:${PORT}`);
});
