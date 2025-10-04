"use strict";
(function ClipboardExtendedPlugin() {
  var moduleName = "ClipboardExtendedPlugin (browser)";
  var interpreterProxy = null;

  function getModuleName() { return moduleName; }
  function setInterpreter(interp) { interpreterProxy = interp; return true; }

  function ioCreateClipboard(argCount) {
    if (!interpreterProxy) return false;
    interpreterProxy.popthenPush(argCount + 1, 1);
    return true;
  }

  function registerPlugin() {
    return {
      getModuleName: getModuleName,
      setInterpreter: setInterpreter,
      ioCreateClipboard: ioCreateClipboard
    };
  }

  if (typeof Squeak === "object" && Squeak.registerExternalModule) {
    Squeak.registerExternalModule("ClipboardExtendedPlugin", registerPlugin());
  } else if (typeof module !== "undefined" && module.exports) {
    module.exports = registerPlugin();
  }
})();
