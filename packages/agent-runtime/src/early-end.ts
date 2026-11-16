// shortcut: deterministic English/Chinese intent signals only; ambiguous replies stay terminal.
function prose(text: string): string {
  return text.replace(/```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)/g, "")
    .replace(/`[^`\n]*`|“[^”]*”|「[^」]*」|"[^"\n]*"/g, "")
    .split("\n").filter(line => !/^\s*(?:>| {4}|\t)/.test(line)).join("\n").trim();
}

const DISCUSSION = /\b(?:explain|discuss|advice|suggestions?|how (?:to|do|can)|what (?:is|are|would)|why|translate|quote|should (?:I|we)|can I|do you think)\b|(?:解释|讨论|建议|如何|怎么|为什么|翻译|引用|仅分析|只分析|不要执行|不要修改|要不要|该不该|是否应该)/i;
const TASK = /\b(?:implement|fix|repair|update|change|edit|write|create|delete|remove|run|test|verify|check|inspect|review|find|locate|retry|finish|complete|build|continue)\b|(?:修复|实现|修改|更新|创建|删除|运行|测试|验证|检查|查找|定位|重试|完成|继续)/i;
const CONTINUATION = /^(?:continue|proceed|go ahead|继续|接着做)[.!。！\s]*$/i;
const WAITING = /[?？]|\b(?:blocked|unable|cannot|can't|waiting|awaiting|approval|permission|need (?:your|user) (?:input|help|confirmation)|please (?:provide|confirm|choose)|if you (?:want|wish|like)|you (?:can|could|should)|would you)\b|(?:受阻|阻塞|无法|不能|等待|批准|审批|授权|需要你|请(?:提供|确认|选择)|如果你|你可以|建议)/i;
const OPTIONAL = /\b(?:optional(?:ly)?|could|might|if (?:desired|needed|requested))\b|(?:可选|可以考虑|如有需要|若需要)/i;
const REPORT = /(?:^|[\n.!。！]\s*)(?:done|all done|complete(?:d)?|finished|implemented|fixed|resolved|summary|changes|tests? (?:passed|pass|complete)|all .{0,40} (?:passed|complete))\b|\b(?:task|work|implementation|fix|checks?|tests?|changes?|request|plan) (?:is|are|was|were|has been|have been) (?:complete|completed|done|finished|fixed|verified)\b|\bI (?:have )?(?:finished|completed|implemented|fixed)\b|(?:已(?:经)?(?:全部)?(?:完成|修复|解决)|全部完成|修复完成|验证通过|测试通过|交付结果|完成报告)/i;
const NEXT_ACTION = /(?:^|[\n.!?。！？]\s*)(?:I(?:['’]ll| will| am (?:going to|now))\s+(?:now\s+)?(?:use|retry|inspect|read|check|run|write|update|fix|implement|create|continue|test|verify|try|look|search)|(?:Writing|Reading|Updating|Implementing|Checking|Running|Creating|Fixing|Reviewing)\b[^\n.!?]{0,100}\b(?:now|remaining)\b|我(?:会|将|现在|接下来|再|来|先|用|准备).{0,100}(?:重试|检查|运行|读取|修改|修复|实现|创建|继续|测试|验证|查找|定位))/i;

export function actionableUserTask(task: string, hasToolProgress: boolean): boolean {
  const text = prose(task);
  if (!text || DISCUSSION.test(text)) return false;
  return TASK.test(text) && (!CONTINUATION.test(text) || hasToolProgress);
}

/** Requires task evidence as well as a short, unqualified promise of immediate action. */
export function suspectedEarlyEnd(task: string, response: string, hasToolProgress: boolean): boolean {
  const text = prose(response);
  return actionableUserTask(task, hasToolProgress) && text.length > 0 && text.length <= 800 &&
    !WAITING.test(text) && !OPTIONAL.test(text) && !REPORT.test(text) && NEXT_ACTION.test(text);
}

export const EARLY_END_SECTION = "early_end_recovery";
export const EARLY_END_REMINDER = [
  "<early_end_recovery>",
  "Your last reply announced an immediate next action but ended without a tool call.",
  "Continue only the user's existing task within its scope and permissions. Retain completed results; do not replay successful actions or assume uncertain effects did not happen.",
  "Use a structured tool call if work remains. If complete, blocked, or awaiting user input/approval, report that accurately instead. Do not claim unfinished work is complete.",
  "This reminder applies to this request only and is not a new user request.",
  "</early_end_recovery>",
].join("\n");
