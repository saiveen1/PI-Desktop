import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { I18nextProvider } from "react-i18next";
import type { i18n } from "i18next";
import type { UiMessage } from "@pi-desktop/shared";
import { AssistantTurn } from "../../apps/desktop/src/features/chat/transcript/AssistantTurn";
import { SubagentTurnContent } from "../../apps/desktop/src/features/chat/transcript/SubagentTurnContent";
import { buildTranscriptEntries } from "../../apps/desktop/src/lib/assistant-turns";
import { useAppStore } from "../../apps/desktop/src/stores/app-store";

/** Check actual reading order and visibility, not just textContent in a hidden subtree. */
export function checkProgressProse(i18n: i18n) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const settings = useAppStore.getState().settings;
  const tail = '<｜DSML｜ parameter name="timeout" string="false">60</｜DSML｜ parameter>\n</｜DSML｜ calls>';
  const messages: UiMessage[] = ["Inspecting the input.", "one", `Checking the result.\n\n${tail}`, "two", "Finished."].map((content, i) => ({
    id: `step-${i}`, role: i % 2 ? "tool" : "assistant", content: i % 2 ? "" : content,
    createdAt: new Date(1_000 + i).toISOString(), status: "complete",
    ...(i % 2 ? { toolName: "Bash", toolStatus: "success" as const, toolCallId: `test-${i}`, toolArgs: { command: content } } : {}),
  }));
  const entry = buildTranscriptEntries(messages).entries[0];
  if (entry?.kind !== "assistant-turn") throw new Error("Missing fixture turn");
  const childRows = messages.map(message => ({ kind: message.role === "tool" ? "tool" as const : "answer" as const, message }));
  const check = (condition: unknown, description: string) => { if (!condition) throw new Error(description); };
  try {
    for (const mode of ["fully-folded", "command-first", "flat"] as const) {
      flushSync(() => useAppStore.setState({ settings: { ...useAppStore.getState().settings!, transcriptDisplayMode: mode } }));
      for (const child of [false, true]) {
        const key = `${mode}:${child}`;
        flushSync(() => root.render(<I18nextProvider key={key} i18n={i18n}>{child
          ? <SubagentTurnContent id={key} rows={childRows} active={false} />
          : <AssistantTurn entry={entry} isActive={false} />}</I18nextProvider>));
        const toggle = container.querySelector<HTMLButtonElement>(".turn-process > button");
        if (!toggle) throw new Error(`${key}: missing activity toggle`);
        for (const open of [false, true, false]) {
          if ((toggle.getAttribute("aria-expanded") === "true") !== open) flushSync(() => toggle.click());
          const paragraphs = [...container.querySelectorAll<HTMLElement>(".assistant-turn-fragment .prose-chat")];
          check(paragraphs.length === 3 && paragraphs.every(p => !p.closest('[hidden],[inert],[aria-hidden="true"]') && p.getBoundingClientRect().height > 0), `${key}: intermediate prose disappeared or was duplicated (open=${open})`);
          check(paragraphs.map(p => p.textContent).join("|") === "Inspecting the input.|Checking the result.|Finished.", `${key}: wrong prose order`);
          check(!container.querySelector<HTMLDetailsElement>(".dsml-protocol-details")?.open && !!container.querySelector(".dsml-protocol-details pre"), `${key}: missing or expanded protocol tail`);
          if (!open) check([...container.querySelectorAll<HTMLElement>(".tool-row")].every(r => !r.getBoundingClientRect().height), `${key}: leaked tool row`);
          if (open && !child && mode === "command-first") {
            const ordered = [...container.querySelectorAll<HTMLElement>("[data-message-id]")].map(el => el.dataset.messageId);
            check(messages.every((m, i) => ordered.indexOf(m.id) >= 0 && (!i || ordered.indexOf(messages[i - 1].id) < ordered.indexOf(m.id))), `${key}: command moved relative to its narration`);
          }
        }
      }
    }
    // The user can fold a live turn before further activity arrives.
    const renderLive = (rows: UiMessage[], active: boolean) => {
      const next = buildTranscriptEntries(rows).entries[0];
      if (next?.kind !== "assistant-turn") throw new Error("Missing live turn");
      flushSync(() => root.render(<I18nextProvider key="live" i18n={i18n}>
        <AssistantTurn entry={next} isActive={active} />
      </I18nextProvider>));
    };
    const live = messages.map(m => ({ ...m, id: `live-${m.id}` }));
    renderLive(live.slice(0, 3), true);
    const toggle = container.querySelector<HTMLButtonElement>(".turn-process > button");
    if (!toggle || toggle.getAttribute("aria-expanded") !== "true") throw new Error("Expected live activity open");
    flushSync(() => toggle.click());
    for (const [rows, active] of [[live.slice(0, 4), true], [live, false]] as const) {
      renderLive(rows, active);
      check(toggle.isConnected && toggle.getAttribute("aria-expanded") === "false", "Activity overrode manual collapse");
      for (const id of ["live-step-0", "live-step-2"]) {
        const bubble = container.querySelector<HTMLElement>(`.assistant-turn-fragment[data-message-id="${id}"]`);
        check(bubble && bubble.getBoundingClientRect().height > 0 && !bubble.closest("[hidden],[inert]"), "Narration disappeared after a later tool");
      }
    }
  } finally {
    flushSync(() => root.unmount());
    container.remove();
    useAppStore.setState({ settings });
  }
}
