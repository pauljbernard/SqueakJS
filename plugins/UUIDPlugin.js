"use strict";
(function UUIDPlugin() {
  var moduleName = "UUIDPlugin (browser)";
  var interpreterProxy = null;

  function getModuleName() { return moduleName; }
  function setInterpreter(interp) { interpreterProxy = interp; return true; }

  function primitiveMakeUUID(argCount) {
    if (!interpreterProxy) return false;
    var bytes = new Uint8Array(16);
    if (typeof crypto !== "undefined" && crypto.getRandomValues) crypto.getRandomValues(bytes);
    else for (var i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    var ba = interpreterProxy.instantiateClassindexableSize(interpreterProxy.classByteArray(), 16);
    for (var j = 0; j < 16; j++) ba.bytes[j] = bytes[j];
    interpreterProxy.popthenPush(argCount + 1, ba);
    return true;
  }

  function registerPlugin() {
    return {
      getModuleName: getModuleName,
      setInterpreter: setInterpreter,
      primitiveMakeUUID: primitiveMakeUUID
    };
  }

  if (typeof Squeak === "object" && Squeak.registerExternalModule) {
    Squeak.registerExternalModule("UUIDPlugin", registerPlugin());
  } else if (typeof module !== "undefined" && module.exports) {
    module.exports = registerPlugin();
  }
})();
