import { createRequire } from "node:module";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const dependencies = process.env.E2E_DEPENDENCY_ROOT || root;
const desktopModules = join(dependencies, "apps/desktop/node_modules");
const { build } = createRequire(join(dependencies, "packages/agent-runtime/package.json"))("esbuild");
export async function buildHistoryFixture(directory, fixture = "delegation-history.jsx") {
  await mkdir(directory, { recursive: true });
  await build({ entryPoints: [join(root, "apps/desktop/test/fixtures", fixture)], outfile: join(directory, "renderer.js"), bundle: true, platform: "browser", format: "esm", jsx: "automatic", loader: { ".png": "dataurl", ".svg": "dataurl", ".woff": "dataurl", ".woff2": "dataurl", ".ttf": "dataurl" }, define: { "process.env.NODE_ENV": '"production"', "import.meta.env.DEV": "false" }, alias: { "@pi-desktop/i18n": join(root, "packages/i18n/src"), "@pi-desktop/plugin-sdk": join(root, "packages/plugin-sdk/src"), "@pi-desktop/shared": join(root, "packages/shared/src"), react: join(desktopModules, "react"), "react-dom": join(desktopModules, "react-dom"), i18next: join(desktopModules, "i18next"), "react-i18next": join(desktopModules, "react-i18next") }, nodePaths: [desktopModules, join(dependencies, "packages/shared/node_modules")] });
  await writeFile(join(directory, "renderer.css"), (await readFile(join(directory, "renderer.css"), "utf8")).replace(/@theme(?: inline)?\s*\{/g, ":root {"));
  await writeFile(join(directory, "index.html"), await readFile(join(root, "apps/desktop/test/fixtures/delegation-approval.html")));
}
