#!/usr/bin/env node
const http = require('http');
const path = require('path');
const net = require('net');

const LOG_TUNNEL = !!process.env.LOG_TUNNEL;
function logTunnel() { if (LOG_TUNNEL) console.log("[TCP-TUNNEL]", ...arguments); }
function errTunnel() { if (LOG_TUNNEL) console.error("[TCP-TUNNEL]", ...arguments); }

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
  logTunnel("attachTcpTunnel", options);
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
  let wsBytes = 0, tcpBytes = 0;


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
        logTunnel("tcp connected", { host, port });
        try { ws.send(JSON.stringify({ t: 'ok' })); } catch(e) {}
      });

      sock.on('data', (data) => {
        tcpBytes += data.length || 0;
        if (ws.readyState === WebSocket.OPEN) {
          try { ws.send(data); } catch(e) {}
        }
      });

      sock.on('error', (e) => {
        errTunnel("tcp error", e && (e.stack || e.message || e));
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
        wsBytes += msg.length || msg.byteLength || 0;
        try { sock.write(msg); } catch(_) {}
      }
    }
  });

  ws.on('close', () => {
    logTunnel("ws close", { wsBytes, tcpBytes });
    if (sock && !sock.destroyed) try { sock.destroy(); } catch(_) {}
  });

  ws.on('error', (e) => {
    errTunnel("ws error", e && (e.stack || e.message || e));
    if (sock && !sock.destroyed) try { sock.destroy(); } catch(_) {}
  });
});

  return wss;
}

function attachTcpTunnelNoServer(server, options = {}) {
  logTunnel("attachTcpTunnelNoServer", options);
  const {
    paths = ['/tcp-tunnel'],
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

  const wss = new WebSocket.Server({ noServer: true });

  function normalizeIncomingPath(p) {
    if (!p) return '';
    try {
      const u = new URL(p, 'http://localhost');
      let name = u.pathname || '';
      if (name.length > 1 && name.endsWith('/')) name = name.slice(0, -1);
      return name;
    } catch (_) {
      const [nameOnly] = String(p).split('?');
      if (!nameOnly) return '';
      return nameOnly.length > 1 && nameOnly.endsWith('/') ? nameOnly.slice(0, -1) : nameOnly;
    }
  }

  const acceptable = new Set(
    toList(paths).map((p) => {
      const base = p.startsWith('/') ? p : `/${p}`;
      return base.length > 1 && base.endsWith('/') ? base.slice(0, -1) : base;
    })
  );

  server.on('upgrade', (req, socket, head) => {
    const pathName = normalizeIncomingPath(req.url || '');
    if (!acceptable.has(pathName)) return;
    logTunnel("upgrade", { path: pathName, remote: req && req.socket && (req.socket.remoteAddress + ":" + req.socket.remotePort) });
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  });

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
          } catch(_) {}
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
          logTunnel("tcp connected", { host, port });
          try { ws.send(JSON.stringify({ t: 'ok' })); } catch(e) {}
        });

        let wsBytes = 0, tcpBytes = 0;
        sock.on('data', (data) => {
          tcpBytes += data.length || 0;
          if (ws.readyState === WebSocket.OPEN) {
            try { ws.send(data); } catch(e) {}
          }
        });

        sock.on('error', () => {
          if (ws.readyState === WebSocket.OPEN) {
            try { ws.send(JSON.stringify({ t: 'err', code: 500, msg: 'socket error' })); } catch(_) {}
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
      logTunnel("ws close", { wsBytes, tcpBytes });
      if (sock && !sock.destroyed) try { sock.destroy(); } catch(_) {}
    });

    ws.on('error', (e) => {
      errTunnel("ws error", e && (e.stack || e.message || e));
      if (sock && !sock.destroyed) try { sock.destroy(); } catch(_) {}
    });
  });

  return wss;
}

module.exports = { attachTcpTunnel, attachTcpTunnelNoServer };

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
