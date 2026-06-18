import http from 'node:http';
import { execFile, spawn } from 'node:child_process';
import { readFile, writeFile, access } from 'node:fs/promises';
import { join, resolve, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const QMD = process.env.QMD_BIN || 'qmd';
const PORT = 8765;
const DAEMON_URL = 'http://localhost:8181';

let mcpSessionId = null;
let collectionRoots = new Map();

async function exec(cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { 
      maxBuffer: 10 * 1024 * 1024,
      env: { ...process.env, PATH: `${process.env.PATH || ''}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin` }
    }, (error, stdout, stderr) => {
      if (error) {
        error.stderr = stderr;
        reject(error);
      } else resolve(stdout);
    });
  });
}

async function ensureDaemon() {
  try {
    const res = await fetch(`${DAEMON_URL}/health`);
    if (!res.ok) throw new Error('Not ok');
  } catch (err) {
    console.log('Spawning qmd daemon...');
    const daemon = spawn(QMD, ['mcp', '--http', '--daemon'], {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, PATH: `${process.env.PATH || ''}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin` }
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

async function cacheRoots() {
  try {
    const out = await exec(QMD, ['collection', 'list']);
    const names = [];
    for (const line of out.split('\n')) {
      const match = line.match(/^([a-zA-Z0-9_-]+)\s+\(qmd:\/\//);
      if (match) names.push(match[1]);
    }
    
    for (const name of names) {
      const showOut = await exec(QMD, ['collection', 'show', name]);
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
      
      const out = await exec(QMD, ['search', '--json', '-n', '20', q]);
      const results = JSON.parse(out);
      const resolved = await Promise.all(results.map(async r => {
        const abs = toAbsolutePath(r.file);
        const real = await resolveRealPath(abs);
        try { await access(real); return { ...r, file: real }; } catch { return null; }
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
        try { await access(real); return { ...r, file: real }; } catch { return null; }
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
      let out = await exec(QMD, ['get', file, '--no-line-numbers']);
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
        const content = await readFile(real, 'utf8');
        res.writeHead(200, { 'Content-Type': 'text/plain' });
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
      await exec(QMD, ['update']);
      res.writeHead(200); res.end('OK');
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/update') {
      const out = await exec(QMD, ['update']);
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end(out);
      return;
    }
    
    if (req.method === 'GET' && url.pathname === '/api/status') {
      const out = await exec(QMD, ['status']);
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

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Server listening on http://127.0.0.1:${PORT}`);
});
