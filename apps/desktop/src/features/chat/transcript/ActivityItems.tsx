import { memo } from "react";
import type { AssistantActivityItem } from "../../../lib/assistant-turns";
import { isDelegationActivityItem, type DelegationActivityItem, type SubagentOutcome, type SubagentTiming } from "../../../lib/subagent-topology";
import { reviewChangeFromMessage } from "../../../lib/workspace-review";
import { ReviewChangeCard } from "../../../components/ReviewChangeCard";
import { thinkingRowStartsOpen } from "../../../lib/activity-group-folding";
import { ThinkingRow } from "./shared";
import { HostedSearchRow } from "./HostedSearchRow";
import { SubagentTaskList } from "./SubagentTaskList";
import { ToolRow } from "./ToolRow";
import { useRenderBlocks, type RenderBlock } from "./render-blocks";

function itemKey(item: AssistantActivityItem) {
  if (item.kind === "tool") return item.message.id;
  if (item.kind === "hostedSearch") return `hosted-search-${item.message.id}-${item.round.id}`;
  return `thinking-${item.message.id}`;
}

type ActivityItemsProps = {
  items: readonly AssistantActivityItem[];
  isActive: boolean;
  live: boolean;
  delegateItems: DelegationActivityItem[];
  delegationStatuses: ReadonlyMap<string, SubagentOutcome>;
  delegationTimings: ReadonlyMap<string, SubagentTiming>;
  onUserInteraction: () => void;
  /** `resolveAutoCollapseThinking`: folded reasoning stays folded by default. */
  collapseThinking: boolean;
};

type ActivityItemBlockProps = Omit<ActivityItemsProps, "items" | "delegateItems" | "delegationStatuses" | "delegationTimings"> & {
  block: RenderBlock<AssistantActivityItem>;
  topologyItem?: AssistantActivityItem;
  delegateItems?: DelegationActivityItem[];
  delegationStatuses?: ReadonlyMap<string, SubagentOutcome>;
  delegationTimings?: ReadonlyMap<string, SubagentTiming>;
};

const ActivityItemBlock = memo(function ActivityItemBlock({
  block, isActive, live, topologyItem,
  delegateItems, delegationStatuses, delegationTimings, onUserInteraction,
  collapseThinking,
}: ActivityItemBlockProps) {
  return <>{block.items.map((item) => {
    // The topology predicate narrows to all tools, but a false result can still
    // be an ordinary tool. Do not exclude tools from the remaining branches.
    const delegation = Boolean(isDelegationActivityItem(item));
    if (delegation) {
      if (item !== topologyItem || !delegateItems) return null;
      return <SubagentTaskList
        key="subagent-tasks"
        items={delegateItems}
        delegationStatuses={delegationStatuses}
      />;
    }
    // A tool or hosted-search row always starts collapsed: only the user opens
    // a payload, never the row's position in the turn. A review-backed edit is
    // already a complete tool-level row (file header + diff body), so rendering
    // the generic tool row above it would repeat the file header.
    if (item.kind === "tool") {
      if (reviewChangeFromMessage(item.message)) {
        return <ReviewChangeCard
          key={item.message.id}
          message={item.message}
          asToolRow
        />;
      }
      return <ToolRow
        key={item.message.id}
        imagesInTurn
        message={item.message}
        onUserInteraction={onUserInteraction}
        {...(item.delegate ? { delegate: item.delegate } : {})}
      />;
    }
    if (item.kind === "hostedSearch") return <HostedSearchRow
      key={`hosted-search-${item.message.id}-${item.round.id}`}
      messageId={item.message.id}
      round={item.round}
      streaming={isActive && item.message.status === "streaming"}
      onUserInteraction={onUserInteraction}
    />;
    // Live reasoning remains opt-in; an explicit reader choice is retained.
    const streaming = isActive && item.message.status === "streaming";
    return <ThinkingRow
      key={`thinking-${item.message.id}`}
      message={item.message}
      streaming={streaming}
      autoOpen={thinkingRowStartsOpen({ streaming, collapseSettled: collapseThinking })}
      onUserInteraction={onUserInteraction}
    />;
  })}</>;
});

export const ActivityItems = memo(function ActivityItems({ items, ...context }: ActivityItemsProps) {
  const blocks = useRenderBlocks(items, itemKey);
  const topologyItem = context.delegateItems[0];
  return <>{blocks.map((block) => {
    const ownsTopology = topologyItem !== undefined && block.items.includes(topologyItem);
    return <ActivityItemBlock
      key={block.key}
      block={block}
      isActive={context.isActive}
      live={context.live}
      topologyItem={ownsTopology ? topologyItem : undefined}
      delegateItems={ownsTopology ? context.delegateItems : undefined}
      delegationStatuses={ownsTopology ? context.delegationStatuses : undefined}
      delegationTimings={ownsTopology ? context.delegationTimings : undefined}
      onUserInteraction={context.onUserInteraction}
      collapseThinking={context.collapseThinking}
    />;
  })}</>;
});
