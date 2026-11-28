import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { build } from "esbuild";
import { repositoryRoot, resolveElectronBinary } from "../../../scripts/e2e/boot.mjs";

const fixture = `
import React from 'react';
import {createRoot} from 'react-dom/client';
import {flushSync} from 'react-dom';
import i18n from 'i18next';
import {initReactI18next} from 'react-i18next';
import {catalogs} from '../../../packages/i18n/src/index';
import {SidebarAdminBadge} from './components/SidebarAdminBadge';
window.probe = async () => {
  const check = (ok, message) => { if (!ok) throw Error(message); };
  const resources = Object.fromEntries(Object.entries(catalogs).map(([id, translation]) => [id, {translation}]));
  await i18n.use(initReactI18next).init({lng:'en', resources, interpolation:{escapeValue:false}});
  const root = createRoot(document.getElementById('root'));
  const render = (value) => { window.piDesktop = value; flushSync(() => root.render(<SidebarAdminBadge />)); };
  for (const value of [undefined, {platform:'win32'}, {platform:'win32',windowsElevated:false}, {platform:'linux',windowsElevated:true}, {platform:'darwin',windowsElevated:true}]) {
    render(value); check(!document.querySelector('.sidebar-admin-badge'), 'unexpected badge for '+JSON.stringify(value));
  }
  render({platform:'win32',windowsElevated:true});
  const badge = document.querySelector('.sidebar-admin-badge');
  check(badge && badge.textContent === 'Admin' && badge.tabIndex === 0 && badge.classList.contains('no-drag'), 'badge or keyboard/no-drag trigger missing');
  let stage = 'hover';
  const until = async fn => { const end = performance.now()+2500; while(!fn()) { if(performance.now()>end) throw Error('tooltip timed out: '+stage+'; visible='+document.visibilityState+'; focus='+document.activeElement?.outerHTML); await new Promise(requestAnimationFrame); } };
  badge.dispatchEvent(new PointerEvent('pointerover',{bubbles:true}));
  await until(() => document.querySelector('[role=tooltip]'));
  check(document.querySelector('[role=tooltip]').textContent === catalogs.en.sidebarAdmin.tooltip && document.querySelector('[role=tooltip]').classList.contains('ui-tooltip-help'), 'hover tooltip');
  stage = 'hover leave'; badge.dispatchEvent(new PointerEvent('pointerout',{bubbles:true}));
  await until(() => !document.querySelector('[role=tooltip]'));
  stage = 'focus'; badge.focus(); badge.dispatchEvent(new FocusEvent('focusin',{bubbles:true})); await until(() => document.querySelector('[role=tooltip]'));
  check(document.querySelector('[role=tooltip]').textContent === catalogs.en.sidebarAdmin.tooltip, 'focus tooltip');
  stage = 'blur'; badge.blur(); badge.dispatchEvent(new FocusEvent('focusout',{bubbles:true})); await until(() => !document.querySelector('[role=tooltip]'));
  for (const [id, catalog] of Object.entries(catalogs)) {
    check(catalog.sidebarAdmin.label === 'Admin' && catalog.sidebarAdmin.tooltip && (id === 'en' || catalog.sidebarAdmin.tooltip !== catalogs.en.sidebarAdmin.tooltip), 'missing translation: '+id);
    await i18n.changeLanguage(id);
    check(badge.textContent === 'Admin', 'label: '+id);
    stage = 'locale focus '+id; badge.focus(); badge.dispatchEvent(new FocusEvent('focusin',{bubbles:true})); await until(() => document.querySelector('[role=tooltip]'));
    check(document.querySelector('[role=tooltip]').textContent === catalog.sidebarAdmin.tooltip, 'localized tooltip: '+id);
    stage = 'locale blur '+id; badge.blur(); badge.dispatchEvent(new FocusEvent('focusout',{bubbles:true})); await until(() => !document.querySelector('[role=tooltip]'));
  }
  root.unmount(); return true;
};`;

test("admin badge visibility, hover, focus, and every supported locale", { skip: process.platform === "linux" && !process.env.DISPLAY }, async () => {
  const root = repositoryRoot();
  const scratch = process.env.PI_SCRATCH_DIR || tmpdir();
  const temp = await mkdtemp(join(scratch, "sidebar-admin-"));
  try {
    const sidebar = await readFile(join(root, "apps/desktop/src/components/Sidebar.tsx"), "utf8");
    assert.match(sidebar, /<span>\{t\("app\.shellName"\)\}<\/span>\s*<\/TooltipButton>\s*<SidebarAdminBadge\s*\/>/);
    await build({ stdin: { contents: fixture, resolveDir: join(root, "apps/desktop/src"), loader: "tsx" }, bundle: true, jsx: "automatic", format: "esm", outfile: join(temp, "fixture.js"), define: { "process.env.NODE_ENV": '"production"' } });
    await writeFile(join(temp, "index.html"), '<meta charset="utf-8"><div id="root"></div><script type="module" src="fixture.js"></script>');
    await writeFile(join(temp, "main.cjs"), `const {app,BrowserWindow}=require('electron'); const path=require('node:path'); app.setPath('userData',path.join(__dirname,'profile')); app.whenReady().then(async()=>{const w=new BrowserWindow({show:false,webPreferences:{backgroundThrottling:false}}); await w.loadFile(path.join(__dirname,'index.html')); await w.webContents.executeJavaScript('window.probe()'); console.log('PASS sidebar-admin'); app.exit(0)}).catch(e=>{console.error(e);app.exit(1)});`);
    const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
    const { stdout } = await promisify(execFile)(resolveElectronBinary(root).electronBinary, [join(temp, "main.cjs")], { env, timeout: 25000 });
    assert.match(stdout, /PASS sidebar-admin/);
  } finally { await rm(temp, { recursive: true, force: true, maxRetries: 5 }); }
});
