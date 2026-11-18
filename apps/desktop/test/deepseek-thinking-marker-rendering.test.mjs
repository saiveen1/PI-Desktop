import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { slotSsr } from "./helpers/slot-ssr.mjs";

const marker = "<｜end▁of▁thinking｜>";
const burst = marker.repeat(10);
const visible = /&lt;｜end▁of▁thinking｜&gt;/g;

test("live and restored DeepSeek answers hide bare delimiters, not literal examples or surrounding prose", async (t) => {
  const ssr = await slotSsr(t);
  const { AssistantTurnParts } = await ssr.load("/src/features/chat/transcript/AssistantTurnParts.tsx");
  const { MessageRow } = await ssr.load("/src/features/chat/transcript/MessageRow.tsx");
  const render = (message) => ssr.render(createElement(AssistantTurnParts, {
    parts: [{ kind: "message", message }], isActive: message.status === "streaming",
    turnDelegationStatuses: new Map(), turnDelegationTimings: new Map(),
  }));
  const answer = { id: "answer", createdAt: "2026-01-01T00:00:00Z", role: "assistant",
    modelId: "deepseek-ai/DeepSeek-V3.2", content: `Before.\n\n${burst}**After.**` };
  const replay = Object.freeze({ version: 1, blocks: [Object.freeze({ type: "text", length: answer.content.length })] });
  for (const status of ["streaming", "complete"]) {
    const html = render(Object.freeze({ ...answer, status, thinking: "Separate reasoning", providerReplay: replay }));
    assert.equal(html.match(visible)?.length ?? 0, 0, `${status} leaked protocol tokens`);
    assert.match(html, /Before\./);
    assert.match(html, /<strong[^>]*>After\.<\/strong>/);
    assert.doesNotMatch(html, /Separate reasoning/);
  }
  const incident = ["<thinking> </thinking>", "<thinking> </thinking>", "Opening.", `${marker}One.`,
    `${marker}Two.`, marker.repeat(2), `${marker}Three.`, marker.repeat(4), "", "Final sentence.", marker].join("\n");
  for (const status of ["streaming", "complete"]) {
    const html = render({ ...answer, modelId: "deepseek-v4.1-flash", content: incident, status });
    assert.doesNotMatch(html, /end▁of▁thinking/);
    assert.match(html, /Opening\./);
    assert.match(html, /Final sentence\./);
  }
  const interleaved = render({ ...answer, content: `${marker}First.\n\nMiddle${marker} sentence.\n\n${marker}Last.` });
  assert.doesNotMatch(interleaved, /end▁of▁thinking/);
  assert.match(interleaved, /Middle sentence\./);
  assert.equal(render({ ...answer, content: `One literal: ${marker}` }).match(visible)?.length, 1);
  assert.equal(render({ ...answer, status: "streaming", content: `Quoted: “${burst}` }).match(visible)?.length, 10);
  const content = [`Answer${burst}`, `\`${burst}\``, `\`\`\`text\n${burst}\n\`\`\``, `    ${burst}`,
    `> ${burst}`, `Quoted: “${burst}”`, `Quoted: "${burst}"`, "<｜other｜>", "<｜end_of_thinking｜>"].join("\n\n");
  const html = render({ ...answer, modelId: "router", responseModelId: "deepseek-r1", content });
  assert.equal(html.match(visible)?.length, 60);
  assert.match(html, /｜other｜/);
  assert.match(html, /｜end_of_thinking｜/);
  for (const metadata of [{ modelId: "gpt-5" }, { modelId: "deepseek-ai/other" }, { modelId: undefined }, { responseModelId: "gpt-5" }]) {
    assert.equal(render({ ...answer, ...metadata }).match(visible)?.length, 10);
  }
  const user = ssr.render(createElement(MessageRow, { message: { ...answer, role: "user" }, isRunning: false }));
  assert.equal(user.match(visible)?.length, 10);
});
