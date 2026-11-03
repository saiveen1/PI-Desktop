import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const root = new URL("../../../", import.meta.url);
const read = (path) => readFileSync(new URL(path, root), "utf8");
const policyFiles = {
  "AGENTS.md": read("AGENTS.md"),
  "CLAUDE.md": read("CLAUDE.md"),
};
const gateSource = read("scripts/check-agent-policy-sync.mjs");

function runGate(t, overrides = {}) {
  const directory = mkdtempSync(join(tmpdir(), "pi-agent-policy-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  mkdirSync(join(directory, "scripts"));
  writeFileSync(join(directory, "scripts/check-agent-policy-sync.mjs"), gateSource);
  for (const [path, content] of Object.entries({ ...policyFiles, ...overrides })) {
    writeFileSync(join(directory, path), content);
  }
  const result = spawnSync(process.execPath, [join(directory, "scripts/check-agent-policy-sync.mjs")], {
    encoding: "utf8",
    timeout: 10_000,
    windowsHide: true,
  });
  assert.ifError(result.error);
  return result;
}

test("local main development and optional worktrees pass the mirrored policy gate", (t) => {
  for (const source of Object.values(policyFiles)) {
    assert.match(source, /Develop in the current checkout by default, including on local `main`\./);
    assert.match(source, /Branches and worktrees are optional, not prerequisites for development\./);
    assert.doesNotMatch(source, /1 request = 1 branch \+ 1 dedicated worktree|Never develop on `main`|Confirm you are \(or will create\) a dedicated worktree/);
  }
  const result = runGate(t);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Agent policy sync check passed/);
});

test("the gate rejects restoring compulsory worktrees in either entry point", (t) => {
  for (const path of Object.keys(policyFiles)) {
    const result = runGate(t, {
      [path]: policyFiles[path].replace(
        "Branches and worktrees are optional, not prerequisites for development.",
        "Every request must create a dedicated worktree.",
      ),
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /optional-worktree-isolation/);
  }
});

test("the gate rejects dropping development data safety from either entry point", (t) => {
  for (const path of Object.keys(policyFiles)) {
    const result = runGate(t, {
      [path]: policyFiles[path].replace(
        "Dev launches must isolate inherited data by default.",
        "Development data safety removed in this negative test fixture.",
      ),
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /development-data-safety/);
  }
});

test("policy synchronization and architecture boundaries remain enforced", (t) => {
  const mismatched = runGate(t, {
    "CLAUDE.md": policyFiles["CLAUDE.md"].replace(/Policy-Sync: \S+/, "Policy-Sync: mismatched-fixture"),
  });
  assert.equal(mismatched.status, 1);
  assert.match(mismatched.stderr, /Policy-Sync token mismatch/);

  const missingBoundary = runGate(t, {
    "CLAUDE.md": policyFiles["CLAUDE.md"].replace(
      "SQLite is owned exclusively by Rust `host-core`.",
      "Boundary removed in this negative test fixture.",
    ),
  });
  assert.equal(missingBoundary.status, 1);
  assert.match(missingBoundary.stderr, /sqlite-host-core-only/);
});

test("the gate requires fixed packaging and forbids implicit installation in both mirrors", (t) => {
  for (const path of Object.keys(policyFiles)) {
    for (const [phrase, anchor] of [
      ["Personal packaging must use `pnpm dist:personal` in the current checkout.", "fixed-personal-packaging-entry"],
      ["A packaging request never authorizes installation or application startup.", "packaging-is-not-installation"],
    ]) {
      assert.ok(policyFiles[path].includes(phrase));
      const result = runGate(t, { [path]: policyFiles[path].replace(phrase, "Removed by negative fixture.") });
      assert.equal(result.status, 1);
      assert.ok(result.stderr.includes(anchor));
    }
  }
});
