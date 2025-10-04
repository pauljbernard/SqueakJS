/*
 * This Socket plugin only fulfills http:/https:/ws:/wss: requests by intercepting them
 * and sending as either XMLHttpRequest or Fetch or WebSocket.
 * To make connections to servers without CORS, it uses a CORS proxy.
 *
 * When a WebSocket connection is created in the Smalltalk image a low level socket is
 * assumed to be provided by this plugin. Since low level sockets are not supported
 * in the browser a WebSocket is used here. This does however require the WebSocket
 * protocol (applied by the Smalltalk image) to be 'reversed' or 'faked' here in the
 * plugin.
 * The WebSocket handshake protocol is faked within the plugin and a regular WebSocket
 * connection is set up with the other party resulting in a real handshake.
 * When a (WebSocket) message is sent from the Smalltalk runtime it will be packed
 * inside a frame (fragment). This Socket plugin will extract the message from the
 * frame and send it using the WebSocket object (which will put it into a frame
 * again). A bit of unnecessary byte and bit fiddling unfortunately.
 * See the following site for an explanation of the WebSocket protocol:
 * https://developer.mozilla.org/en-US/docs/Web/API/WebSockets_API/Writing_WebSocket_servers
 *
 * DNS requests are resolved via the same-origin TCP-over-WebSocket tunnel server.
 * This avoids browser CORS/TLS issues and remains transparent to the Smalltalk image.
 */

function SocketPlugin() {
  "use strict";

  return {
    getModuleName: function() { return 'SocketPlugin (http-only, tunnel-enabled)'; },
    interpreterProxy: null,
    primHandler: null,

    handleCounter: 0,
    needProxy: new Set(),

    tcpTunnelUnavailable: false,
    tcpTunnelFailureReason: null,

    // DNS Lookup
    // Cache elements: key is name, value is { address: 1.2.3.4, validUntil: Date.now() + 30000 }
    status: 0, // Resolver_Uninitialized,
    lookupCache: {
      localhost: { address: [ 127, 0, 0, 1], validUntil: Number.MAX_SAFE_INTEGER }
    },
    lastLookup: null,
    lookupSemaIdx: 0,

    // Constants
    TCP_Socket_Type: 0,
    Resolver_Uninitialized: 0,
    Resolver_Ready: 1,
    Resolver_Busy: 2,
    Resolver_Error: 3,
    Socket_InvalidSocket: -1,
    Socket_Unconnected: 0,
    Socket_WaitingForConnection: 1,
    Socket_Connected: 2,
    Socket_OtherEndClosed: 3,
    Socket_ThisEndClosed: 4,

    setInterpreter: function(anInterpreter) {
      this.interpreterProxy = anInterpreter;
      this.primHandler = this.interpreterProxy.vm.primHandler;
      return true;
    },

    _signalSemaphore: function(semaIndex) {
      if (semaIndex <= 0) return;
      this.primHandler.signalSemaphoreWithIndex(semaIndex);
    },

    _signalLookupSemaphore: function() { this._signalSemaphore(this.lookupSemaIdx); },

    _isTunnelEnabled: function() {
      var opts = (typeof SqueakJS === "object" && SqueakJS.options) || {};
      return opts.enableTcpTunnel !== false && !this.tcpTunnelUnavailable;
    },

    _disableTunnel: function(reason) {
      if (this.tcpTunnelUnavailable) return;
      this.tcpTunnelUnavailable = true;
      this.tcpTunnelFailureReason = reason || null;
      try {
        console.warn("Disabling TCP tunnel fallback" + (reason ? ": " + reason : "."));
      } catch(_) {}
    },

    _getAddressFromLookupCache: function(name, skipExpirationCheck) {
      if (name) {

        // Check for valid dotted decimal name first
        var dottedDecimalsMatch = name.match(/^\d+\.\d+\.\d+\.\d+$/);
        if (dottedDecimalsMatch) {
          var result = name.split(".").map(function(d) { return +d; });
          if (result.every(function(d) { return d <= 255; })) {
            return new Uint8Array(result);
          }
        }

        // Lookup in cache
        var cacheEntry = this.lookupCache[name];
        if (cacheEntry && (skipExpirationCheck || cacheEntry.validUntil >= Date.now())) {
          return new Uint8Array(cacheEntry.address);
        }
      }
      return null;
    },

    _addAddressFromResponseToLookupCache: function(response) {
      // Check for valid response
      if (!response || response.Status !== 0 || !response.Question || !response.Answer) {
        return;
      }

      // Clean up all response elements by removing trailing dots in names
      var removeTrailingDot = function(element, field) {
        if (element[field] && element[field].replace) {
          element[field] = element[field].replace(/\.$/, "");
        }
      };
      var originalQuestion = response.Question[0];
      removeTrailingDot(originalQuestion, "name");
      response.Answer.forEach(function(answer) {
        removeTrailingDot(answer, "name");
        removeTrailingDot(answer, "data");
      });

      // Get address by traversing alias chain
      var lookup = originalQuestion.name;
      var address = null;
      var ttl = 24 * 60 * 60; // One day as safe default
      var hasAddress = response.Answer.some(function(answer) {
        if (answer.name === lookup) {

          // Time To Live can be set on alias and address, keep shortest period
          if (answer.TTL) {
            ttl = Math.min(ttl, answer.TTL);
          }

          if (answer.type === 1) {
            // Retrieve IP address as array with 4 numeric values
            address = answer.data.split(".").map(function(numberString) { return +numberString; });
            return true;
          } else if (answer.type === 5) {
            // Lookup name points to alias, follow alias from here on
            lookup = answer.data;
          }
        }
        return false;
      });

      // Store address found
      if (hasAddress) {
        this.lookupCache[originalQuestion.name] = { address: address, validUntil: Date.now() + (ttl * 1000) };
      }
    },

    _compareAddresses: function(address1, address2) {
      return address1.every(function(addressPart, index) {
        return address2[index] === addressPart;
      });
    },

    _reverseLookupNameForAddress: function(address) {
      var thisHandle = this;
      var result = null;
      Object.keys(this.lookupCache).some(function(name) {
        if (thisHandle._compareAddresses(address, thisHandle.lookupCache[name].address)) {
          result = name;
          return true;
        }
        return false;
      });
      return result || address.join(".");
    },

    // A socket handle emulates socket behavior
    _newSocketHandle: function(sendBufSize, connSemaIdx, readSemaIdx, writeSemaIdx) {
      var plugin = this;
      return {
        hostAddress: null,
        host: null,
        port: null,

        connSemaIndex: connSemaIdx,
        readSemaIndex: readSemaIdx,
        writeSemaIndex: writeSemaIdx,

        webSocket: null,
        tunnelWS: null,
        tunnelOpen: false,
        tunnelClosed: false,
        tunnelPendingConnect: false,


        sendBuffer: null,
        sendTimeout: null,

        response: null,
        responseReadUntil: 0,
        responseReceived: false,

        status: plugin.Socket_Unconnected,

        _signalConnSemaphore: function() { plugin._signalSemaphore(this.connSemaIndex); },
        _signalReadSemaphore: function() { plugin._signalSemaphore(this.readSemaIndex); },
        _signalWriteSemaphore: function() { plugin._signalSemaphore(this.writeSemaIndex); },

        _otherEndClosed: function() {
          this.status = plugin.Socket_OtherEndClosed;
          this.webSocket = null;
          if (this.tunnelWS) {
            try { this.tunnelWS.onopen = this.tunnelWS.onmessage = this.tunnelWS.onerror = this.tunnelWS.onclose = null; } catch(_) {}
            try { this.tunnelWS.close(); } catch(_) {}
          }
          this.tunnelWS = null;
          this.tunnelOpen = false;
          this.tunnelPendingConnect = false;
          this._signalConnSemaphore();
        },
        _httpTunnelUrl: function() {
          var opts = (typeof SqueakJS === "object" && SqueakJS.options) || {};
          var pathOrUrl = opts.tcpTunnelPath;
          if (typeof pathOrUrl === "string" && /^(ws|wss):\/\//i.test(pathOrUrl)) return pathOrUrl;
          var proto = (location.protocol === "https:") ? "wss:" : "ws:";
          var base = (document.baseURI || (location.origin + location.pathname));
          var urlObj;
          try {
            urlObj = new URL(base, location.origin);
          } catch(_) {
            return proto + "//" + location.host + "/tcp-tunnel";
          }
          if (!urlObj.pathname.endsWith("/")) {
            urlObj.pathname = urlObj.pathname.substring(0, urlObj.pathname.lastIndexOf("/") + 1);
          }
          var rel = (typeof pathOrUrl === "string" && pathOrUrl.length) ? pathOrUrl : "tcp-tunnel";
          var finalPath = rel.charAt(0) === "/" ? rel : (urlObj.pathname + rel);
          return proto + "//" + location.host + finalPath;
        },

        _httpOverTunnel: function(rawRequestBytes) {
          if (!plugin._isTunnelEnabled()) {
            this._otherEndClosed();
            return;
          }
          var url = this._httpTunnelUrl();
          var thisHandle = this;
          var ws = new WebSocket(url);
          ws.binaryType = "arraybuffer";
          ws.onopen = function() {
            try {
              ws.send(JSON.stringify({ t: "c", h: thisHandle.host, p: thisHandle.port }));
            } catch(e) {
              try { ws.close(); } catch(_) {}
              thisHandle._otherEndClosed();
            }
          };
          ws.onmessage = function(event) {
            if (typeof event.data === "string") {
              try {
                var m = JSON.parse(event.data);
                if (m.t === "ok") {
                  try { ws.send(rawRequestBytes); } catch(e) { try { ws.close(); } catch(_) {} }
                } else if (m.t === "rc") {
                  thisHandle.responseReceived = true;
                } else if (m.t === "err") {
                  thisHandle._otherEndClosed();
                  try { ws.close(); } catch(_) {}
                }
              } catch(e) {}
              return;
            }
            var bytes = new Uint8Array(event.data);
            if (!thisHandle.response || !thisHandle.response.length) {
              thisHandle.response = [ bytes ];
            } else {
              thisHandle.response.push(bytes);
            }
            thisHandle._signalReadSemaphore();
          };
          (function() {
            var triedFallback = false;
            var opened = false;
            function bind(wsRef) {
              wsRef.onopen = function() {
                opened = true;
                try {
                  wsRef.send(JSON.stringify({ t: "c", h: thisHandle.host, p: thisHandle.port }));
                } catch(e) {
                  try { wsRef.close(); } catch(_) {}
                  thisHandle._otherEndClosed();
                }
              };
              wsRef.onmessage = function(event) {
                if (typeof event.data === "string") {
                  try {
                    var m = JSON.parse(event.data);
                    if (m.t === "ok") {
                      try { wsRef.send(rawRequestBytes); } catch(e) { try { wsRef.close(); } catch(_) {} }
                    } else if (m.t === "rc") {
                      thisHandle.responseReceived = true;
                    } else if (m.t === "err") {
                      thisHandle._otherEndClosed();
                      try { wsRef.close(); } catch(_) {}
                    }
                  } catch(e) {}
                  return;
                }
                var bytes = new Uint8Array(event.data);
                if (!thisHandle.response || !thisHandle.response.length) {
                  thisHandle.response = [ bytes ];
                } else {
                  thisHandle.response.push(bytes);
                }
                thisHandle._signalReadSemaphore();
              };
              function tryFallbackOrClose(evt) {
                if (!triedFallback) {
                  triedFallback = true;
                  try {
                    var proto = (location.protocol === "https:") ? "wss:" : "ws:";
                    var alt = proto + "//" + location.host + "/tcp-tunnel";
                    ws = new WebSocket(alt);
                    bind(ws);
                    if (evt && evt.preventDefault) try { evt.preventDefault(); } catch(_) {}
                    return true;
                  } catch(_) {}
                }
                return false;
              }
              wsRef.onerror = function(evt) {
                if (!tryFallbackOrClose(evt)) {
                  if (!opened) plugin._disableTunnel("WebSocket handshake failed for TCP tunnel");
                  thisHandle._otherEndClosed();
                }
              };
              wsRef.onclose = function(evt) {
                if (!tryFallbackOrClose(evt)) {
                  if (!opened) plugin._disableTunnel("WebSocket handshake failed for TCP tunnel");
                }
              };
            }
            bind(ws);
          })();
        },

        _hostAndPort: function() { return this.host + ':' + this.port; },

        _requestNeedsProxy: function() {
          return plugin.needProxy.has(this._hostAndPort());
        },

        _getURL: function(targetURL, isRetry) {
          var url = '';
          if (isRetry || this._requestNeedsProxy()) {
            var proxy = typeof SqueakJS === "object" && SqueakJS.options.proxy;
            url = proxy || Squeak.defaultCORSProxy;
          }
          if (this.port !== 443) {
            url += 'http://' + this._hostAndPort() + targetURL;
          } else {
            url += 'https://' + this.host + targetURL;
          }
          return url;
        },

        _performRequest: function() {
          // Assume a send is requested through WebSocket if connection is present
          if (this.webSocket) {
            this._performWebSocketSend();
            return;
          }

          var request = new TextDecoder("utf-8").decode(this.sendBuffer);

          // Remove request from send buffer
          var endOfRequestIndex = this.sendBuffer.findIndex(function(element, index, array) {
            // Check for presence of "\r\n\r\n" denoting the end of the request (do simplistic but fast check)
            return array[index] === "\r" && array[index + 2] === "\r" && array[index + 1] === "\n" && array[index + 3] === "\n";
          });
          if (endOfRequestIndex >= 0) {
            this.sendBuffer = this.sendBuffer.subarray(endOfRequestIndex + 4);
          } else {
            this.sendBuffer = null;
          }

          // Extract header fields
          var headerLines = request.split('\r\n\r\n')[0].split('\n');
          // Split header lines and parse first line
          var firstHeaderLineItems = headerLines[0].split(' ');
          var httpMethod = firstHeaderLineItems[0];
          if (httpMethod !== 'GET' && httpMethod !== 'PUT' &&
              httpMethod !== 'POST') {
            this._otherEndClosed();
            return -1;
          }
          var targetURL = firstHeaderLineItems[1];

          // Extract possible data to send
          var seenUpgrade = false;
          var seenWebSocket = false;
          var data = null;
          for (var i = 1; i < headerLines.length; i++) {
            var line = headerLines[i];
            if (line.match(/Content-Length:/i)) {
              var contentLength = parseInt(line.substr(16));
              var end = this.sendBuffer.byteLength;
              data = this.sendBuffer.subarray(end - contentLength, end);
            } else if (line.match(/Host:/i)) {
              var hostAndPort = line.substr(6).trim();
              var host = hostAndPort.split(':')[0];
              var port = parseInt(hostAndPort.split(':')[1]) || this.port;
              if (this.host !== host) {
                console.warn('Host for ' + this.hostAddress + ' was ' + this.host + ' but from HTTP request now ' + host);
                this.host = host;
              }
              if (this.port !== port) {
                console.warn('Port for ' + this.hostAddress + ' was ' + this.port + ' but from HTTP request now ' + port);
                this.port = port;
              }
            } if (line.match(/Connection: Upgrade/i)) {
              seenUpgrade = true;
            } else if (line.match(/Upgrade: WebSocket/i)) {
              seenWebSocket = true;
            }
          }

          if (httpMethod === "GET" && seenUpgrade && seenWebSocket) {
            this._performWebSocketRequest(targetURL, httpMethod, data, headerLines);
          } else if (self.fetch) {
            this._performFetchAPIRequest(targetURL, httpMethod, data, headerLines);
          } else {
            this._performXMLHTTPRequest(targetURL, httpMethod, data, headerLines);
          }
        },

        _performFetchAPIRequest: function(targetURL, httpMethod, data, requestLines) {
          var thisHandle = this;
          var headers = {};
          for (var i = 1; i < requestLines.length; i++) {
            var lineItems = requestLines[i].split(':');
            if (lineItems.length === 2) {
              headers[lineItems[0]] = lineItems[1].trim();
            }
          }
          if (typeof SqueakJS === "object" && SqueakJS.options.ajax) {
              headers["X-Requested-With"] = "XMLHttpRequest";
          }
          var init = {
            method: httpMethod,
            headers: headers,
            body: data,
            mode: 'cors'
          };

          fetch(this._getURL(targetURL), init)
          .then(thisHandle._handleFetchAPIResponse.bind(thisHandle))
          .catch(function (e) {
            var url = thisHandle._getURL(targetURL, true);
            console.warn('Retrying with CORS proxy: ' + url);
            fetch(url, init)
            .then(function(res) {
              console.log('Success: ' + url);
              thisHandle._handleFetchAPIResponse(res);
              plugin.needProxy.add(thisHandle._hostAndPort());
            })
            .catch(function (e) {
              console.warn('Fetch API failed, retrying with XMLHttpRequest');
              thisHandle._performXMLHTTPRequest(targetURL, httpMethod, data, requestLines);
            });
          });
        },

        _handleFetchAPIResponse: function(res) {
          if (this.response === null) {
            var header = ['HTTP/1.0 ', res.status, ' ', res.statusText, '\r\n'];
            res.headers.forEach(function(value, key, array) {
              header = header.concat([key, ': ', value, '\r\n']);
            });
            header.push('\r\n');
            this.response = [new TextEncoder('utf-8').encode(header.join(''))];
          }
          this._readIncremental(res.body.getReader());
        },

        _readIncremental: function(reader) {
          var thisHandle = this;
          return reader.read().then(function (result) {
            if (result.done) {
              thisHandle.responseReceived = true;
              return;
            }
            thisHandle.response.push(result.value);
            thisHandle._signalReadSemaphore();
            return thisHandle._readIncremental(reader);
          });
        },

        _performXMLHTTPRequest: function(targetURL, httpMethod, data, requestLines){
          var thisHandle = this;

          var contentType;
          for (var i = 1; i < requestLines.length; i++) {
            var line = requestLines[i];
            if (line.match(/Content-Type:/i)) {
              contentType = encodeURIComponent(line.substr(14));
              break;
            }
          }

          var httpRequest = new XMLHttpRequest();
          httpRequest.open(httpMethod, this._getURL(targetURL));
          if (contentType !== undefined) {
            httpRequest.setRequestHeader('Content-type', contentType);
          }
          if (typeof SqueakJS === "object" && SqueakJS.options.ajax) {
              httpRequest.setRequestHeader("X-Requested-With", "XMLHttpRequest");
          }

          httpRequest.responseType = "arraybuffer";

          httpRequest.onload = function (oEvent) {
            thisHandle._handleXMLHTTPResponse(this);
          };

          httpRequest.onerror = function(e) {
            var url = thisHandle._getURL(targetURL, true);
            console.warn('Retrying with CORS proxy: ' + url);
            var retry = new XMLHttpRequest();
            retry.open(httpMethod, url);
            retry.responseType = httpRequest.responseType;
            if (typeof SqueakJS === "object" && SqueakJS.options.ajaxx) {
                retry.setRequestHeader("X-Requested-With", "XMLHttpRequest");
            }
            retry.onload = function(oEvent) {
              console.log('Success: ' + url);
              thisHandle._handleXMLHTTPResponse(this);
              plugin.needProxy.add(thisHandle._hostAndPort());
            };
            retry.onerror = function() {
              if (plugin._isTunnelEnabled()) {
                var headerStr = (new TextDecoder('utf-8')).decode(new TextEncoder('utf-8').encode(requestLines[0])) + '\r\n';
                for (var i = 1; i < requestLines.length; i++) headerStr += requestLines[i].replace(/\r?$/, '') + '\r\n';
                headerStr += '\r\n';
                var headerBytes = new TextEncoder('utf-8').encode(headerStr);
                var totalLen = headerBytes.byteLength + (data ? data.byteLength : 0);
                var raw = new Uint8Array(totalLen);
                raw.set(headerBytes, 0);
                if (data) raw.set(data, headerBytes.byteLength);
                thisHandle._httpOverTunnel(raw);
              } else {
                thisHandle._otherEndClosed();
                console.error("Failed to download:\n" + url);
              }
            };
            retry.send(data);
          };

          httpRequest.send(data);
        },

        _handleXMLHTTPResponse: function(response) {
          this.responseReceived = true;

          var content = response.response;
          if (!content) {
            this._otherEndClosed();
            return;
          }
          // Recreate header
          var header = new TextEncoder('utf-8').encode(
            'HTTP/1.0 ' + response.status + ' ' + response.statusText +
            '\r\n' + response.getAllResponseHeaders() + '\r\n');
          // Concat header and response
          var res = new Uint8Array(header.byteLength + content.byteLength);
          res.set(header, 0);
          res.set(new Uint8Array(content), header.byteLength);

          this.response = [res];
          this._signalReadSemaphore();
        },

        _performWebSocketRequest: function(targetURL, httpMethod, data, requestLines){
          var url = this._getURL(targetURL);

          // Extract WebSocket key and subprotocol
          var webSocketSubProtocol;
          var webSocketKey;
          for (var i = 1; i < requestLines.length; i++) {
            var requestLine = requestLines[i].split(":");
            if (requestLine[0] === "Sec-WebSocket-Protocol") {
              webSocketSubProtocol = requestLine[1].trim();
              if (webSocketKey) {
                break;  // Only break if both webSocketSubProtocol and webSocketKey are found
              }
            } else if (requestLine[0] === "Sec-WebSocket-Key") {
              webSocketKey = requestLine[1].trim();
              if (webSocketSubProtocol) {
                break;  // Only break if both webSocketSubProtocol and webSocketKey are found
              }
            }
          }

          // Keep track of WebSocket for future send and receive operations
          this.webSocket = new WebSocket(url.replace(/^http/, "ws"), webSocketSubProtocol);

          var thisHandle = this;
          this.webSocket.onopen = function() {
            if (thisHandle.status !== plugin.Socket_Connected) {
              thisHandle.status = plugin.Socket_Connected;
              thisHandle._signalConnSemaphore();
              thisHandle._signalWriteSemaphore(); // Immediately ready to write
            }

            // Send the (fake) handshake back to the caller
            var acceptKey = new Uint8Array(sha1.array(webSocketKey + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"));
            var acceptKeyString = Squeak.bytesAsString(acceptKey);
            thisHandle._performWebSocketReceive(
              "HTTP/1.1 101 Switching Protocols\r\n" +
              "Upgrade: websocket\r\n" +
              "Connection: Upgrade\r\n" +
              "Sec-WebSocket-Accept: " + btoa(acceptKeyString) + "\r\n\r\n",
               true
            );
          };
          this.webSocket.onmessage = function(event) {
            thisHandle._performWebSocketReceive(event.data);
          };
          this.webSocket.onerror = function(e) {
            thisHandle._otherEndClosed();
            console.error("Error in WebSocket:", e);
          };
          this.webSocket.onclose = function() {
            thisHandle._otherEndClosed();
          };
        },

        _performWebSocketReceive: function(message, skipFramePacking) {

          // Process received message
          var dataIsBinary = !message.substr;
          if (!dataIsBinary) {
            message = new TextEncoder("utf-8").encode(message);
          }
          if (!skipFramePacking) {

            // Create WebSocket frame from message for Smalltalk runtime
            var frameLength = 1 + 1 + message.length + 4; // 1 byte for initial header bits & opcode, 1 byte for length and 4 bytes for mask
            var payloadLengthByte;
            if (message.byteLength < 126) {
              payloadLengthByte = message.length;
            } else if (message.byteLength < 0xffff) {
              frameLength += 2; // 2 additional bytes for payload length
              payloadLengthByte = 126;
            } else {
              frameLength += 8; // 8 additional bytes for payload length
              payloadLengthByte = 127;
            }
            var frame = new Uint8Array(frameLength);
            frame[0] = dataIsBinary ? 0x82 : 0x81;  // Final bit 0x80 set and opcode 0x01 for text and 0x02 for binary
            frame[1] = 0x80 | payloadLengthByte;  // Mask bit 0x80 and payload length byte
            var nextByteIndex;
            if (payloadLengthByte === 126) {
              frame[2] = message.length >>> 8;
              frame[3] = message.length & 0xff;
              nextByteIndex = 4;
            } else if (payloadLengthByte === 127) {
              frame[2] = message.length >>> 56;
              frame[3] = (message.length >>> 48) & 0xff;
              frame[4] = (message.length >>> 40) & 0xff;
              frame[5] = (message.length >>> 32) & 0xff;
              frame[6] = (message.length >>> 24) & 0xff;
              frame[7] = (message.length >>> 16) & 0xff;
              frame[8] = (message.length >>> 8) & 0xff;
              frame[9] = message.length & 0xff;
              nextByteIndex = 10;
            } else {
              nextByteIndex = 2;
            }

            // Add 'empty' mask (requiring no transformation)
            // Otherwise a (random) mask and the following line should be added:
            // var payload = message.map(function(b, index) { return b ^ maskKey[index & 0x03]; });
            var maskKey = new Uint8Array(4);
            frame.set(maskKey, nextByteIndex);
            nextByteIndex += 4;
            var payload = message;
            frame.set(payload, nextByteIndex);

            // Make sure the frame is set as the response
            message = frame;
          }

          // Store received message in response buffer
          if (!this.response || !this.response.length) {
            this.response = [ message ];
          } else {
            this.response.push(message);
          }
          this.responseReceived = true;
          this._signalReadSemaphore();
        },

        _performWebSocketSend: function() {
          // Decode sendBuffer which is a WebSocket frame (from Smalltalk runtime)

          // Read frame header fields
          var firstByte = this.sendBuffer[0];
          var finalBit = firstByte >>> 7;
          var opcode = firstByte & 0x0f;
          var dataIsBinary;
          if (opcode === 0x00) {
            // Continuation frame
            console.error("No support for WebSocket frame continuation yet!");
            return true;
          } else if (opcode === 0x01) {
            // Text frame
            dataIsBinary = false;
          } else if (opcode === 0x02) {
            // Binary frame
            dataIsBinary = true;
          } else if (opcode === 0x08) {
            // Close connection
            this.webSocket.close();
            this.webSocket = null;
            return;
          } else if (opcode === 0x09 || opcode === 0x0a) {
            // Ping/pong frame (ignoring it, is handled by WebSocket implementation itself)
            return;
          } else {
            console.error("Unsupported WebSocket frame opcode " + opcode);
            return;
          }
          var secondByte = this.sendBuffer[1];
          var maskBit = secondByte >>> 7;
          var payloadLength = secondByte & 0x7f;
          var nextByteIndex;
          if (payloadLength === 126) {
            payloadLength = (this.sendBuffer[2] << 8) | this.sendBuffer[3];
            nextByteIndex = 4;
          } else if (payloadLength === 127) {
            payloadLength =
              (this.sendBuffer[2] << 56) |
              (this.sendBuffer[3] << 48) |
              (this.sendBuffer[4] << 40) |
              (this.sendBuffer[5] << 32) |
              (this.sendBuffer[6] << 24) |
              (this.sendBuffer[7] << 16) |
              (this.sendBuffer[8] << 8) |
              this.sendBuffer[9]
            ;
            nextByteIndex = 10;
          } else {
            nextByteIndex = 2;
          }
          var maskKey;
          if (maskBit) {
            maskKey = this.sendBuffer.subarray(nextByteIndex, nextByteIndex + 4);
            nextByteIndex += 4;
          }

          // Read (remaining) payload
          var payloadData = this.sendBuffer.subarray(nextByteIndex, nextByteIndex + payloadLength);
          nextByteIndex += payloadLength;

          // Unmask the payload
          if (maskBit) {
            payloadData = payloadData.map(function(b, index) { return b ^ maskKey[index & 0x03]; });
          }

          // Extract data from payload
          var data;
          if (dataIsBinary) {
            data = payloadData;
          } else {
            data = Squeak.bytesAsString(payloadData);
          }

          // Remove frame from send buffer
          this.sendBuffer = this.sendBuffer.subarray(nextByteIndex);
          this.webSocket.send(data);

          // Send remaining frames
          if (this.sendBuffer.byteLength > 0) {
            this._performWebSocketSend();
          }
        },

        connect: function(hostAddress, port) {
          this.hostAddress = hostAddress;
          this.host = plugin._reverseLookupNameForAddress(hostAddress);
          this.port = port;

          if (plugin._isTunnelEnabled()) {
            var url = this._httpTunnelUrl();

            var thisHandle = this;
            this.tunnelWS = new WebSocket(url);
            this.tunnelWS.binaryType = "arraybuffer";
            this.tunnelPendingConnect = true;
            this.tunnelOpen = false;

            this.tunnelWS.onopen = function() {
              var msg = JSON.stringify({ t: "c", h: thisHandle.host, p: thisHandle.port });
              thisHandle.tunnelWS.send(msg);
            };
            this.tunnelWS.onmessage = function(event) {
              if (typeof event.data === "string") {
                try {
                  var m = JSON.parse(event.data);
                  if (m.t === "ok") {
                    thisHandle.tunnelPendingConnect = false;
                    thisHandle.tunnelOpen = true;
                    if (thisHandle.status !== plugin.Socket_Connected) {
                      thisHandle.status = plugin.Socket_Connected;
                      thisHandle._signalConnSemaphore();
                      thisHandle._signalWriteSemaphore();
                    }
                    if (thisHandle.sendBuffer && thisHandle.sendBuffer.byteLength) {
                      try { thisHandle.tunnelWS.send(thisHandle.sendBuffer); } catch(e) {}
                      thisHandle.sendBuffer = null;
                    }
                  } else if (m.t === "err") {
                    thisHandle.tunnelPendingConnect = false;
                    thisHandle._otherEndClosed();
                  } else if (m.t === "rc") {
                    thisHandle.tunnelClosed = true;
                    thisHandle._otherEndClosed();
                  }
                } catch(e) {
                }
                return;
              }
              var bytes = new Uint8Array(event.data);
              if (!thisHandle.response || !thisHandle.response.length) {
                thisHandle.response = [ bytes ];
              } else {
                thisHandle.response.push(bytes);
              }
              thisHandle.responseReceived = true;
              thisHandle._signalReadSemaphore();
            };
            (function() {
              var triedFallback = false;
              function detach(ref){ try { ref.onopen = ref.onmessage = ref.onerror = ref.onclose = null; } catch(_) {} }
              function attachHandlers() {
                thisHandle.tunnelWS.binaryType = "arraybuffer";
                thisHandle.tunnelPendingConnect = true;
                thisHandle.tunnelWS.onopen = function() {
                  var msg = JSON.stringify({ t: "c", h: thisHandle.host, p: thisHandle.port });
                  thisHandle.tunnelWS.send(msg);
                };
                thisHandle.tunnelWS.onmessage = function(event) {
                  if (typeof event.data === "string") {
                    try {
                      var m = JSON.parse(event.data);
                      if (m.t === "ok") {
                        thisHandle.tunnelPendingConnect = false;
                        thisHandle.tunnelOpen = true;
                        if (thisHandle.status !== plugin.Socket_Connected) {
                          thisHandle.status = plugin.Socket_Connected;
                          thisHandle._signalConnSemaphore();
                          thisHandle._signalWriteSemaphore();
                        }
                        if (thisHandle.sendBuffer && thisHandle.sendBuffer.byteLength) {
                          try { thisHandle.tunnelWS.send(thisHandle.sendBuffer); } catch(e) {}
                          thisHandle.sendBuffer = null;
                        }
                      } else if (m.t === "err") {
                        thisHandle.tunnelPendingConnect = false;
                        thisHandle._otherEndClosed();
                      } else if (m.t === "rc") {
                        thisHandle.tunnelClosed = true;
                        thisHandle._otherEndClosed();
                      }
                    } catch(e) {}
                    return;
                  }
                  var bytes = new Uint8Array(event.data);
                  if (!thisHandle.response || !thisHandle.response.length) {
                    thisHandle.response = [ bytes ];
                  } else {
                    thisHandle.response.push(bytes);
                  }
                  thisHandle.responseReceived = true;
                  thisHandle._signalReadSemaphore();
                };
                function tryFallbackOrClose(evt) {
                  if (!thisHandle.tunnelOpen && !triedFallback) {
                    triedFallback = true;
                    try {
                      detach(thisHandle.tunnelWS);
                      var proto = (location.protocol === "https:") ? "wss:" : "ws:";
                      var alt = proto + "//" + location.host + "/tcp-tunnel";
                      thisHandle.tunnelWS = new WebSocket(alt);
                      attachHandlers();
                      if (evt && evt.preventDefault) try { evt.preventDefault(); } catch(_) {}
                      return true;
                    } catch(_) {}
                  }
                  return false;
                }
                thisHandle.tunnelWS.onerror = function(evt) {
                  if (!tryFallbackOrClose(evt)) {
                    if (!thisHandle.tunnelOpen && thisHandle.tunnelPendingConnect) plugin._disableTunnel("WebSocket handshake failed for TCP tunnel");
                    thisHandle._otherEndClosed();
                  }
                };
                thisHandle.tunnelWS.onclose = function(evt) {
                  if (!tryFallbackOrClose(evt)) {
                    if (!thisHandle.tunnelOpen && thisHandle.tunnelPendingConnect) plugin._disableTunnel("WebSocket handshake failed for TCP tunnel");
                    thisHandle._otherEndClosed();
                  }
                };
              }
              attachHandlers();
            })();
            this.status = plugin.Socket_WaitingForConnection;
            this._signalConnSemaphore();
            return;
          }

          this.status = plugin.Socket_Connected;
          this._signalConnSemaphore();
          this._signalWriteSemaphore();
        },

        close: function() {
          if (this.status == plugin.Socket_Connected ||
              this.status == plugin.Socket_OtherEndClosed ||
              this.status == plugin.Socket_WaitingForConnection) {
            if (this.webSocket) {
              this.webSocket.close();
              this.webSocket = null;
            }
            if (this.tunnelWS) {
              this.tunnelWS.close();
              this.tunnelWS = null;
            }
            this.status = plugin.Socket_Unconnected;
            this._signalConnSemaphore();
          }
        },

        destroy: function() {
          this.status = plugin.Socket_InvalidSocket;
        },

        dataAvailable: function() {
          if (this.status == plugin.Socket_InvalidSocket) return false;
          if (this.status == plugin.Socket_Connected) {
            if (this.webSocket) {
              return this.response && this.response.length > 0;
            } else {
              if (this.response && this.response.length > 0) {
                this._signalReadSemaphore();
                return true;
              }
              if (this.responseSentCompletly) {
                // Signal older Socket implementations that they reached the end
                this.status = plugin.Socket_OtherEndClosed;
                this._signalConnSemaphore();
              }
            }
          }
          return false;
        },

        recv: function(count) {
          if (this.response === null) return [];
          var data = this.response[0] || new Uint8Array(0);
          if (data.length > count) {
            var rest = data.subarray(count);
            if (rest) {
              this.response[0] = rest;
            } else {
              this.response.shift();
            }
            data = data.subarray(0, count);
          } else {
            this.response.shift();
          }
          if (this.responseReceived && this.response.length === 0 && !this.webSocket && !this.tunnelWS) {
            this.responseSentCompletly = true;
          }

          return data;
        },

        send: function(data, start, end) {
          if (this.sendTimeout !== null) {
            self.clearTimeout(this.sendTimeout);
          }
          this.lastSend = Date.now();
          var newBytes = data.bytes.subarray(start, end);

          if (plugin._isTunnelEnabled() && this.tunnelWS) {
            if (!this.tunnelOpen) {
              if (this.sendBuffer === null) {
                this.sendBuffer = newBytes.slice();
              } else {
                var newLen = this.sendBuffer.byteLength + newBytes.byteLength;
                var nb = new Uint8Array(newLen);
                nb.set(this.sendBuffer, 0);
                nb.set(newBytes, this.sendBuffer.byteLength);
                this.sendBuffer = nb;
              }
              var thisHandle = this;
              this.sendTimeout = self.setTimeout(function() {
                if (thisHandle.tunnelOpen && thisHandle.sendBuffer && thisHandle.sendBuffer.byteLength) {
                  try { thisHandle.tunnelWS.send(thisHandle.sendBuffer); } catch(e) {}
                  thisHandle.sendBuffer = null;
                }
              }, 50);
              return newBytes.byteLength;
            }
            try {
              this.tunnelWS.send(newBytes);
            } catch(e) {
              this._otherEndClosed();
              return 0;
            }
            return newBytes.byteLength;
          }

          if (this.sendBuffer === null) {
            this.sendBuffer = newBytes.slice();
          } else {
            var newLength = this.sendBuffer.byteLength + newBytes.byteLength;
            var newBuffer = new Uint8Array(newLength);
            newBuffer.set(this.sendBuffer, 0);
            newBuffer.set(newBytes, this.sendBuffer.byteLength);
            this.sendBuffer = newBuffer;
          }
          this.sendTimeout = self.setTimeout(this._performRequest.bind(this), 50);
          return newBytes.byteLength;
        }
      };
    },

    primitiveHasSocketAccess: function(argCount) {
      this.interpreterProxy.popthenPush(argCount + 1, this.interpreterProxy.trueObject());
      return true;
    },

    primitiveInitializeNetwork: function(argCount) {
      if (argCount !== 1) return false;
      this.lookupSemaIdx = this.interpreterProxy.stackIntegerValue(0);
      this.status = this.Resolver_Ready;
      this.interpreterProxy.pop(argCount); // Answer self
      return true;
    },

    primitiveResolverNameLookupResult: function(argCount) {
      if (argCount !== 0) return false;

      // Validate that lastLookup is in fact a name (and not an address)
      if (!this.lastLookup || !this.lastLookup.substr) {
        this.interpreterProxy.popthenPush(argCount + 1, this.interpreterProxy.nilObject());
        return true;
      }

      // Retrieve result from cache
      var address = this._getAddressFromLookupCache(this.lastLookup, true);
      this.interpreterProxy.popthenPush(argCount + 1, address ?
        this.primHandler.makeStByteArray(address) :
        this.interpreterProxy.nilObject()
      );
      return true;
    },

    primitiveResolverStartNameLookup: function(argCount) {
      if (argCount !== 1) return false;

      var plugin = this;

      // Start new lookup, ignoring if one is in progress
      var lookup = this.lastLookup = this.interpreterProxy.stackValue(0).bytesAsString();

      // Perform lookup in local cache
      var result = this._getAddressFromLookupCache(lookup, false);
      if (result) {
        this.status = this.Resolver_Ready;
        this._signalLookupSemaphore();
      } else {

        // Perform DNS request via same-origin tunnel
        if (!plugin._isTunnelEnabled()) {
          this.status = this.Resolver_Ready;
          this._signalLookupSemaphore();
        } else {
          var queryStarted = false;
          var thisHandle = this;
          try {
            var opts = (typeof SqueakJS === "object" && SqueakJS.options) || {};
            var pathOrUrl = opts.tcpTunnelPath;
            var url;
            if (typeof pathOrUrl === "string" && /^(ws|wss):\/\//i.test(pathOrUrl)) {
              url = pathOrUrl;
            } else {
              var proto = (location.protocol === "https:") ? "wss:" : "ws:";
              var base = (document.baseURI || (location.origin + location.pathname));
              var baseUrl;
              try { baseUrl = new URL(base, location.origin); } catch(_) { baseUrl = null; }
              if (baseUrl) {
                if (!baseUrl.pathname.endsWith("/")) {
                  baseUrl.pathname = baseUrl.pathname.substring(0, baseUrl.pathname.lastIndexOf("/") + 1);
                }
                var rel = (typeof pathOrUrl === "string" && pathOrUrl.length) ? pathOrUrl : "tcp-tunnel";
                var finalPath = rel.charAt(0) === "/" ? rel : (baseUrl.pathname + rel);
                url = proto + "//" + location.host + finalPath;
              } else {
                url = proto + "//" + location.host + "/tcp-tunnel";
              }
            }
            var ws = new WebSocket(url);
            ws.onopen = function() {
              try { ws.send(JSON.stringify({ t: "dns", h: lookup })); } catch(e) { try { ws.close(); } catch(_) {} }
            };
            var finish = function() {
              if (lookup === thisHandle.lastLookup) {
                thisHandle.status = thisHandle.Resolver_Ready;
                thisHandle._signalLookupSemaphore();
              }
              try { ws.close(); } catch(_) {}
            };
            ws.onmessage = function(ev) {
              if (typeof ev.data !== "string") return;
              try {
                var msg = JSON.parse(ev.data);
                if (msg && msg.t === "dns") {
                  if (msg.r) {
                    thisHandle._addAddressFromResponseToLookupCache(msg.r);
                  }
                  finish();
                }
              } catch(_) {
                finish();
              }
            };
            (function() {
              var triedFallback = false, opened = false;
              var bind = function(wsRef) {
                wsRef.onopen = function() {
                  opened = true;
                  try { wsRef.send(JSON.stringify({ t: "dns", h: lookup })); } catch(e) { try { wsRef.close(); } catch(_) {} }
                };
                wsRef.onmessage = function(ev) {
                  if (typeof ev.data !== "string") return;
                  try {
                    var msg = JSON.parse(ev.data);
                    if (msg && msg.t === "dns") {
                      if (msg.r) {
                        thisHandle._addAddressFromResponseToLookupCache(msg.r);
                      }
                      finish();
                    }
                  } catch(_) {
                    finish();
                  }
                };
                function tryFallback(evt) {
                  if (!opened && !triedFallback) {
                    triedFallback = true;
                    try {
                      var proto = (location.protocol === "https:") ? "wss:" : "ws:";
                      var alt = proto + "//" + location.host + "/tcp-tunnel";
                      ws = new WebSocket(alt);
                      bind(ws);
                      if (evt && evt.preventDefault) try { evt.preventDefault(); } catch(_) {}
                      return true;
                    } catch(_) {}
                  }
                  return false;
                }
                wsRef.onerror = function(evt) {
                  if (!tryFallback(evt)) {
                    if (!opened) plugin._disableTunnel("WebSocket handshake failed for TCP tunnel");
                    finish();
                  }
                };
                wsRef.onclose = function(evt) {
                  if (!tryFallback(evt)) {
                    if (!opened) plugin._disableTunnel("WebSocket handshake failed for TCP tunnel");
                    finish();
                  }
                };
              };
              bind(ws);
            })();
            queryStarted = true;
        } catch(e) {
          console.error("Name lookup failed", e);
        }

        // Mark the receiver (ie resolver) is busy
        if (queryStarted) {
          this.status = this.Resolver_Busy;
          this._signalLookupSemaphore();
        }
        }
      }

      this.interpreterProxy.popthenPush(argCount + 1, this.interpreterProxy.nilObject());
      return true;
    },

    primitiveResolverAddressLookupResult: function(argCount) {
      if (argCount !== 0) return false;

      // Validate that lastLookup is in fact an address (and not a name)
      if (!this.lastLookup || !this.lastLookup.every) {
        this.interpreterProxy.popthenPush(argCount + 1, this.interpreterProxy.nilObject());
        return true;
      }

      // Retrieve result from cache
      var name = this._reverseLookupNameForAddress(this.lastLookup);
      var result = this.primHandler.makeStString(name);
      this.interpreterProxy.popthenPush(argCount + 1, result);
      return true;
    },

    primitiveResolverStartAddressLookup: function(argCount) {
      if (argCount !== 1) return false;

      // Start new lookup, ignoring if one is in progress
      this.lastLookup = this.interpreterProxy.stackBytes(0);
      this.interpreterProxy.popthenPush(argCount + 1, this.interpreterProxy.nilObject());

      // Immediately signal the lookup is ready (since all lookups are done internally)
      this.status = this.Resolver_Ready;
      this._signalLookupSemaphore();

      return true;
    },

    primitiveResolverStatus: function(argCount) {
      if (argCount !== 0) return false;
      this.interpreterProxy.popthenPush(argCount + 1, this.status);
      return true;
    },

    primitiveResolverAbortLookup: function(argCount) {
      if (argCount !== 0) return false;

      // Unable to abort send request (although future browsers might support AbortController),
      // just cancel the handling of the request by resetting the lastLookup value
      this.lastLookup = null;
      this.status = this.Resolver_Ready;
      this._signalLookupSemaphore();

      this.interpreterProxy.popthenPush(argCount + 1, this.interpreterProxy.nilObject());
      return true;
    },

    primitiveSocketRemoteAddress: function(argCount) {
      if (argCount !== 1) return false;
      var handle = this.interpreterProxy.stackObjectValue(0).handle;
      if (handle === undefined) return false;
      this.interpreterProxy.popthenPush(argCount + 1, handle.hostAddress ?
        this.primHandler.makeStByteArray(handle.hostAddress) :
        this.interpreterProxy.nilObject()
      );
      return true;
    },

    primitiveSocketRemotePort: function(argCount) {
      if (argCount !== 1) return false;
      var handle = this.interpreterProxy.stackObjectValue(0).handle;
      if (handle === undefined) return false;
      this.interpreterProxy.popthenPush(argCount + 1, handle.port);
      return true;
    },

    primitiveSocketConnectionStatus: function(argCount) {
      if (argCount !== 1) return false;
      var handle = this.interpreterProxy.stackObjectValue(0).handle;
      if (handle === undefined) return false;
      var status = handle.status;
      if (status === undefined) status = this.Socket_InvalidSocket;
      this.interpreterProxy.popthenPush(argCount + 1, status);
      return true;
    },

    primitiveSocketConnectToPort: function(argCount) {
      if (argCount !== 3) return false;
      var handle = this.interpreterProxy.stackObjectValue(2).handle;
      if (handle === undefined) return false;
      var hostAddress = this.interpreterProxy.stackBytes(1);
      var port = this.interpreterProxy.stackIntegerValue(0);
      handle.connect(hostAddress, port);
      this.interpreterProxy.popthenPush(argCount + 1,
                                        this.interpreterProxy.nilObject());
      return true;
    },
    primitiveSocketAbortConnection: function(argCount) {
      if (argCount !== 1) return false;
      var handle = this.interpreterProxy.stackObjectValue(0).handle;
      if (handle === undefined) return false;
      try { handle.close(); } catch(_) {}
      this.interpreterProxy.popthenPush(argCount + 1, this.interpreterProxy.nilObject());
      return true;
    },

    primitiveSocketCloseConnection: function(argCount) {
      if (argCount !== 1) return false;
      var handle = this.interpreterProxy.stackObjectValue(0).handle;
      if (handle === undefined) return false;
      handle.close();
      this.interpreterProxy.popthenPush(argCount + 1, this.interpreterProxy.nilObject());
      return true;
    },

    primitiveSocketCreate3Semaphores: function(argCount) {
      if (argCount !== 7) return false;
      var writeSemaIndex = this.interpreterProxy.stackIntegerValue(0);
      var readSemaIndex = this.interpreterProxy.stackIntegerValue(1);
      var semaIndex = this.interpreterProxy.stackIntegerValue(2);
      var sendBufSize = this.interpreterProxy.stackIntegerValue(3);
      var socketType = this.interpreterProxy.stackIntegerValue(5);
      if (socketType !== this.TCP_Socket_Type) return false;
      var name = '{SqueakJS Socket #' + (++this.handleCounter) + '}';
      var sqHandle = this.primHandler.makeStString(name);
      sqHandle.handle = this._newSocketHandle(sendBufSize, semaIndex,
                                              readSemaIndex, writeSemaIndex);
      this.interpreterProxy.popthenPush(argCount + 1, sqHandle);
      return true;
    },

    primitiveSocketDestroy: function(argCount) {
      if (argCount !== 1) return false;
      var handle = this.interpreterProxy.stackObjectValue(0).handle;
      if (handle === undefined) return false;
      handle.destroy();
      this.interpreterProxy.popthenPush(argCount + 1, handle.status);
      return true;
    },

    primitiveSocketReceiveDataAvailable: function(argCount) {
      if (argCount !== 1) return false;
      var handle = this.interpreterProxy.stackObjectValue(0).handle;
      if (handle === undefined) return false;
      var ret = this.interpreterProxy.falseObject();
      if (handle.dataAvailable()) {
        ret = this.interpreterProxy.trueObject();
      }
      this.interpreterProxy.popthenPush(argCount + 1, ret);
      return true;
    },

    primitiveSocketReceiveDataBufCount: function(argCount) {
      if (argCount !== 4) return false;
      var handle = this.interpreterProxy.stackObjectValue(3).handle;
      if (handle === undefined) return false;
      var target = this.interpreterProxy.stackObjectValue(2);
      var start = this.interpreterProxy.stackIntegerValue(1) - 1;
      var count = this.interpreterProxy.stackIntegerValue(0);
      if ((start + count) > target.bytes.length) return false;
      var bytes = handle.recv(count);
      target.bytes.set(bytes, start);
      this.interpreterProxy.popthenPush(argCount + 1, bytes.length);
      return true;
    },

    primitiveSocketSendDataBufCount: function(argCount) {
      if (argCount !== 4) return false;
      var handle = this.interpreterProxy.stackObjectValue(3).handle;
      if (handle === undefined) return false;
      var data = this.interpreterProxy.stackObjectValue(2);
      var start = this.interpreterProxy.stackIntegerValue(1) - 1;
      if (start < 0 ) return false;
      var count = this.interpreterProxy.stackIntegerValue(0);
      var end = start + count;
      if (end > data.length) return false;

      var res = handle.send(data, start, end);
      this.interpreterProxy.popthenPush(argCount + 1, res);
      return true;
    },
    primitiveResolverHostNameSize: function(argCount) {
      if (argCount !== 1) return false;
      var name = this.lastLookup || '';
      var len = (typeof name === 'string') ? name.length : 0;
      this.interpreterProxy.popthenPush(argCount + 1, len);
      return true;
    },

    primitiveSocketSendDone: function(argCount) {
      if (argCount !== 1) return false;
      this.interpreterProxy.popthenPush(argCount + 1, this.interpreterProxy.trueObject());
      return true;
    },

    primitiveSocketListenWithOrWithoutBacklog: function(argCount) {
      if (argCount < 2) return false;
      this.interpreterProxy.popthenPush(argCount + 1, this.interpreterProxy.nilObject());
      return true;
    },
  };
}

function registerSocketPlugin() {
    if (typeof Squeak === "object" && Squeak.registerExternalModule) {
        Squeak.registerExternalModule('SocketPlugin', SocketPlugin());
    } else self.setTimeout(registerSocketPlugin, 100);
};

registerSocketPlugin();
