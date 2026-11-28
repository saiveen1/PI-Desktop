import assert from "node:assert/strict";
import test from "node:test";
import { readWindowsElevation } from "../electron/main/windows-elevation.ts";

test("only a high-integrity Windows main process sets the display hint", () => {
  for (const level of ["high", "medium", "low", "untrusted", "unknown", undefined]) {
    const metrics = [{ pid: 20, integrityLevel: "high" }, { pid: 10, integrityLevel: level }];
    assert.equal(readWindowsElevation("win32", 10, () => metrics, assert.fail), level === "high");
  }
  assert.equal(readWindowsElevation("win32", 10, () => [], assert.fail), false);
  for (const platform of ["linux", "darwin"]) {
    assert.equal(readWindowsElevation(platform, 10, assert.fail, assert.fail), false);
  }
});

test("an unavailable metrics provider cannot prevent the window opening", () => {
  const failure = new Error("metrics unavailable");
  const errors = [];
  assert.equal(readWindowsElevation("win32", 10, () => { throw failure; }, e => errors.push(e)), false);
  assert.deepEqual(errors, [failure]);
});
