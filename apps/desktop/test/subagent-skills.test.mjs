import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import { en } from "@pi-desktop/i18n/locales/en";

async function withEditor(run) {
  const server = await createServer({
    root: fileURLToPath(new URL("..", import.meta.url)), configFile: false,
    server: { middlewareMode: true, hmr: false, ws: false },
    esbuild: { jsx: "automatic" }, appType: "custom",
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  try {
    await run(await server.ssrLoadModule("/src/components/settings/SubagentEditorSheet.tsx"),
      await server.ssrLoadModule("/src/components/settings/SubagentSkillsField.tsx"));
  } finally { await server.close(); }
}

test("role editor preserves inherited, empty and selected skill grants on save/copy", async () => {
  await withEditor(async ({ emptySubagentDraft, draftFromRecord, draftFromDefinition, subagentDraftToInput, subagentDraftError }) => {
    const base = { id: "reader", name: "reader", description: "Read evidence", tools: ["Read"], enabled: true };
    assert.equal(emptySubagentDraft().skills, undefined);
    assert.equal(subagentDraftToInput(draftFromRecord(base, "Read.")).skills, null);
    for (const skills of [[], ["fixture/review", "missing"]]) {
      const record = { ...base, skills };
      const draft = draftFromRecord(record, "Read.");
      assert.deepEqual(draft.skills, skills);
      assert.notEqual(draft.skills, skills);
      assert.equal(subagentDraftError(draft), null);
      assert.deepEqual(subagentDraftToInput(draft).skills, skills);
      const copied = draftFromDefinition({ ...base, skills, prompt: "Read.", source: "user" });
      assert.deepEqual(subagentDraftToInput(copied).skills, skills);
      draft.skills = undefined;
      assert.equal(subagentDraftToInput(draft).skills, null);
    }
    const invalid = { ...draftFromRecord(base, "Read."), skills: ["bad id"] };
    assert.equal(subagentDraftError(invalid), "extensions.subagents.errorSkills");
  });
});

test("skill picker uses only existing skill commands and keeps unavailable saved IDs removable", async () => {
  await withEditor(async (_editor, { subagentSkillOptions, SubagentSkillsField }) => {
    const i18n = createInstance();
    await i18n.init({ lng: "en", resources: { en: { translation: en } } });
    const render = (value) => renderToStaticMarkup(createElement(I18nextProvider, { i18n },
      createElement(SubagentSkillsField, { value, onChange() {} })));
    const commands = [
      { name: "skill:fixture/review", kind: "skill", title: "Review", skillId: "fixture/review" },
      { name: "plugin-action", kind: "plugin", title: "Executable plugin" },
      { name: "template", kind: "template", title: "Template" },
    ];
    assert.deepEqual(subagentSkillOptions(commands, ["missing"]), [
      { value: "fixture/review", name: "Review", available: true },
      { value: "missing", name: "missing", available: false },
    ]);
    const inherited = render(undefined);
    assert.match(inherited, /Inherit all parent-available skills/);
    assert.match(inherited, /role="switch"[^>]*aria-checked="true"/);
    const empty = render([]);
    assert.match(empty, /role="switch"[^>]*aria-checked="false"/);
    assert.match(empty, /role="group"/);
  });
});
