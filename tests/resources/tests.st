FileStream stdout converter: UTF8TextConverter new.

TestCase subclass: #SqueakJSLargeIntegerPrimitiveTest
    instanceVariableNames: ''
    classVariableNames: ''
    package: 'SqueakJSTesting'.

SqueakJSLargeIntegerPrimitiveTest >> testDigitComparePrimitive
    | high low |
    high := 1 << 80.
    low := high - 1.
    self assert: high class == LargePositiveInteger.
    self assert: low class == LargePositiveInteger.
    self assert: (high digitCompare: high) = 0.
    self assert: (high digitCompare: low) = 1.
    self assert: (low digitCompare: high) = -1.

SqueakJSTesting test: 'tests.ston'.
Smalltalk quitPrimitive
