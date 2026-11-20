import { isNotificationSettings, type AppSettings, type NotificationSettings } from "@pi-desktop/shared";
import { isAgentOutputGuardSettings, resolveAgentOutputGuardSettings } from "@pi-desktop/shared";
import { isObserverGuardSettings, resolveObserverGuardSettings } from "@pi-desktop/shared";
import { isPersonaCatalog, type PersonaDefinition } from "@pi-desktop/shared";

type Boundary = {
  read(): Promise<AppSettings>;
  write(settings: AppSettings): Promise<unknown>;
  publish(settings: AppSettings): void;
};
/** Serialize read/merge/write; failed saves never publish and do not poison later writes. */
export function createSettingsWriter(boundary: Boundary) {
  let tail = Promise.resolve();
  const update = (change: (latest: AppSettings) => AppSettings) => {
    const operation = tail.then(async () => {
      const next = change(await boundary.read());
      await boundary.write(next);
      boundary.publish(next);
      return next;
    });
    tail = operation.then(() => undefined, () => undefined);
    return operation;
  };
  return {
    save: (patch: Partial<AppSettings>) => {
      if (Object.prototype.hasOwnProperty.call(patch, "agentOutputGuard") && !isAgentOutputGuardSettings(patch.agentOutputGuard)) {
        return Promise.reject(new Error("agentOutputGuard is invalid"));
      }
      if (Object.prototype.hasOwnProperty.call(patch, "observerGuard") && !isObserverGuardSettings(patch.observerGuard)) {
        return Promise.reject(new Error("observerGuard is invalid"));
      }
      return update(latest => ({
        ...latest,
        ...patch,
        ...(patch.agentOutputGuard === undefined ? {} : {
          agentOutputGuard: { ...resolveAgentOutputGuardSettings(latest.agentOutputGuard), ...patch.agentOutputGuard },
        }),
        ...(patch.observerGuard === undefined ? {} : {
          observerGuard: { ...resolveObserverGuardSettings(latest.observerGuard), ...patch.observerGuard },
        }),
      }));
    },
    personas(change: (catalog: readonly PersonaDefinition[]) => PersonaDefinition[]) {
      return update(latest => {
        const personas = change(latest.personas ?? []);
        if (!isPersonaCatalog(personas)) throw new Error("personas is invalid");
        return { ...latest, personas };
      });
    },
    notifications(value: NotificationSettings, scope: "global" | "delegation") {
      if (!isNotificationSettings(value)) return Promise.reject(new Error("Invalid notification preferences"));
      return update(latest => {
        const current = latest.notifications ?? { version: 1 as const };
        const notifications: NotificationSettings = scope === "global"
          ? { ...value, delegation: current.delegation }
          : { ...current, delegation: value.delegation };
        if (notifications.delegation === undefined) delete notifications.delegation;
        return { ...latest, notifications };
      });
    },
  };
}
