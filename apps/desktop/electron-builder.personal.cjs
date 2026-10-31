// Keep the daily installation identity; only local artifacts opt out of updates.
const { build } = require("./package.json");

module.exports = {
  ...build,
  directories: {
    ...build.directories,
    output: "release/personal",
  },
  extraMetadata: {
    ...build.extraMetadata,
    piSelfManaged: true,
  },
};
