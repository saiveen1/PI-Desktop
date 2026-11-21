import { resolve } from "node:path";
import { run } from "node:test";
import { spec } from "node:test/reporters";

// Existing test cases, not implementation files or snapshots. Review changes to
// this list against the pre-merge personal revision (delivery workflow R4).
export const protectedCases = {
  "apps/desktop/test/transcript-history-demand.test.mjs": [
    "Edit context previews and saves only the latest turn’s model overlays",
  ],
  "apps/desktop/test/app-shell-settings-accessibility.test.mjs": [
    "Settings is a page outside the hidden, inert workspace and its portals",
    "the Settings route renders its search and Return to app as page controls",
  ],
};

if (import.meta.main) {
  const files = Object.keys(protectedCases);
  if (!files.length || files.some(file => !protectedCases[file].length)) {
    throw new Error("No protected test cases registered for the personal merge gate");
  }
  const pending = new Map(files.map(file => [resolve(file), new Set(protectedCases[file])]));
  const tests = run({ files });
  tests.on("test:fail", () => { process.exitCode = 1; });
  tests.on("test:pass", data => {
    // node:test also emits pass events for skipped/TODO tests and empty files.
    if (data.file && data.details.type === "test" && data.skip == null && data.todo == null) {
      pending.get(resolve(data.file))?.delete(data.name);
    }
  });
  for await (const line of tests.compose(spec)) process.stdout.write(line);
  for (const [file, names] of pending) {
    for (const name of names) {
      console.error(`Protected test did not run and pass: ${file}: ${name}`);
      process.exitCode = 1;
    }
  }
}
