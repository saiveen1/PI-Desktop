// Preserve the installed application's identity; personal delivery is NSIS only.
const { build } = require("./package.json");
const { rm } = require("node:fs/promises");
const { join } = require("node:path");
const { version: electronVersion } = require("./node_modules/electron/package.json");

module.exports = {
  ...build,
  electronVersion,
  // Copy the installed runtime without the Windows archive-directory rename.
  electronDist: join(__dirname, "node_modules/electron/dist"),
  async afterPack({ appOutDir }) {
    // Custom distributions skip electron-builder's default runtime cleanup.
    await rm(join(appOutDir, "resources/default_app.asar"), { force: true });
    await rm(join(appOutDir, "version"), { force: true });
  },
  directories: { ...build.directories, output: "release/personal/.build" },
  extraMetadata: {
    ...build.extraMetadata,
    piSelfManaged: true,
    piDistribution: "installed",
    ...(process.env.PI_PERSONAL_BUILD_ID ? { piBuildId: process.env.PI_PERSONAL_BUILD_ID } : {}),
    ...(process.env.PI_PERSONAL_SOURCE_COMMIT ? { piSourceCommit: process.env.PI_PERSONAL_SOURCE_COMMIT } : {}),
  },
  win: { ...build.win, target: [{ target: "nsis", arch: ["x64"] }] },
  nsis: {
    ...build.nsis,
    artifactName: "PI-Desktop-Personal-Setup-${version}.${ext}",
    runAfterFinish: false,
  },
};
