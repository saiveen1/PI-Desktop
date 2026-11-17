import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("..", import.meta.url));
const require = createRequire(new URL("../packages/shared/package.json", import.meta.url));
const modulePath = path.dirname(path.dirname(require.resolve("typescript/package.json")));
const locales = ["en", "zh-CN", "zh-TW", "tr", "de", "es", "fr", "ko", "pt-BR"];

function fixture(t, version = "0.23.1-beta.1", catalogVersion = "0.23.0") {
  const directory = mkdtempSync(path.join(process.env.PI_SCRATCH_DIR ?? tmpdir(), "release-doc-gate-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const write = (file, content) => {
    const target = path.join(directory, file);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, content);
  };
  for (const file of ["package.json", "docs/package.json", "apps/desktop/package.json", "packages/shared/package.json"]) {
    write(file, JSON.stringify({ type: "module", version }));
  }
  write("Cargo.toml", `[workspace.package]\nversion = "${version}"\n`);
  write("Cargo.lock", `name = "host-core"\nversion = "${version}"\n`);
  write("packages/shared/src/protocol.ts", `export const APP_VERSION = "${version}";\n`);
  write("apps/desktop/resources/models.dev/api.json", JSON.stringify({ fixture: { models: { chat: {} } } }));
  write("apps/desktop/electron/main/settings-operation-metadata.json", JSON.stringify([
    { vendor: "fixture", id: "image", modalities: { output: ["image"] } },
  ]));
  const catalogs = Object.fromEntries(locales.map(locale => [locale, [{ version: catalogVersion, highlights: ["Recorded stable capability"] }]]));
  const saveCatalogs = () => write("packages/shared/src/changelog.ts", `export const CHANGELOG = ${JSON.stringify(catalogs)};\n`);
  saveCatalogs();
  write("packages/shared/src/changelog.test.ts", `const expected = ["${catalogVersion}"];\n`);
  for (const file of ["README.md", "README.zh-CN.md"]) write(file, "Current release line: 0.23.x\n");
  mkdirSync(path.join(directory, "scripts"));
  for (const file of ["check-release-docs.mjs", "release-version-check.mjs"]) {
    copyFileSync(path.join(root, "scripts", file), path.join(directory, "scripts", file));
  }
  const run = (...args) => {
    const result = spawnSync(process.execPath, [path.join(directory, "scripts/check-release-docs.mjs"), ...args], {
      cwd: directory, encoding: "utf8", timeout: 10_000,
      env: { ...process.env, NODE_PATH: modulePath },
    });
    assert.ifError(result.error);
    return { code: result.status, output: result.stdout + result.stderr };
  };
  return { write, catalogs, saveCatalogs, run };
}

test("the real CLI checks a personal beta without inventing a stable release", t => {
  const result = fixture(t).run();
  assert.equal(result.code, 0, result.output);
  assert.match(result.output, /0\.23\.1-beta\.1/);
  assert.match(result.output, /0\.23\.0/);
  assert.match(result.output, /not stable-release qualification/i);
});

test("explicit stable preview and stable release checks retain their original contracts", async t => {
  await t.test("matching explicit preview succeeds", t => {
    const result = fixture(t, "0.23.1-beta.1", "0.23.1").run("0.23.1");
    assert.equal(result.code, 0, result.output);
  });
  await t.test("matching stable release succeeds", t => {
    const result = fixture(t, "0.23.0").run();
    assert.equal(result.code, 0, result.output);
  });
  await t.test("a stable release cannot reuse an earlier catalog", t => {
    const result = fixture(t, "0.23.1").run();
    assert.equal(result.code, 1, result.output);
    assert.match(result.output, /en has no entry for 0\.23\.1/);
  });
  await t.test("an explicit older version still rejects the beta source", t => {
    const result = fixture(t).run("0.23.0");
    assert.equal(result.code, 1, result.output);
    assert.match(result.output, /version is 0\.23\.1-beta\.1, expected 0\.23\.0/);
  });
});

test("automatic beta checking still rejects every mismatched release surface", async t => {
  const cases = [
    ["workspace package", f => f.write("apps/desktop/package.json", '{"version":"0.23.2-beta.1"}'), /apps[\\/]desktop[\\/]package\.json: version is/],
    ["Cargo version", f => f.write("Cargo.lock", 'name = "host-core"\nversion = "0.23.0"\n'), /host-core version is 0\.23\.0/],
    ["APP_VERSION", f => f.write("packages/shared/src/protocol.ts", 'export const APP_VERSION = "0.23.0";'), /APP_VERSION is 0\.23\.0/],
    ["missing locale", f => { delete f.catalogs["zh-CN"]; f.saveCatalogs(); }, /missing shipped locale catalog: zh-CN/],
    ["locale version", f => { f.catalogs.fr[0].version = "0.22.0"; f.saveCatalogs(); }, /fr has no entry for 0\.23\.0/],
    ["highlight count", f => { f.catalogs.fr[0].highlights.push("Extra"); f.saveCatalogs(); }, /fr highlight count differs/],
    ["catalog test pin", f => f.write("packages/shared/src/changelog.test.ts", 'const expected = ["0.22.0"];'), /expected version list does not contain 0\.23\.0/],
    ["README line", f => f.write("README.zh-CN.md", "Current release line: 0.22.x"), /README\.zh-CN\.md: status section/],
    ["unrelated catalog", f => { for (const entries of Object.values(f.catalogs)) entries[0].version = "0.22.0"; f.saveCatalogs(); }, /en has no entry for 0\.23\.1-beta\.1/],
  ];
  for (const [name, mutate, expected] of cases) {
    await t.test(name, t => {
      const f = fixture(t);
      mutate(f);
      const result = f.run();
      assert.equal(result.code, 1, result.output);
      assert.match(result.output, expected);
    });
  }
});
