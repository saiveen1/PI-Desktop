import assert from "node:assert/strict";
import test from "node:test";
import {
  isModelsDevProviderCatalog,
  resolveReleaseDocumentCheck,
} from "./release-version-check.mjs";

test("checks a stable release against one aligned version", () => {
  assert.deepEqual(resolveReleaseDocumentCheck("0.15.2", "0.15.2"), {
    documentVersion: "0.15.2",
    surfaceVersion: "0.15.2",
    isPrereleasePreview: false,
  });
});

test("checks a prerelease preview against its stable documentation version", () => {
  assert.deepEqual(resolveReleaseDocumentCheck("0.15.2-beta.2", "0.15.2"), {
    documentVersion: "0.15.2",
    surfaceVersion: "0.15.2-beta.2",
    isPrereleasePreview: true,
  });
});

test("does not hide a mismatched requested version", () => {
  assert.deepEqual(resolveReleaseDocumentCheck("0.15.2-beta.2", "0.15.1"), {
    documentVersion: "0.15.1",
    surfaceVersion: "0.15.1",
    isPrereleasePreview: false,
  });
});

test("a personal beta checks the latest compatible stable catalog without changing source versions", () => {
  for (const stable of ["0.23.0", "0.23.1"]) {
    assert.deepEqual(resolveReleaseDocumentCheck("0.23.1-beta.1", undefined, ["0.24.0", "0.23.2", stable]), {
      documentVersion: stable,
      surfaceVersion: "0.23.1-beta.1",
      isPrereleasePreview: false,
    });
  }
});

test("automatic beta checking cannot use a future, unrelated, missing or prerelease catalog", () => {
  for (const stable of ["0.23.2", "0.24.0", "0.22.0", "1.23.0", "0.23.0-beta.1", "invalid", undefined]) {
    assert.deepEqual(resolveReleaseDocumentCheck("0.23.1-beta.1", undefined, [stable].filter(Boolean)), {
      documentVersion: "0.23.1-beta.1",
      surfaceVersion: "0.23.1-beta.1",
      isPrereleasePreview: false,
    });
  }
});

test("stable releases and explicit requests never fall back to the inherited catalog", () => {
  assert.deepEqual(resolveReleaseDocumentCheck("0.23.1", undefined, ["0.23.0"]), {
    documentVersion: "0.23.1", surfaceVersion: "0.23.1", isPrereleasePreview: false,
  });
  assert.deepEqual(resolveReleaseDocumentCheck("0.23.1-beta.1", "0.23.0", ["0.23.0"]), {
    documentVersion: "0.23.0", surfaceVersion: "0.23.0", isPrereleasePreview: false,
  });
  assert.deepEqual(resolveReleaseDocumentCheck("0.23.1-beta.1", "0.23.1", ["0.23.0"]), {
    documentVersion: "0.23.1", surfaceVersion: "0.23.1-beta.1", isPrereleasePreview: true,
  });
  assert.deepEqual(resolveReleaseDocumentCheck("0.23.1-rc.1", undefined, ["0.23.0"]), {
    documentVersion: "0.23.1-rc.1", surfaceVersion: "0.23.1-rc.1", isPrereleasePreview: false,
  });
});

test("accepts a models.dev provider catalog with model records", () => {
  assert.equal(isModelsDevProviderCatalog({ provider: { models: { model: {} } } }), true);
});

test("rejects invalid or empty models.dev catalogs", () => {
  for (const value of [null, [], {}, { provider: {} }, { provider: null }]) {
    assert.equal(isModelsDevProviderCatalog(value), false);
  }
});
