import { useCallback, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useAppStore } from "../../stores/app-store";
import { organizeSessions, type SessionOrganizationAction } from "./session-organization";

export function useSessionOrganization() {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const run = useCallback(async (ids: readonly string[], action: SessionOrganizationAction) => {
    if (inFlight.current || ids.length === 0) return [];
    inFlight.current = true;
    setBusy(true);
    try {
      const result = await organizeSessions(ids, action);
      const { showToast } = useAppStore.getState();
      if (result.failures.length) {
        showToast(result.failures.map(({ title, error }) => t("sessionOrganization.failed", {
          title, reason: error instanceof Error ? error.message : String(error),
        })).join("\n"), { variant: "error" });
      } else if (result.completed.length) {
        showToast(t("sessionOrganization.processed", { count: result.completed.length }));
      }
      return result.completed;
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }, [t]);
  return { busy, run };
}
