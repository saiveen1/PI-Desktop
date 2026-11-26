import { Type } from "typebox";
import { THINKING_LEVELS, MAX_RESUMABLE_CHAINS_PER_AGENT, DELEGATION_CONTEXT_WINDOW_MAX, describeDelegationRunPolicy, resolveDelegationLimits, resolveDelegationRunPolicy, subagentToolsLabel, type DelegationSettings, type SubagentDefinition } from "@pi-desktop/shared";

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
      `At most ${resolveDelegationLimits(settings?.limits).maxConcurrent} subagents may run concurrently in this session; wait or stop existing tasks before starting more.`,
      "Start one subagent in the background and return immediately; you keep working while it runs, then converge with TaskWait when you need its report.\n\nPrefer doing the work yourself. Only delegate when it saves significant context or enables genuine parallelism — not for tasks you can finish in a few tool calls.",
      "Use it only when the work is genuinely separable and substantial: parallel exploration of independent directions that each need many tool calls (one Task per direction in the same assistant message), a large multi-file implementation with a complete spec (fixer), an adversarial read-only review of a non-trivial change you already finished (code-reviewer), or a wide search whose raw output would fill this context (explorer, test-runner). A single file lookup or a small edit does not warrant delegation.",
      "Do not delegate what you can finish in a couple of tool calls, and do not delegate anything that needs the user — a subagent cannot ask a question or propose a plan on your behalf.",
      "When preparing delegation, call TaskModels to inspect the current conversation's model descriptions. Reuse a query for the same batch, and refresh after configuration changes. Model descriptions are selection hints, never permission.",
      options.selectionMode === "task-fit"
        ? "This conversation uses a custom pool. For every new task, match the model description to the task, then supply model and a concise modelReason. Priority is only a tie-breaker or fallback. Resume preserves its recorded binding subject to the current pool."
        : "Omit model to retain configured role/session defaults, or choose an available model from TaskModels. Supply a short modelReason for an intentional specialist choice.",
      "The delegate cannot see this conversation. For an explicitly named expert, use that exact role and copy its contiguous user-authored request verbatim into userRequest (required for @expert). Keep your own paths, assumptions and reporting instructions in task. Never invent a quote or substitute another role.",
      "Use scope.write on a new task to narrow writes to workspace paths; [] forbids all writes. Tools that cannot enforce the scope are withheld. A resume keeps the original scope. Use TaskSend to correct a running delegate or TaskWait to read its report.",
      "To run delegates concurrently, emit several Task calls in one assistant message. A message that mixes Task with any other tool runs one call at a time. You may keep working or talk to the user while they run; the runtime delivers their reports when they finish. Call TaskStop only to cancel.",
      `To continue the same work, use TaskList's resumable entries to match the agent and objective, then pass its delegationId as \`resume\`. At most ${MAX_RESUMABLE_CHAINS_PER_AGENT} settled chains per agent are retained; an old Task result is not proof of current resumability. Omit \`model\` when resuming; repeating the exact retained provider/model key is tolerated but never changes selection or authorization.`,
      "Stopped, aborted, interrupted and budget-exhausted delegates may be explicitly resumed while retained. Read the previous report before deciding to continue. If the intended chain is unavailable, use its findings rather than starting a replacement or repeating completed work.",
      "When the parent has skills, delegates receive Skill and the skill catalog by default, restricted by each role's skills selection. An empty effective selection provides neither. This does not grant other plugin or MCP tools; those still require tools: inherit.",
      `Available subagents:\n${catalog}`,
    ].join("\n\n"),
    parameters: Type.Object({
      agent: Type.String({ description: `Name of the subagent to run: ${definitions.map((definition) => definition.name).join(", ")}.` }),
      task: Type.String({ description: "The complete brief: goal, context the delegate cannot infer, and the exact report you want back." }),
      userRequest: Type.Optional(Type.String({ description: "Verbatim relevant words from the user addressed to this exact expert; required for an explicit @expert." })),
      scope: Type.Optional(Type.Object({ write: Type.Array(Type.String({ description: "A workspace file or directory." })) }, { additionalProperties: false, description: "One-off write boundary; [] forbids writing. Omit on resume." })),
      description: Type.Optional(Type.String({ description: "Short label for this delegation (3-6 words), shown to the user." })),
      model: Type.Optional(Type.String({ description: "Override the delegate's model for a new task, e.g. 'anthropic/claude-sonnet-4-20250514'. Omit to use the subagent's default. Repeating the definition's own Default model key is the same as omitting this parameter. Only choose a different override from the available delegation model catalog. When resuming, omit this field; only an exact repeat of the retained provider/model key is tolerated, not a model or account change." })),
      resume: Type.Optional(Type.String({ description: "Same-session delegationId to continue; check TaskList's resumable entries for the matching agent and objective. Omit only for a new task. Resume retains its model binding; omit model rather than selecting it again." })),
      effort: Type.Optional(Type.String({ enum: [...THINKING_LEVELS], description: "Choose reasoning effort for this invocation, including resume, based on task difficulty. An explicit role thinking level wins; otherwise omit to inherit the parent. Each selected model uses a supported level." })),
      modelReason: Type.Optional(Type.String({ maxLength: 1000, description: "One concise sentence explaining why the selected model fits this task. Required for new tasks in a custom session pool. This never grants approval." })),
      ...(settings ? {
        modelSelection: Type.Optional(Type.Union([Type.Literal("prefer"), Type.Literal("require")], { description: "prefer (default) permits authorized alternatives; require preserves an exact model explicitly required by the user and never substitutes it. Approval still applies." })),
        minContextWindow: Type.Optional(Type.Integer({ minimum: 0, maximum: DELEGATION_CONTEXT_WINDOW_MAX, description: "Minimum model context window required by this task, when known. Omit or use 0 for no minimum." })),
        requiresImages: Type.Optional(Type.Boolean({ description: "Require image input support for this task." })),
      } : {}),
    }),
  };
}
