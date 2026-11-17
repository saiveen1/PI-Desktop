import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { I18nextProvider } from "react-i18next";
import type { i18n } from "i18next";
import type { UiMessage } from "@pi-desktop/shared";
import { AssistantTurn } from "../../apps/desktop/src/features/chat/transcript/AssistantTurn";
import { SubagentTurnContent } from "../../apps/desktop/src/features/chat/transcript/SubagentTurnContent";
import { buildTranscriptEntries } from "../../apps/desktop/src/lib/assistant-turns";
import { useAppStore } from "../../apps/desktop/src/stores/app-store";

/** Protocol details belong to the affected bubble, never to the turn's folding policy. */
export function checkProgressProse(i18n: i18n) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const settings = useAppStore.getState().settings;
  const tail = '<｜DSML｜ parameter name="timeout" string="false">60</｜DSML｜ parameter>\n</｜DSML｜ calls>';
  try {
    for (const mode of ["fully-folded", "command-first", "flat"] as const) {
      flushSync(() => useAppStore.setState({ settings: { ...settings!, transcriptDisplayMode: mode } }));
      for (const child of [false, true]) for (const suffix of ["", `\n\n${tail}`]) {
        const key = `${mode}:${child}:${Boolean(suffix)}`;
        const rows: UiMessage[] = ["Checking.", "one", `Found it.${suffix}`, "two", "Done."].map((content, i) => ({
          id: `step-${i}`, role: i % 2 ? "tool" : "assistant", content: i % 2 ? "" : content,
          status: "complete", createdAt: new Date(1000 + i).toISOString(),
          ...(i % 2 ? { toolName: "Bash", toolStatus: "success" as const, toolCallId: `call-${i}`, toolArgs: { command: content } } : {}),
        }));
        const entry = buildTranscriptEntries(rows).entries[0];
        if (entry?.kind !== "assistant-turn") throw new Error("Missing fixture turn");
        const childRows = rows.map(message => ({ kind: message.role === "tool" ? "tool" as const : "answer" as const, message }));
        const render = (active: boolean) => flushSync(() => root.render(<I18nextProvider key={key} i18n={i18n}>{child
          ? <SubagentTurnContent id={key} rows={childRows} active={active} />
          : <AssistantTurn entry={entry} isActive={active} />}</I18nextProvider>));
        const check = (open: boolean) => {
          const toggle = host.querySelector<HTMLButtonElement>(".turn-process > button");
          if (toggle?.getAttribute("aria-expanded") !== String(open)) throw new Error(`${key}: wrong process state`);
          const visible = [...host.querySelectorAll<HTMLElement>("[data-message-id]")]
            .filter(el => el.getBoundingClientRect().height > 0 && !el.closest("[hidden],[inert]"));
          const expected = open ? "step-0,step-1,step-2,step-3,step-4" : "step-4";
          const ids = visible.map(el => el.dataset.messageId).join(",");
          if (ids !== expected) throw new Error(`${key}: expected ${expected}; saw ${ids}`);
          const details = host.querySelector<HTMLDetailsElement>(".dsml-protocol-details");
          if (Boolean(details) !== Boolean(suffix) || details?.open) throw new Error(`${key}: wrong protocol disclosure`);
          if (open && suffix && (details?.querySelector("pre")?.textContent !== tail ||
            visible[2].querySelector(".prose-chat")?.textContent !== "Found it.")) throw new Error(`${key}: altered answer or tail`);
          return toggle;
        };
        render(true);
        check(true);
        render(false);
        const toggle = check(false);
        flushSync(() => toggle.click());
        check(true);
        flushSync(() => toggle.click());
        check(false);
        // Start the next case with a fresh turn and no retained manual choice.
        flushSync(() => root.render(null));
      }
    }
  } finally {
    flushSync(() => root.unmount());
    host.remove();
    useAppStore.setState({ settings });
  }
}
