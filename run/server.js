#!/usr/bin/env node
const http = require('http');
const path = require('path');
const fs = require('fs');
const { URL } = require('url');
const { attachTcpTunnel } = require('../tools/tcp-tunnel');

const HOST = process.env.HOST || '0.0.0.0';
const PORT = parseInt(process.env.PORT, 10) || 3000;
const ROOT = path.resolve(__dirname, '..');
const DEFAULT_REDIRECT = '/run/';
const TUNNEL_PATH = process.env.TUNNEL_PATH || '/tcp-tunnel';
const ALLOW_HOSTS = process.env.TUNNEL_ALLOW_HOSTS || '';
const ALLOW_PORTS = process.env.TUNNEL_ALLOW_PORTS || '';

const contentTypes = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.wasm': 'application/wasm',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

function getContentType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return contentTypes[ext] || 'application/octet-stream';
}

function parseList(value) {
  if (!value) return [];
  return String(value)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function parsePorts(value) {
  if (!value) return [];
  return String(value)
    .split(',')
    .map((s) => parseInt(s, 10))
    .filter((n) => Number.isInteger(n) && n > 0 && n <= 65535);
}

function withinRoot(filePath) {
  const normalized = path.normalize(filePath);
  return normalized.startsWith(ROOT + path.sep) || normalized === ROOT;
}

async function statMaybe(filePath) {
  try {
    return await fs.promises.stat(filePath);
  } catch (err) {
    if (err && err.code === 'ENOENT') return null;
    throw err;
  }
}

async function serveStatic(req, res) {
  if (!req.url) {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Bad Request');
    return;
  }

  const method = (req.method || 'GET').toUpperCase();
  if (method !== 'GET' && method !== 'HEAD') {
    res.writeHead(405, { Allow: 'GET, HEAD', 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Method Not Allowed');
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  let pathname = decodeURIComponent(url.pathname);

  if (pathname === '/' || pathname === '') {
    res.writeHead(302, { Location: DEFAULT_REDIRECT });
    res.end('Found');
    return;
  }

  const normalizedPathname = pathname.startsWith('/') ? pathname : `/${pathname}`;
  const requestedPath = path.resolve(ROOT, `.${normalizedPathname}`);
  if (!withinRoot(requestedPath)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Forbidden');
    return;
  }

  let targetPath = path.normalize(requestedPath);
  let stats = await statMaybe(targetPath);

  if (stats && stats.isDirectory()) {
    if (!pathname.endsWith('/')) {
      res.writeHead(302, { Location: pathname + '/' });
      res.end('Found');
      return;
    }
    const indexPath = path.join(targetPath, 'index.html');
    const indexStats = await statMaybe(indexPath);
    if (indexStats) {
      targetPath = indexPath;
      stats = indexStats;
    } else {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not Found');
      return;
    }
  }

  if (!stats) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not Found');
    return;
  }

  res.writeHead(200, {
    'Content-Type': getContentType(targetPath),
    'Content-Length': stats.size,
    'Cache-Control': 'no-cache',
  });

  if (method === 'HEAD') {
    res.end();
    return;
  }

  const stream = fs.createReadStream(targetPath);
  stream.on('error', (err) => {
    console.error('Failed to read', targetPath, err);
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    }
    res.end('Internal Server Error');
  });
  stream.pipe(res);
}

const normalizedTunnelPath = TUNNEL_PATH.startsWith('/') ? TUNNEL_PATH : `/${TUNNEL_PATH}`;
const tunnelPaths = new Set([normalizedTunnelPath]);
if (!normalizedTunnelPath.startsWith('/run/')) {
  tunnelPaths.add(`/run${normalizedTunnelPath}`);
}

const server = http.createServer((req, res) => {
  const upgradeHeader = req.headers && typeof req.headers.upgrade === 'string'
    ? req.headers.upgrade.toLowerCase()
    : '';
  if (upgradeHeader === 'websocket') {
    try {
      const url = new URL(req.url || '', `http://${req.headers.host || 'localhost'}`);
      if (tunnelPaths.has(url.pathname)) {
        return;
      }
    } catch (_) {
      // fall through to static handling on malformed URLs
    }
  }

  serveStatic(req, res).catch((err) => {
    console.error('Unhandled error while serving request', err);
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    }
    res.end('Internal Server Error');
  });
});

attachTcpTunnel(server, {
  path: TUNNEL_PATH,
  allowHosts: parseList(ALLOW_HOSTS),
  allowPorts: parsePorts(ALLOW_PORTS),
});

server.listen(PORT, HOST, () => {
  const hostDisplay = HOST === '0.0.0.0' ? 'localhost' : HOST;
  console.log(`Serving SqueakJS files from ${ROOT}`);
  console.log(`HTTP available at http://${hostDisplay}:${PORT}/run/`);
  console.log(`TCP tunnel WebSocket listening on ${TUNNEL_PATH}`);
});

server.on('clientError', (err, socket) => {
  if (socket.writable) {
    socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
  } else {
    socket.destroy();
  }
});
