import { createRequire } from "node:module";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const { build } = createRequire(join(root, "packages/agent-runtime/package.json"))("esbuild");
export async function buildHistoryFixture(directory) {
  await mkdir(directory, { recursive: true });
  await build({ entryPoints: [join(root, "apps/desktop/test/fixtures/delegation-history.jsx")], outfile: join(directory, "renderer.js"), bundle: true, platform: "browser", format: "esm", jsx: "automatic", loader: { ".png": "dataurl", ".svg": "dataurl" }, define: { "process.env.NODE_ENV": '"production"', "import.meta.env.DEV": "false" }, alias: { "@pi-desktop/i18n": join(root, "packages/i18n/src"), "@pi-desktop/shared": join(root, "packages/shared/src"), react: join(root, "apps/desktop/node_modules/react"), "react-dom": join(root, "apps/desktop/node_modules/react-dom"), i18next: join(root, "apps/desktop/node_modules/i18next"), "react-i18next": join(root, "apps/desktop/node_modules/react-i18next") }, nodePaths: [join(root, "apps/desktop/node_modules")] });
  await writeFile(join(directory, "renderer.css"), (await readFile(join(directory, "renderer.css"), "utf8")).replace(/@theme(?: inline)?\s*\{/g, ":root {"));
  await writeFile(join(directory, "index.html"), await readFile(join(root, "apps/desktop/test/fixtures/delegation-approval.html")));
}
