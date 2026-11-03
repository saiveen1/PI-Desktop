// Preserve the installed application's identity; personal delivery is NSIS only.
const { build } = require("./package.json");

module.exports = {
  ...build,
  directories: { ...build.directories, output: "release/personal/.build" },
  extraMetadata: { ...build.extraMetadata, piSelfManaged: true, piDistribution: "installed" },
  win: { ...build.win, target: [{ target: "nsis", arch: ["x64"] }] },
  nsis: {
    ...build.nsis,
    artifactName: "PI-Desktop-Personal-Setup-${version}.${ext}",
    runAfterFinish: false,
  },
};
