#!/usr/bin/env node
const http = require('http');
const WebSocket = require('ws');
const net = require('net');

const PORT = process.env.TUNNEL_PORT || 8081;
const PATH = process.env.TUNNEL_PATH || '/tcp-tunnel';
const ALLOW_HOSTS = (process.env.TUNNEL_ALLOW_HOSTS || '').split(',').map(s => s.trim()).filter(Boolean);
const ALLOW_PORTS = (process.env.TUNNEL_ALLOW_PORTS || '').split(',').map(n => parseInt(n,10)).filter(n => !isNaN(n));

function hostAllowed(targetHost, req) {
  const originHost = (req.headers['x-forwarded-host'] || req.headers.host || '').split(':')[0];
  if (ALLOW_HOSTS.length) {
    if (ALLOW_HOSTS.includes('*')) return true;
    return ALLOW_HOSTS.includes(targetHost);
  }
  return true;
}

function portAllowed(p) { return ALLOW_PORTS.length === 0 || ALLOW_PORTS.includes(p); }

const server = http.createServer();
const wss = new WebSocket.Server({ server, path: PATH });

wss.on('connection', (ws, req) => {
  let sock = null;
  let connected = false;

  ws.on('message', (msg) => {
    if (!connected) {
      let m;
      try {
        m = JSON.parse(msg.toString());
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
      if (!hostAllowed(host, req) || !portAllowed(port)) {
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

server.listen(PORT, () => {
  console.log(`TCP tunnel listening http://localhost:${PORT}${PATH}`);
});
