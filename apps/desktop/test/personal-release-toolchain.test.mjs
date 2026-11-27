import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readlinkSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { resolvePersonalReleaseToolchain } from "../../../scripts/build-personal-release.mjs";

const desktopRequire = createRequire(new URL("../package.json", import.meta.url));

test("personal toolchain uses Desktop's executables and the installed packager's ASAR", () => {
  const { builder, vite, asar, viteElectron } = resolvePersonalReleaseToolchain();
  for (const [name, entry] of [["electron-builder", builder], ["electron-vite", vite]]) {
    const manifest = desktopRequire.resolve(`${name}/package.json`);
    assert.equal(entry, realpathSync(join(dirname(manifest), desktopRequire(manifest).bin[name])));
  }
  assert.equal(viteElectron, realpathSync(createRequire(vite).resolve("electron/package.json")));
  const builderRequire = createRequire(builder);
  const packagerRequire = createRequire(builderRequire.resolve("app-builder-lib"));
  assert.strictEqual(asar, packagerRequire("@electron/asar"));
});

test("Windows personal NSIS never runs its uninstaller generator from the final installer path", { skip: process.platform !== "win32" }, async () => {
  const builderRequire = createRequire(desktopRequire.resolve("electron-builder/package.json"));
  builderRequire("app-builder-lib"); // Initialize the packager before its NSIS target.
  const { NsisTarget } = builderRequire("app-builder-lib/out/targets/nsis/NsisTarget.js");
  const outDir = join(tmpdir(), "personal NSIS staging");
  const installer = join(outDir, "Setup.exe");
  for (const personal of [true, false]) {
    const finalCommands = { OutFile: `"${installer}"` };
    const stop = new Error("stop before native compilation");
    const target = {
      outDir, options: {},
      packager: { config: { extraMetadata: { piSelfManaged: personal } }, getResource: async () => null },
      computeFinalScript: async (script) => script,
      executeMakensis(defines, commands) {
        assert.equal(defines.UNINSTALLER_OUT_FILE, join(outDir, "Setup.__uninstaller.exe"));
        assert.equal(commands.OutFile, personal ? `"${join(outDir, "Setup.__generator.exe")}"` : finalCommands.OutFile);
        throw stop;
      },
    };
    await assert.rejects(NsisTarget.prototype.computeScriptAndSignUninstaller.call(target, {}, finalCommands, installer, "", new Map()), (error) => error === stop);
    assert.equal(finalCommands.OutFile, `"${installer}"`);
  }
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

test("personal toolchain identifies Vite's stale Electron link even when Desktop can resolve Electron", (t) => {
  const temp = realpathSync(mkdtempSync(join(tmpdir(), "pi-moved-toolchain-")));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const root = join(temp, "current");
  const desktop = join(root, "apps/desktop");
  const pkg = (dir, manifest, entry) => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "package.json"), JSON.stringify(manifest));
    if (entry) writeFileSync(join(dir, entry), "");
  };
  pkg(join(desktop, "node_modules/electron"), { version: "43.6.0" });
  for (const name of ["electron-builder", "electron-vite"]) {
    pkg(join(root, "node_modules", name), { bin: { [name]: "cli.js" } }, "cli.js");
  }
  const electron = join(root, "node_modules/electron");
  const oldTarget = join(temp, "moved-away", "node_modules/electron");
  symlinkSync(oldTarget, electron, "junction");
  try {
    assert.throws(() => resolvePersonalReleaseToolchain(root), (error) => {
      assert.match(error.message, /electron-vite cannot resolve electron\/package\.json/);
      assert.ok(error.message.includes(`${electron} -> ${oldTarget}`), error.message);
      assert.match(error.message, /pnpm install --frozen-lockfile/);
      assert.equal(error.cause?.code, "MODULE_NOT_FOUND");
      return true;
    });
    assert.equal(readlinkSync(electron), oldTarget, "preflight must not repair or remove the link");
  } finally {
    unlinkSync(electron);
  }
  pkg(electron, { version: "42.0.0" });
  assert.throws(() => resolvePersonalReleaseToolchain(root), /resolve different Electron versions/);
});
