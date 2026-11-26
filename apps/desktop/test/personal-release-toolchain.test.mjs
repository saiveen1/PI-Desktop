import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { resolvePersonalReleaseToolchain } from "../../../scripts/build-personal-release.mjs";

const desktopRequire = createRequire(new URL("../package.json", import.meta.url));

test("personal toolchain uses Desktop's executables and the installed packager's ASAR", () => {
  const { builder, vite, asar } = resolvePersonalReleaseToolchain();
  for (const [name, entry] of [["electron-builder", builder], ["electron-vite", vite]]) {
    const manifest = desktopRequire.resolve(`${name}/package.json`);
    assert.equal(entry, realpathSync(join(dirname(manifest), desktopRequire(manifest).bin[name])));
  }
  const builderRequire = createRequire(builder);
  const packagerRequire = createRequire(builderRequire.resolve("app-builder-lib"));
  assert.strictEqual(asar, packagerRequire("@electron/asar"));
});

test("personal toolchain refuses a builder resolved outside the selected checkout", (t) => {
  const temp = mkdtempSync(join(tmpdir(), "pi-release-toolchain-"));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const root = join(temp, "repo");
  const manifest = join(temp, "node_modules/electron-builder/package.json");
  mkdirSync(join(root, "apps/desktop"), { recursive: true });
  mkdirSync(dirname(manifest), { recursive: true });
  writeFileSync(manifest, "{}");
  assert.throws(() => resolvePersonalReleaseToolchain(root), /toolchain must belong to the current checkout/);
});
