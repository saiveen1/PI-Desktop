import { useTranslation } from "react-i18next";
import { Badge, Tooltip } from "./ui";

export function SidebarAdminBadge() {
  const { t } = useTranslation();
  if (typeof window === "undefined" || window.piDesktop?.platform !== "win32" || window.piDesktop?.windowsElevated !== true) return null;
  return (
    <Tooltip className="sidebar-admin-badge no-drag" tooltipClassName="ui-tooltip-help" label={t("sidebarAdmin.tooltip")}>
      <Badge tone="warning">{t("sidebarAdmin.label")}</Badge>
    </Tooltip>
  );
}
