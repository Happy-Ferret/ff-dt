/* Any copyright is dedicated to the Public Domain.
   http://creativecommons.org/publicdomain/zero/1.0/ */

var isOSX = Services.appinfo.OS === "Darwin";

add_task(function* () {
  let shortcuts = new KeyShortcuts({
    window
  });
  yield testSimple(shortcuts);
  yield testNonLetterCharacter(shortcuts);
  yield testMixup(shortcuts);
  yield testLooseDigits(shortcuts);
  yield testExactModifiers(shortcuts);
  yield testLooseShiftModifier(shortcuts);
  yield testStrictLetterShiftModifier(shortcuts);
  yield testAltModifier(shortcuts);
  yield testCommandOrControlModifier(shortcuts);
  yield testCtrlModifier(shortcuts);
  shortcuts.destroy();
});

// Test helper to listen to the next key press for a given key,
// returning a promise to help using Tasks.
function once(shortcuts, key, listener) {
  let called = false;
  return new Promise(done => {
    let onShortcut = (key2, event) => {
      shortcuts.off(key, onShortcut);
      ok(!called, "once listener called only once (i.e. off() works)");
      is(key, key2, "listener first argument match the key we listen");
      called = true;
      listener(key2, event);
      done();
    };
    shortcuts.on(key, onShortcut);
  });
}

function testSimple(shortcuts) {
  info("Test simple key shortcuts");

  let onKey = once(shortcuts, "0", (key, event) => {
    is(event.key, "0");

    // Display another key press to ensure that once() correctly stop listening
    EventUtils.synthesizeKey("0", {}, window);
  });

  EventUtils.synthesizeKey("0", {}, window);
  yield onKey;
}

function testNonLetterCharacter(shortcuts) {
  info("Test non-naive character key shortcuts");

  let onKey = once(shortcuts, "[", (key, event) => {
    is(event.key, "[");
  });

  EventUtils.synthesizeKey("[", {}, window);
  yield onKey;
}

// Test they listeners are not mixed up between shortcuts
function testMixup(shortcuts) {
  info("Test possible listener mixup");

  let hitFirst = false, hitSecond = false;
  let onFirstKey = once(shortcuts, "0", (key, event) => {
    is(event.key, "0");
    hitFirst = true;
  });
  let onSecondKey = once(shortcuts, "Alt+A", (key, event) => {
    is(event.key, "a");
    ok(event.altKey);
    hitSecond = true;
  });

  // Dispatch the first shortcut and expect only this one to be notified
  ok(!hitFirst, "First shortcut isn't notified before firing the key event");
  EventUtils.synthesizeKey("0", {}, window);
  yield onFirstKey;
  ok(hitFirst, "Got the first shortcut notified");
  ok(!hitSecond, "No mixup, second shortcut is still not notified (1/2)");

  // Wait an extra time, just to be sure this isn't racy
  yield new Promise(done => {
    window.setTimeout(done, 0);
  });
  ok(!hitSecond, "No mixup, second shortcut is still not notified (2/2)");

  // Finally dispatch the second shortcut
  EventUtils.synthesizeKey("a", { altKey: true }, window);
  yield onSecondKey;
  ok(hitSecond, "Got the second shortcut notified once it is actually fired");
}

// On azerty keyboard, digits are only available by pressing Shift/Capslock,
// but we accept them even if we omit doing that.
function testLooseDigits(shortcuts) {
  info("Test Loose digits");
  let onKey = once(shortcuts, "0", (key, event) => {
    is(event.key, "à");
    ok(!event.altKey);
    ok(!event.ctrlKey);
    ok(!event.metaKey);
    ok(!event.shiftKey);
  });
  // Simulate a press on the "0" key, without shift pressed on a french
  // keyboard
  EventUtils.synthesizeKey(
    "à",
    { keyCode: 48 },
    window);
  yield onKey;

  onKey = once(shortcuts, "0", (key, event) => {
    is(event.key, "0");
    ok(!event.altKey);
    ok(!event.ctrlKey);
    ok(!event.metaKey);
    ok(event.shiftKey);
  });
  // Simulate the same press with shift pressed
  EventUtils.synthesizeKey(
    "0",
    { keyCode: 48, shiftKey: true },
    window);
  yield onKey;
}

// Test that shortcuts is notified only when the modifiers match exactly
function testExactModifiers(shortcuts) {
  info("Test exact modifiers match");

  let hit = false;
  let onKey = once(shortcuts, "Alt+A", (key, event) => {
    is(event.key, "a");
    ok(event.altKey);
    ok(!event.ctrlKey);
    ok(!event.metaKey);
    ok(!event.shiftKey);
    hit = true;
  });

  // Dispatch with unexpected set of modifiers
  ok(!hit, "Shortcut isn't notified before firing the key event");
  EventUtils.synthesizeKey("a",
    { accelKey: true, altKey: true, shiftKey: true },
    window);
  EventUtils.synthesizeKey(
    "a",
    { accelKey: true, altKey: false, shiftKey: false },
    window);
  EventUtils.synthesizeKey(
    "a",
    { accelKey: false, altKey: false, shiftKey: true },
    window);
  EventUtils.synthesizeKey(
    "a",
    { accelKey: false, altKey: false, shiftKey: false },
    window);

  // Wait an extra time to let a chance to call the listener
  yield new Promise(done => {
    window.setTimeout(done, 0);
  });
  ok(!hit, "Listener isn't called when modifiers aren't exactly matching");

  // Dispatch the expected modifiers
  EventUtils.synthesizeKey("a", { accelKey: false, altKey: true, shiftKey: false},
                           window);
  yield onKey;
  ok(hit, "Got shortcut notified once it is actually fired");
}

// Some keys are only accessible via shift and listener should also be called
// even if the key didn't explicitely requested Shift modifier.
// For example, `%` on french keyboards is only accessible via Shift.
// Same thing for `@` on US keybords.
function testLooseShiftModifier(shortcuts) {
  info("Test Loose shift modifier");
  let onKey = once(shortcuts, "%", (key, event) => {
    is(event.key, "%");
    ok(!event.altKey);
    ok(!event.ctrlKey);
    ok(!event.metaKey);
    ok(event.shiftKey);
  });
  EventUtils.synthesizeKey(
    "%",
    { accelKey: false, altKey: false, ctrlKey: false, shiftKey: true},
    window);
  yield onKey;

  onKey = once(shortcuts, "@", (key, event) => {
    is(event.key, "@");
    ok(!event.altKey);
    ok(!event.ctrlKey);
    ok(!event.metaKey);
    ok(event.shiftKey);
  });
  EventUtils.synthesizeKey(
    "@",
    { accelKey: false, altKey: false, ctrlKey: false, shiftKey: true},
    window);
  yield onKey;
}

// But Shift modifier is strict on all letter characters (a to Z)
function testStrictLetterShiftModifier(shortcuts) {
  info("Test strict shift modifier on letters");
  let hitFirst = false;
  let onKey = once(shortcuts, "a", (key, event) => {
    is(event.key, "a");
    ok(!event.altKey);
    ok(!event.ctrlKey);
    ok(!event.metaKey);
    ok(!event.shiftKey);
    hitFirst = true;
  });
  let onShiftKey = once(shortcuts, "Shift+a", (key, event) => {
    is(event.key, "a");
    ok(!event.altKey);
    ok(!event.ctrlKey);
    ok(!event.metaKey);
    ok(event.shiftKey);
  });
  EventUtils.synthesizeKey(
    "a",
    { shiftKey: true},
    window);
  yield onShiftKey;
  ok(!hitFirst, "Didn't fire the explicit shift+a");

  EventUtils.synthesizeKey(
    "a",
    { shiftKey: false},
    window);
  yield onKey;
}

function testAltModifier(shortcuts) {
  info("Test Alt modifier");
  let onKey = once(shortcuts, "Alt+F1", (key, event) => {
    is(event.keyCode, window.KeyboardEvent.DOM_VK_F1);
    ok(event.altKey);
    ok(!event.ctrlKey);
    ok(!event.metaKey);
    ok(!event.shiftKey);
  });
  EventUtils.synthesizeKey(
    "VK_F1",
    { altKey: true },
    window);
  yield onKey;
}

function testCommandOrControlModifier(shortcuts) {
  info("Test CommandOrControl modifier");
  let onKey = once(shortcuts, "CommandOrControl+F1", (key, event) => {
    is(event.keyCode, window.KeyboardEvent.DOM_VK_F1);
    ok(!event.altKey);
    if (isOSX) {
      ok(!event.ctrlKey);
      ok(event.metaKey);
    } else {
      ok(event.ctrlKey);
      ok(!event.metaKey);
    }
    ok(!event.shiftKey);
  });
  let onKeyAlias = once(shortcuts, "CmdOrCtrl+F1", (key, event) => {
    is(event.keyCode, window.KeyboardEvent.DOM_VK_F1);
    ok(!event.altKey);
    if (isOSX) {
      ok(!event.ctrlKey);
      ok(event.metaKey);
    } else {
      ok(event.ctrlKey);
      ok(!event.metaKey);
    }
    ok(!event.shiftKey);
  });
  if (isOSX) {
    EventUtils.synthesizeKey(
      "VK_F1",
      { metaKey: true },
      window);
  } else {
    EventUtils.synthesizeKey(
      "VK_F1",
      { ctrlKey: true },
      window);
  }
  yield onKey;
  yield onKeyAlias;
}

function testCtrlModifier(shortcuts) {
  info("Test Ctrl modifier");
  let onKey = once(shortcuts, "Ctrl+F1", (key, event) => {
    is(event.keyCode, window.KeyboardEvent.DOM_VK_F1);
    ok(!event.altKey);
    ok(event.ctrlKey);
    ok(!event.metaKey);
    ok(!event.shiftKey);
  });
  let onKeyAlias = once(shortcuts, "Control+F1", (key, event) => {
    is(event.keyCode, window.KeyboardEvent.DOM_VK_F1);
    ok(!event.altKey);
    ok(event.ctrlKey);
    ok(!event.metaKey);
    ok(!event.shiftKey);
  });
  EventUtils.synthesizeKey(
    "VK_F1",
    { ctrlKey: true },
    window);
  yield onKey;
  yield onKeyAlias;
}
