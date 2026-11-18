import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { slotSsr } from "./helpers/slot-ssr.mjs";

test("context exclusions never hide old or newly generated thinking text", async t => {
  const ssr = await slotSsr(t);
  const { ThinkingRow } = await ssr.load("/src/features/chat/transcript/shared.tsx");
  for (const [id, excluded, streaming] of [["old", true, false], ["new", undefined, true], ["settled", undefined, false]]) {
    const message = { id, role: "assistant", content: "Answer", thinking: `Visible thinking ${id}`,
      status: streaming ? "streaming" : "complete", createdAt: "2026-11-18T00:00:00Z",
      ...(excluded ? { excludeThinkingFromContext: true } : {}),
    };
    const html = ssr.render(createElement(ThinkingRow, { message, streaming, autoOpen: true }));
    assert.match(html, /aria-expanded="true"/);
    assert.ok(html.includes(message.thinking));
  }
});
