import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import rehypeRaw from "rehype-raw";
import { slotSsr } from "./helpers/slot-ssr.mjs";

const questions = [
  {
    question: "Which **deployment** target?",
    options: ["Web", "Desktop"],
  },
  {
    question: "Which platforms should be supported?",
    options: ["macOS", "Windows", "Linux"],
    multiSelect: true,
  },
  {
    question: "Should beta updates be enabled?",
    options: ["Yes", "No"],
  },
];

const message = {
  id: "asktool-history-1",
  role: "tool",
  content: "",
  createdAt: "2026-10-09T00:00:00.000Z",
  status: "complete",
  toolName: "asktool",
  toolCallId: "asktool-call-1",
  toolStatus: "success",
  toolArgs: { questions },
  toolResult: {
    content: [
      {
        type: "text",
        text: [
          "Which **deployment** target?：Desktop",
          "Which platforms should be supported?：macOS、Linux",
          "Should beta updates be enabled?：",
        ].join("\n---\n"),
      },
    ],
    details: { questions, answers: [["Desktop"], ["macOS", "Linux"], null] },
  },
};

test("completed asktool transcript rows show a readable Q&A summary", async (t) => {
  const ssr = await slotSsr(t, {
    translationOverrides: {
      askTool: {
        historyTitle: "Questions and answers",
        answerLabel: "Answer",
        skipped: "Skipped",
      },
    },
  });
  const { ToolRow } = await ssr.load("/src/features/chat/transcript/ToolRow.tsx");
  const { buildToolPresentation } = await ssr.load("/src/lib/tool-presentation.ts");
  const { ToolDetailBlocks } = await ssr.load("/src/components/ToolDetails.tsx");

  const row = ssr.render(createElement(ToolRow, { message }));
  assert.match(row, /Which \*\*deployment\*\* target\?/);
  assert.doesNotMatch(row, /questions|options/);

  const blocks = buildToolPresentation(message);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].kind, "asktool");
  assert.deepEqual(blocks[0].questions[1].answers, ["macOS", "Linux"]);
  assert.equal(blocks[0].questions[2].answers, null);
  const details = ssr.render(createElement(ToolDetailBlocks, { blocks }));
  assert.match(details, /tool-asktool-results/);
  assert.match(details, /Questions and answers/);
  assert.match(details, /Which <strong>deployment<\/strong> target\?/);
  assert.match(details, /Which platforms should be supported\?/);
  assert.match(details, /Should beta updates be enabled\?/);
  assert.equal((details.match(/class="tool-asktool-answer-value"/g) ?? []).length, 3);
  assert.match(details, /Answer/);
  assert.match(details, /Desktop/);
  assert.match(details, /Skipped/);
  assert.match(details, /tool-asktool-skipped/);
  assert.doesNotMatch(details, /"answers"|"questions"|<pre/);
});

test("asktool rows retain generic output when structured history is unavailable", async (t) => {
  const ssr = await slotSsr(t);
  const { buildToolPresentation } = await ssr.load("/src/lib/tool-presentation.ts");
  const legacy = buildToolPresentation({
    ...message,
    toolResult: "Which deployment target?：Desktop",
  });
  assert.ok(legacy.some((block) => block.kind === "code" && block.role === "output"));
  assert.ok(legacy.some((block) => block.role === "input"));

  const malformed = buildToolPresentation({
    ...message,
    toolResult: {
      content: [{ type: "text", text: "invalid" }],
      details: { questions: "invalid", answers: [] },
    },
  });
  assert.ok(malformed.length > 0);
  assert.notEqual(malformed[0].kind, "asktool");
});

// Read the SSR tree, not just the HTML text: collapsed process bodies are still mounted.
function* descendants(node, ancestors = []) {
  yield { node, ancestors };
  for (const child of node.children ?? []) yield* descendants(child, [...ancestors, node]);
}

test("a settled turn keeps its structured AskTool exchange visible in chronological order", async (t) => {
  const ssr = await slotSsr(t);
  const { AssistantTurn } = await ssr.load("/src/features/chat/transcript/AssistantTurn.tsx");
  const { buildTranscriptEntries } = await ssr.load("/src/lib/assistant-turns.ts");
  const { useAppStore } = await ssr.load("/src/stores/app-store.ts");
  const state = useAppStore.getInitialState(); // Snapshot read by Zustand during SSR.
  const settings = state.settings;
  t.after(() => { state.settings = settings; });
  const prose = (id, content) => ({ id, content, role: "assistant", status: "complete", createdAt: message.createdAt });
  const tool = (id, toolName, toolArgs) => ({ ...message, id, toolCallId: id, toolName, toolArgs, toolResult: "done" });
  const ask = { ...message, toolResult: { details: { questions, answers: [["Self-hosted tablet"], ["macOS", "Linux"], null] } } };
  const before = tool("before", "Read", { path: "before.md" });
  const legacy = { ...message, id: "legacy", toolCallId: "legacy", toolResult: "Recorded as plain text" };
  const failed = { ...message, id: "failed", toolCallId: "failed", toolStatus: "error", isError: true };
  const after = tool("after", "Bash", { command: "echo after" });
  const { entries } = buildTranscriptEntries([
    prose("intro", "Before the choice."), before, ask, legacy, failed, after, prose("final", "After the choice."),
  ]);
  const entry = entries.find((item) => item.kind === "assistant-turn");
  const hasClass = (node, name) => node.properties?.className?.includes(name);
  const hidden = ({ properties: p, tagName }) => p?.hidden || p?.inert || String(p?.ariaHidden) === "true" || (tagName === "details" && !p.open);
  for (const mode of ["flat", "command-first", "fully-folded"]) {
    await t.test(mode, () => {
      state.settings = { ...settings, transcriptDisplayMode: mode };
      const html = ssr.render(createElement(AssistantTurn, { entry, isActive: false }));
      const tree = rehypeRaw()({ type: "root", children: [{ type: "raw", value: html }] });
      const rows = [...descendants(tree)];
      const cards = rows.filter(({ node }) => hasClass(node, "ask-history-card"));
      assert.equal(cards.length, 1, "the settled turn has one Q&A card");
      const [card] = cards;
      assert.ok(![card.node, ...card.ancestors].some(hidden), "no disclosure hides the card");
      const cardText = [...descendants(card.node)]
        .filter(({ node, ancestors }) => node.type === "text" && !ancestors.some(hidden))
        .map(({ node }) => node.value).join("");
      assert.match(cardText, /Which deployment target\?.*Self-hosted tablet.*Which platforms should be supported\?.*macOS.*Linux.*Should beta updates be enabled\?.*Skipped/s);
      const row = (id) => rows.find(({ node }) => node.properties?.dataMessageId === id);
      assert.ok(row(before.id)?.ancestors.some(hidden), "ordinary activity is folded");
      for (const fallback of [legacy, failed]) {
        assert.ok(hasClass(row(fallback.id)?.node, "tool-row"), `${fallback.id} AskTool retains its ordinary tool row`);
      }
      const sequence = [row("intro"), row(before.id), card, row(legacy.id), row(failed.id), row(after.id), row("final")];
      const positions = sequence.map((item) => rows.indexOf(item));
      assert.ok(positions.every((value, i) => value >= 0 && (i === 0 || value > positions[i - 1])), "surrounding tools and prose remain in order");
      assert.ok(!rows.some(({ node }) => hasClass(node, "tool-row") && node.properties.dataMessageId === ask.id), "no duplicate AskTool row in folded activity");
    });
  }
});
