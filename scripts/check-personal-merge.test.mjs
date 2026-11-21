import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { protectedCases } from "./check-personal-merge.mjs";

const gate = fileURLToPath(new URL("./check-personal-merge.mjs", import.meta.url));
const header = 'import test from "node:test";\n';
const passing = names => names.map(name => `test(${JSON.stringify(name)}, () => {});`).join("\n");

test("merge gate requires real passing cases in the registered files", async t => {
  const cwd = mkdtempSync(join(process.env.PI_SCRATCH_DIR || tmpdir(), "merge-gate-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  for (const [file, names] of Object.entries(protectedCases)) {
    mkdirSync(dirname(join(cwd, file)), { recursive: true });
    writeFileSync(join(cwd, file), header + passing(names));
  }
  const [file, [name, ...siblings]] = Object.entries(protectedCases)[0];
  const nested = `test('parent', async t => { await t.test(${JSON.stringify(name)}, () => {}); });`;
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT; // Launch the CLI as a user would, not as a nested test runner.
  for (const [label, body, expected] of [
    ["executed nested case", nested, 0],
    ["failed teardown after a passing case", `${nested} test.after(() => { throw Error('teardown failed'); });`, 1],
    ["skipped parent", nested.replace("test(", "test.skip("), 1],
    ["skipped case", `test.skip(${JSON.stringify(name)}, () => {});`, 1],
    ["TODO case", `test.todo(${JSON.stringify(name)});`, 1],
    ["failed assertion", `test(${JSON.stringify(name)}, () => { throw Error('lost behavior'); });`, 1],
    ["unrelated green case", "test('other', () => {});", 1],
    ["empty file", "", 1],
    ["missing file", null, 1],
  ]) await t.test(label, () => {
    const target = join(cwd, file);
    if (body === null) rmSync(target);
    else writeFileSync(target, header + body + (body && passing(siblings)));
    const result = spawnSync(process.execPath, [gate], { cwd, env, encoding: "utf8" });
    assert.ifError(result.error);
    assert.equal(result.status, expected, result.stdout + result.stderr);
    if (expected) assert.ok((result.stdout + result.stderr).includes(name), result.stdout + result.stderr);
  });
});
