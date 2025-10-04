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

Object subclass: #SqueakJSSuspendAndBackupPCTestHelper
    instanceVariableNames: 'shouldSuspend resumeValue'
    classVariableNames: ''
    package: 'SqueakJSTesting'.

SqueakJSSuspendAndBackupPCTestHelper >> initialize
    super initialize.
    shouldSuspend := true.
    resumeValue := nil.

SqueakJSSuspendAndBackupPCTestHelper >> shouldSuspend
    ^ shouldSuspend

SqueakJSSuspendAndBackupPCTestHelper >> resumeValue
    ^ resumeValue

SqueakJSSuspendAndBackupPCTestHelper >> waitForSuspend
    shouldSuspend ifTrue: [
        shouldSuspend := false.
        Processor activeProcess suspendAndBackupPC ].
    resumeValue := #resumed.
    ^ resumeValue

TestCase subclass: #SqueakJSSuspendAndBackupPCTest
    instanceVariableNames: ''
    classVariableNames: ''
    package: 'SqueakJSTesting'.

SqueakJSSuspendAndBackupPCTest >> testSuspendAndBackupPC
    | helper process context method expectedPC |
    helper := SqueakJSSuspendAndBackupPCTestHelper new.
    process := [ helper waitForSuspend ] newProcess.
    process priority: Processor activePriority + 1.
    process resume.
    Processor yield.
    context := process suspendedContext.
    self assert: helper shouldSuspend not.
    self assert: context method selector = #waitForSuspend.
    self assert: context top = process.
    method := context method.
    expectedPC := nil.
    method symbolic linesDo: [:line |
        (line includesSubstring: 'suspendAndBackupPC') ifTrue: [
            expectedPC := (line upTo: $<) withBlanksTrimmed asNumber ]].
    self assert: expectedPC notNil.
    self assert: context pc = expectedPC.
    process resume.
    Processor yield.
    self assert: helper resumeValue = #resumed.
    process terminate.

SqueakJSTesting test: 'tests.ston'.
Smalltalk quitPrimitive
