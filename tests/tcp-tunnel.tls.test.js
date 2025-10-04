const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const tls = require('node:tls');
const { once } = require('node:events');
const WebSocket = require('ws');

const { attachTcpTunnel } = require('../tools/tcp-tunnel');

const TEST_KEY = `-----BEGIN PRIVATE KEY-----
MIIEvAIBADANBgkqhkiG9w0BAQEFAASCBKYwggSiAgEAAoIBAQCpb0Mtyl6bgXQI
6vg6RJyWoZ1kbjPhY2zPxxMB4rhGJgaj0MdAhNPS5fn5sVUDn2Ln15na+qbvWIM7
dLqkHRj6jluhzeVv1f+mbwU68fe+TeqibpV43HjUZsX+rkVUQPfMV+THwpRM9NTJ
yyv3UVXo1OEuwnqevEZFkn0QX8Z8ab3KVOjDtneVjaswpTVZMH3rDo8kSdtLMc1h
Y+X6/S1cxMMlVDM0Z1sau+zWDKHRGggD7xoylG9vjtVDXZuobYqc32/KS6scH9dN
dgF50w1L0Eqcm1egkhrQsBOwEyxPPnAkFiLVVR0WYLycNbL7dDyzKGl0Zujt/Dq7
1Tw6q5+HAgMBAAECggEAGSF0FOAdvTHrvIDhdX8EvMDW3/UKg+Uj2AOeeZqfm2P7
eyO10geBhZfvxk27ntBuspWDb/vac8ismk57emkIce1YgPzRiY9znkN8QpxuEw9q
fFIroGQPFe3ycw51IQSL3Iay28AsD+gGgbG9YS7yr5iXl8BnwJCLWblbDGkwPvaQ
KiWoV8v76qh4EzPME14OpMZTdclYyKvbbs6qoI4HYrVvr45ZvkQChE78vVFWt4u2
t+P1yZ7WOkjvDcTcdf+W5BHdCFXNHAsRtIfaTJBNWDLZMBTjtfwwAyQVVDXX5hpP
LrpG8DoXoDpfiPM81wHzwbjJ/R6AoEMq8Vfvh6SR3QKBgQDgCbLll0DuG51FY1SE
onOKzxCN7zWlTV3ckTAv3caR0QqbEpq+mJce98I4uIS73xm86uhh6DgW4LFhrXAZ
HOG+Knk4Bn7vtE+5iWjVDV7ZHkW0vnJFKFqIxDEqkkVvtTcPL3k5qAj/8KHyh2XR
cZGooCA5HHc2fP8lF4VzANtcvQKBgQDBm1h7dwjKJ25baGzL96PPwe/NqiXhbQPh
/rIc+iEojmDuwLnedqjhn87yFt2ibDB0gi57kgtXER5+JB5beq0uup6MTGjQen5j
imnUEXkk7eUlI1SE3R0CuBlmIEmypeairR/qVeuA90nWR5FTPP05PJAT2asLqTwZ
9e4wFFJLkwKBgETF9WrRMZdmVrL0OP+2Nq3HvpczdU5XH5cT4qzu8YPVneHYpjQX
91wERlTPH7/kTqxVmBxmAsHTG+CWMzEiUpHjy+5M4C6JNWgJLGsqfZE8370KMV3V
c2VEhKtC15nhERPSSO5QDOM0ZSJkOfc/W61d6kZd3KKXYGNsgwS4oJ4pAoGAC81H
cIdKDuCmdoYAE9Lttm1xC81yb7JwiSc4flG1Eb7UI9m1utzq4I4YVGOWcR89OOzy
nm/BpzYQ8MmM3DC3O+D+ZzkFLqg46iJ23wmNo/WogUINFehQq2jDi5kuROieDY6W
InfIWl04sAo+zp8qJIIPmlYrehN/6Wk3ctDaT2cCgYAH4AM/a7Y7LbKB5cshWvqv
7nn2S4DknNVZgiBsor9YgJeZzLM6YWDr4TYRpiAlCPCfxrwv/FqtgRIXYzOIbRGB
UQ1AKoRWBcR+x1fXk6lIumedNAjObS6dLW2uSKKvwRI84cztwtF0SfPHs4UMcEFy
Bs+Ptio3ny/eWjIlKgxXlA==
-----END PRIVATE KEY-----`;

const TEST_CERT = `-----BEGIN CERTIFICATE-----
MIIDCTCCAfGgAwIBAgIUFIvqOCn3LSODYdXWTZG887w/EdIwDQYJKoZIhvcNAQEL
BQAwFDESMBAGA1UEAwwJbG9jYWxob3N0MB4XDTI1MTAwNDAyNTc0MFoXDTI1MTAw
NTAyNTc0MFowFDESMBAGA1UEAwwJbG9jYWxob3N0MIIBIjANBgkqhkiG9w0BAQEF
AAOCAQ8AMIIBCgKCAQEAqW9DLcpem4F0COr4OkSclqGdZG4z4WNsz8cTAeK4RiYG
o9DHQITT0uX5+bFVA59i59eZ2vqm71iDO3S6pB0Y+o5boc3lb9X/pm8FOvH3vk3q
om6VeNx41GbF/q5FVED3zFfkx8KUTPTUycsr91FV6NThLsJ6nrxGRZJ9EF/GfGm9
ylTow7Z3lY2rMKU1WTB96w6PJEnbSzHNYWPl+v0tXMTDJVQzNGdbGrvs1gyh0RoI
A+8aMpRvb47VQ12bqG2KnN9vykurHB/XTXYBedMNS9BKnJtXoJIa0LATsBMsTz5w
JBYi1VUdFmC8nDWy+3Q8syhpdGbo7fw6u9U8OqufhwIDAQABo1MwUTAdBgNVHQ4E
FgQUAydIxqGqVi9PcO6HlgQPiGM7ZgIwHwYDVR0jBBgwFoAUAydIxqGqVi9PcO6H
lgQPiGM7ZgIwDwYDVR0TAQH/BAUwAwEB/zANBgkqhkiG9w0BAQsFAAOCAQEAWhmu
WkhBCVcNh6xTSyfASMa9miAv80Z4ApNZ2YjK2gHXOdAEEpYrM+lq2vnpwJeMeg9h
gDoId5fkSRCdmdE2Uimb9r+2s+mFKhbYGhxpu4ZHx/pFGMMr95Bj32XhpAMOUFTn
Is5UkD1oLn22rHRfhPKJZyS8l9Jxh6I6PUvY5QPie1e3O3UngtZ7IrtwuafOt5Tb
ui9w/TxfY2xWgMarmRWbIR1G5UXDM/IvHFxKK20jVPgHkz3xMN0DWaewYDDqoELE
yQ19H9ITD6qmNZFxQm69Qa7Ifdq5Mu72IOHzgnIctcsRP5GTAa47sq6fxoFzO+Vi
JtnEvKrVShWbmEKfdA==
-----END CERTIFICATE-----`;

test('TCP tunnel upgrades HTTPS requests to TLS', async (t) => {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

  const tlsServer = tls.createServer({ key: TEST_KEY, cert: TEST_CERT });
  const receivedChunks = [];
  const responseBody = 'HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\nhello';

  tlsServer.on('secureConnection', (socket) => {
    socket.on('data', (chunk) => {
      receivedChunks.push(chunk);
      if (!socket.writableEnded) {
        socket.write(responseBody);
        socket.end();
      }
    });
  });

  tlsServer.listen(0);
  await once(tlsServer, 'listening');
  const targetPort = tlsServer.address().port;

  const httpServer = http.createServer();
  const wss = attachTcpTunnel(httpServer, { path: '/tcp-tunnel' });

  httpServer.listen(0);
  await once(httpServer, 'listening');
  const tunnelPort = httpServer.address().port;

  const ws = new WebSocket(`ws://127.0.0.1:${tunnelPort}/tcp-tunnel`);
  const responseChunks = [];

  const closeWebSocket = async () => {
    await new Promise((resolve) => {
      if (ws.readyState === WebSocket.CLOSED) return resolve();
      ws.once('close', resolve);
      try { ws.close(); } catch (_) { resolve(); }
    });
  };

  try {
    await new Promise((resolve, reject) => {
      ws.on('open', () => {
        ws.send(JSON.stringify({ t: 'c', h: 'localhost', p: targetPort, tls: true }));
      });

      ws.on('message', (data) => {
        if (typeof data === 'string') {
          const msg = JSON.parse(data);
          if (msg.t === 'ok') {
            ws.send(Buffer.from('GET / HTTP/1.1\r\nHost: localhost\r\n\r\n'));
          } else if (msg.t === 'rc') {
            resolve();
          } else if (msg.t === 'err') {
            reject(new Error(msg.msg || 'tunnel error'));
          }
        } else {
          responseChunks.push(Buffer.from(data));
        }
      });

      ws.on('error', reject);
    });

    const sentRequest = Buffer.concat(receivedChunks).toString('utf8');
    assert.match(sentRequest, /^GET \/ HTTP\/1.1/);

    const responseText = Buffer.concat(responseChunks).toString('utf8');
    assert.ok(responseText.includes('hello'));
  } finally {
    await closeWebSocket();
    await new Promise((resolve) => wss.close(resolve));
    await new Promise((resolve) => httpServer.close(resolve));
    await new Promise((resolve) => tlsServer.close(resolve));
  }
});
