import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

const desktop = fileURLToPath(new URL("../", import.meta.url));
const require = createRequire(new URL("../package.json", import.meta.url));
const runtimeRequire = createRequire(new URL("../../../packages/agent-runtime/package.json", import.meta.url));
const { resolveConfig } = await import(pathToFileURL(require.resolve("electron-vite")).href);
const { build } = await import(pathToFileURL(require.resolve("vite")).href);
const photonEntry = runtimeRequire.resolve("@silvia-odwyer/photon-node");

for (const shared of [false, true]) {
  test(`Main image decoder loads standalone with WASM beside its ${shared ? "shared chunk" : "entry"}`, async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "pi-main-wasm-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const entry = join(directory, "entry.mjs");
    await writeFile(entry, `
      import photon from ${JSON.stringify(photonEntry.replaceAll("\\", "/"))};
      export function dimensions(bytes) {
        const image = photon.PhotonImage.new_from_byteslice(bytes);
        try { return [image.get_width(), image.get_height()]; }
        finally { image.free(); }
      }
    `);
    const { config } = await resolveConfig({ root: desktop, logLevel: "silent" }, "build", "production");
    const result = await build({
      ...config.main,
      build: {
        ...config.main.build,
        outDir: join(directory, "out"),
        rollupOptions: {
          ...config.main.build.rollupOptions,
          input: { probe: entry },
          output: {
            format: "es", entryFileNames: "[name].mjs", chunkFileNames: "chunks/[name]-[hash].mjs",
            manualChunks: shared ? { decoder: [photonEntry] } : undefined,
          },
        },
      },
    });
    const outputs = (Array.isArray(result) ? result : [result]).flatMap((output) => output.output);
    const decoderChunk = outputs.find((output) => output.type === "chunk" && output.code.includes("photon_rs_bg.wasm"));
    assert.ok(decoderChunk, "exercise the real bundled decoder loader");
    assert.equal(decoderChunk.fileName.startsWith("chunks/"), shared);
    const wasmPath = join(directory, "out", dirname(decoderChunk.fileName), "photon_rs_bg.wasm");
    assert.deepEqual(await readFile(wasmPath), await readFile(join(dirname(photonEntry), "photon_rs_bg.wasm")));
    await writeFile(join(directory, "exercise.mjs"), `
      import assert from "node:assert/strict";
      import { dimensions } from "./out/probe.mjs";
      const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAEElEQVR4AQEFAPr/AP8AAP8FAAH/+lyI0QAAAABJRU5ErkJggg==", "base64");
      assert.deepEqual(dimensions(png), [1, 1]);
      console.log("standalone decoder passed");
    `);
    const { stdout } = await promisify(execFile)(process.execPath, ["exercise.mjs"], {
      cwd: directory,
      env: { PATH: process.env.PATH, NODE_PATH: "" },
      timeout: 30_000,
    });
    assert.equal(stdout.trim(), "standalone decoder passed");
  });
}
