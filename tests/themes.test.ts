import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { themes, validTheme } from "../frontend/src/themes.js";

const luminance = (hex: string) => {
  const rgb = hex.slice(1).match(/../g)!.map(v => parseInt(v, 16) / 255)
    .map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4);
  return rgb[0]! * .2126 + rgb[1]! * .7152 + rgb[2]! * .0722;
};
const contrast = (a: string, b: string) => {
  const x = luminance(a), y = luminance(b);
  return (Math.max(x, y) + .05) / (Math.min(x, y) + .05);
};
test("four stable theme IDs and readable text, status and action colors", () => {
  assert.deepEqual(themes.map(t => t.id), ["light", "dark", "eye", "midnight"]);
  assert.equal(validTheme("custom"), "dark");
  const css = readFileSync("frontend/src/themes.css", "utf8");
  for (const theme of themes) {
    const body = css.split(`:root[data-theme="${theme.id}"] {`)[1]!.split("}")[0]!;
    const vars = Object.fromEntries([...body.matchAll(/--([\w-]+):\s*(#[\da-f]{6}|#fff)\s*;/g)].map(m => [m[1], m[2] === "#fff" ? "#ffffff" : m[2]]));
    for (const background of ["bg", "panel", "panel-2"]) {
      const roles = theme.id === "light" || theme.id === "eye" ? ["heading", "secondary", "helper"] : [];
      for (const foreground of ["text", "muted", "blue", "green", "amber", "red", ...roles]) {
        assert.ok(contrast(vars[foreground], vars[background]) >= 4.5, `${theme.id}: ${foreground}/${background}`);
      }
    }
    assert.ok(contrast(vars["on-accent"], vars.blue) >= 4.5, `${theme.id}: button text`);
    assert.ok(contrast(vars["on-action"], vars.action) >= 4.5, `${theme.id}: action text`);
    if (theme.id === "light" || theme.id === "eye") {
      assert.ok(luminance(vars.heading) < luminance(vars.text));
      assert.ok(luminance(vars.text) < luminance(vars.secondary));
      assert.ok(luminance(vars.secondary) < luminance(vars.helper));
    }
  }
});
