import assert from "node:assert/strict";
import test from "node:test";
import { focusExistingWindow } from "../src/desktop/windowLifecycle.js";

test("second launch never touches destroyed windows or windows shutting down", () => {
  const invalid = () => { throw new TypeError("Object has been destroyed"); };
  const window = { isDestroyed: () => true, isMinimized: invalid, restore: invalid, show: invalid, focus: invalid };
  assert.doesNotThrow(() => focusExistingWindow(window, false));
  assert.doesNotThrow(() => focusExistingWindow({ ...window, isDestroyed: invalid }, true));
  assert.doesNotThrow(() => focusExistingWindow(undefined, false));
});

test("second launch restores and focuses a live window", () => {
  const calls: string[] = [];
  focusExistingWindow({ isDestroyed: () => false, isMinimized: () => true,
    restore: () => { calls.push("restore"); }, show: () => { calls.push("show"); }, focus: () => { calls.push("focus"); } }, false);
  assert.deepEqual(calls, ["restore", "show", "focus"]);
});
