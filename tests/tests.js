__karma__.start = function() {
    var warnings = [];
    var originalConsoleWarn = console.warn;
    console.warn = function() {
        warnings.push(Array.prototype.map.call(arguments, function(each) {
            return String(each);
        }).join(' '));
        originalConsoleWarn.apply(console, arguments);
    };

    var canvas = document.createElement('canvas');
    canvas.width = 800;
    canvas.height = 600;
    canvas.style.backgroundColor = 'black';
    document.body.appendChild(canvas);
    SqueakJS.runSqueak(null, canvas, {
        appName: 'SqueakJS Tests',
        url: 'base/tests/resources/',
        files: ['test.image', 'test.changes', 'SqueakV50.sources', 'tests.ston'],
        document: 'tests.st',
        forceDownload: true,
        onQuit: function() {
            console.warn = originalConsoleWarn;
            var largeIntegerWarning = warnings.some(function(message) {
                return message.indexOf('missing primitive: 158') >= 0;
            });
            if (largeIntegerWarning) {
                __karma__.error('Large integer comparison primitive reported missing (primitive 158).');
            }
            if (!Squeak.externalModules || !Squeak.externalModules.LargeIntegers) {
                __karma__.error('LargeIntegers plugin was not registered.');
            }
            __karma__.complete();
        },
    });
};