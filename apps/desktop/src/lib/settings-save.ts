import { isNotificationSettings, type AppSettings, type NotificationSettings } from "@pi-desktop/shared";

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
    save: (patch: Partial<AppSettings>) => update(latest => ({ ...latest, ...patch })),
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
