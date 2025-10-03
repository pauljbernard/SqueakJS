#!/usr/bin/env node
const http = require('http');
const path = require('path');
const net = require('net');

let WebSocket;
try {
  WebSocket = require('ws');
} catch (err) {
  try {
    WebSocket = require(path.resolve(__dirname, '../ws/server/node_modules/ws'));
  } catch (fallbackErr) {
    err.message += ` (and fallback to bundled ws failed: ${fallbackErr.message})`;
    throw err;
  }
}

function toList(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value.filter(Boolean);
  return String(value)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function toPortList(value) {
  if (Array.isArray(value)) {
    return value
      .map((n) => parseInt(n, 10))
      .filter((n) => Number.isInteger(n) && n > 0 && n <= 65535);
  }
  if (!value) return [];
  return String(value)
    .split(',')
    .map((n) => parseInt(n, 10))
    .filter((n) => Number.isInteger(n) && n > 0 && n <= 65535);
}

function attachTcpTunnel(server, options = {}) {
  const {
    path = '/tcp-tunnel',
    allowHosts = [],
    allowPorts = [],
  } = options;

  const hosts = toList(allowHosts);
  const ports = toPortList(allowPorts);

  function hostAllowed(targetHost) {
    if (!hosts.length) return true;
    if (hosts.includes('*')) return true;
    return hosts.includes(targetHost);
  }

  function portAllowed(p) {
    return !ports.length || ports.includes(p);
  }

  const wss = new WebSocket.Server({ server, path });

  wss.on('connection', (ws, req) => {
  let sock = null;
  let connected = false;

  ws.on('message', (msg) => {
    if (!connected) {
      let asString;
      try { asString = msg.toString(); } catch(_) { asString = null; }
      if (asString) {
        try {
          const obj = JSON.parse(asString);
          if (obj && obj.t === 'dns' && typeof obj.h === 'string') {
            const qname = String(obj.h);
            const dns = require('dns');
            dns.resolve4(qname, (err, addresses) => {
              if (err || !Array.isArray(addresses) || addresses.length === 0) {
                try { ws.send(JSON.stringify({ t: 'dns', err: String((err && err.code) || 'ENOTFOUND') })); } catch(_) {}
                return;
              }
              const dohLike = {
                Status: 0,
                Question: [{ name: qname }],
                Answer: addresses.map(a => ({ name: qname, type: 1, TTL: 86400, data: a }))
              };
              try { ws.send(JSON.stringify({ t: 'dns', r: dohLike })); } catch(_) {}
            });
            return;
          }
        } catch(_) {
        }
      }

      let m;
      try {
        m = JSON.parse(asString || '');
      } catch(e) {
        ws.close();
        return;
      }
      if (!m || m.t !== 'c') { ws.close(); return; }
      const host = String(m.h || '');
      const port = parseInt(m.p, 10);
      if (!host || !Number.isInteger(port) || port <= 0 || port > 65535) {
        try { ws.send(JSON.stringify({ t: 'err', code: 400, msg: 'bad host/port' })); } catch(e) {}
        ws.close();
        return;
      }
      if (!hostAllowed(host) || !portAllowed(port)) {
        try { ws.send(JSON.stringify({ t: 'err', code: 403, msg: 'forbidden' })); } catch(e) {}
        ws.close();
        return;
      }

      sock = net.connect({ host, port }, () => {
        connected = true;
        try { ws.send(JSON.stringify({ t: 'ok' })); } catch(e) {}
      });

      sock.on('data', (data) => {
        if (ws.readyState === WebSocket.OPEN) {
          try { ws.send(data); } catch(e) {}
        }
      });

      sock.on('error', (e) => {
        if (ws.readyState === WebSocket.OPEN) {
          try { ws.send(JSON.stringify({ t: 'err', code: 500, msg: e && e.message ? e.message : 'socket error' })); } catch(_) {}
        }
        try { ws.close(); } catch(_) {}
      });

      sock.on('close', () => {
        if (ws.readyState === WebSocket.OPEN) {
          try { ws.send(JSON.stringify({ t: 'rc' })); } catch(_) {}
        }
        try { ws.close(); } catch(_) {}
      });

      return;
    }

    if (Buffer.isBuffer(msg)) {
      if (sock && !sock.destroyed) {
        try { sock.write(msg); } catch(_) {}
      }
    }
  });

  ws.on('close', () => {
    if (sock && !sock.destroyed) try { sock.destroy(); } catch(_) {}
  });

  ws.on('error', () => {
    if (sock && !sock.destroyed) try { sock.destroy(); } catch(_) {}
  });
});

  return wss;
}

module.exports = { attachTcpTunnel };

if (require.main === module) {
  const PORT = process.env.TUNNEL_PORT || 8081;
  const PATH = process.env.TUNNEL_PATH || '/tcp-tunnel';
  const ALLOW_HOSTS = toList(process.env.TUNNEL_ALLOW_HOSTS || []);
  const ALLOW_PORTS = toPortList(process.env.TUNNEL_ALLOW_PORTS || []);

  const server = http.createServer();
  attachTcpTunnel(server, { path: PATH, allowHosts: ALLOW_HOSTS, allowPorts: ALLOW_PORTS });

  server.listen(PORT, () => {
    console.log(`TCP tunnel listening http://localhost:${PORT}${PATH}`);
  });
}
