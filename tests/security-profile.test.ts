import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { materializePortableProfile, parsePortableWorkflowPackage } from "../src/core/workflows/package.js";
import { validateProfile, validateProfileAgainstWorkflow } from "../src/core/workflows/profiles.js";

function fixture() {
  const pkg = parsePortableWorkflowPackage(JSON.parse(readFileSync("bundled-workflows/minimax-h3-selflift.rhworkflow.json", "utf8")));
  return { profile: materializePortableProfile(pkg, "test", 1), raw: pkg.workflow.apiJson };
}
test("profile rejects different IDs targeting the same API input", () => {
  const { profile } = fixture();
  profile.parameters.push({ ...profile.parameters[0]!, id: "duplicate-target" });
  assert.throws(() => validateProfile(profile), /Duplicate workflow parameter target/);
});
test("profile does not accept inherited object fields as API inputs", () => {
  const { profile, raw } = fixture();
  profile.parameters[0]!.fieldName = "toString";
  assert.throws(() => validateProfileAgainstWorkflow(profile, raw), /失效参数映射/);
});
