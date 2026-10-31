import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { AppSettings } from "@pi-desktop/shared";
import { useAppStore } from "../../stores/app-store";
import { SegmentedControl } from "../ui";
import { AgentSubagentsPage } from "./AgentSubagentsPage";
import { SubagentSchedulingSettings } from "./SubagentSchedulingSettings";

export function SubagentSettingsPage({ saveSettings }: {
  saveSettings: (patch: Partial<AppSettings>) => Promise<void>;
}) {
  const { t } = useTranslation();
  const anchor = useAppStore((state) => state.settingsAnchor);
  const [tab, setTab] = useState<"roles" | "scheduling">(
    anchor === "settings.delegationScheduling" ? "scheduling" : "roles",
  );
  if (anchor === "settings.delegationScheduling" && tab !== "scheduling") setTab("scheduling");
  const activeTab = tab;
  return (
    <div className="space-y-4">
      <SegmentedControl
        value={activeTab}
        onChange={(value) => {
          useAppStore.getState().setSettingsAnchor(null);
          setTab(value);
        }}
        label={t("settings.subagents")}
        role="tablist"
        options={[
          { value: "roles", label: t("settings.delegationRoles"), id: "subagent-roles-tab", controls: "subagent-roles-panel" },
          { value: "scheduling", label: t("settings.delegationScheduling"), id: "subagent-scheduling-tab", controls: "subagent-scheduling-panel" },
        ]}
      />
      <div id="subagent-roles-panel" role="tabpanel" aria-labelledby="subagent-roles-tab" hidden={activeTab !== "roles"}>
        <AgentSubagentsPage />
      </div>
      <div id="subagent-scheduling-panel" role="tabpanel" aria-labelledby="subagent-scheduling-tab" hidden={activeTab !== "scheduling"}>
        <SubagentSchedulingSettings saveSettings={saveSettings} />
      </div>
    </div>
  );
}
