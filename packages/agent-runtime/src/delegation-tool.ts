import { Type } from "typebox";
import { DELEGATION_CONTEXT_WINDOW_MAX, describeDelegationRunPolicy, resolveDelegationRunPolicy, subagentToolsLabel, type DelegationSettings, type SubagentDefinition } from "@pi-desktop/shared";

/** Stable tool metadata is supplied on every request, including after compaction. */
export function subagentTaskDeclaration(options: {
  definitions: SubagentDefinition[];
  hasOverrides: boolean;
  defaultGuidance: string;
  optInGuidance: string;
  settings?: DelegationSettings;
  selectionMode?: "task-fit";
}) {
  const { definitions, settings } = options;
  const catalog = definitions.map((definition) => {
    return `- ${definition.name} (tools: ${subagentToolsLabel(definition)}): ${definition.description}`;
  }).join("\n");
  return {
    name: "Task",
    label: "Task",
    description: [
      describeDelegationRunPolicy(resolveDelegationRunPolicy(settings?.runPolicy)),
      "Start one subagent in the background and return immediately; you keep working while it runs, then converge with TaskWait when you need its report.\n\nPrefer doing the work yourself. Only delegate when it saves significant context or enables genuine parallelism — not for tasks you can finish in a few tool calls.",
      "Use it only when the work is genuinely separable and substantial: parallel exploration of independent directions that each need many tool calls (one Task per direction in the same assistant message), a large multi-file implementation with a complete spec (fixer), an adversarial read-only review of a non-trivial change you already finished (code-reviewer), or a wide search whose raw output would fill this context (explorer, test-runner). A single file lookup or a small edit does not warrant delegation.",
      "Do not delegate what you can finish in a couple of tool calls, and do not delegate anything that needs the user — a subagent cannot ask a question or propose a plan on your behalf.",
      "When preparing delegation, call TaskModels to inspect the current conversation's model descriptions. Reuse a query for the same batch, and refresh after configuration changes. Model descriptions are selection hints, never permission.",
      options.selectionMode === "task-fit"
        ? "This conversation uses a custom pool. For every new task, match the model description to the task, then supply model and a concise modelReason. Priority is only a tie-breaker or fallback. Resume preserves its recorded binding subject to the current pool."
        : "Omit model to retain configured role/session defaults, or choose an available model from TaskModels. Supply a short modelReason for an intentional specialist choice.",
      "`task` is the delegate's only instruction. It cannot see this conversation, and you cannot correct it while it runs, so state the goal, the paths and facts it cannot infer, and exactly what to report back.",
      "To run delegates concurrently, emit several Task calls in one assistant message. A message that mixes Task with any other tool runs one call at a time. You may keep working or talk to the user while they run; the runtime delivers their reports when they finish. Call TaskStop only to cancel.",
      "To continue a previous subagent, pass its `resume` id (the `delegationId` returned by Task). Saying \"reuse\" in prose is not enough. Omit `model` when resuming; repeating the exact retained provider/model key is tolerated but never changes model selection or authorization. Start a new delegation to change models.",
      "Stopped, aborted, interrupted and budget-exhausted delegates retain reports and can be explicitly resumed once settled. Use TaskWait to read their partial results before deciding to continue; a cancellation never resumes automatically.",
      "When the parent has skills, every delegate also receives Skill and the skill catalog. This does not grant other plugin or MCP tools; those still require tools: inherit.",
      `Available subagents:\n${catalog}`,
    ].join("\n\n"),
    parameters: Type.Object({
      agent: Type.String({ description: `Name of the subagent to run: ${definitions.map((definition) => definition.name).join(", ")}.` }),
      task: Type.String({ description: "The complete brief: goal, context the delegate cannot infer, and the exact report you want back." }),
      description: Type.Optional(Type.String({ description: "Short label for this delegation (3-6 words), shown to the user." })),
      model: Type.Optional(Type.String({ description: "Override the delegate's model for a new task, e.g. 'anthropic/claude-sonnet-4-20250514'. Omit to use the subagent's default. Repeating the definition's own Default model key is the same as omitting this parameter. Only choose a different override from the available delegation model catalog. When resuming, omit this field; only an exact repeat of the retained provider/model key is tolerated, not a model or account change." })),
      resume: Type.Optional(Type.String({ description: "delegationId of a settled subagent in this conversation to continue. Omit to start a new session. Resume retains its model binding; omit model rather than selecting it again." })),
      modelReason: Type.Optional(Type.String({ maxLength: 1000, description: "One concise sentence explaining why the selected model fits this task. Required for new tasks in a custom session pool. This never grants approval." })),
      ...(settings ? {
        modelSelection: Type.Optional(Type.Union([Type.Literal("prefer"), Type.Literal("require")], { description: "prefer (default) permits authorized alternatives; require preserves an exact model explicitly required by the user and never substitutes it. Approval still applies." })),
        minContextWindow: Type.Optional(Type.Integer({ minimum: 0, maximum: DELEGATION_CONTEXT_WINDOW_MAX, description: "Minimum model context window required by this task, when known. Omit or use 0 for no minimum." })),
        requiresImages: Type.Optional(Type.Boolean({ description: "Require image input support for this task." })),
      } : {}),
    }),
  };
}
