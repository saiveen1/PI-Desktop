// Preserve the installed application's identity; personal delivery is NSIS only.
const { build } = require("./package.json");

module.exports = {
  ...build,
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
