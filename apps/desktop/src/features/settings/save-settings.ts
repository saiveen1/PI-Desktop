import { api } from "../../lib/api";
import { createSettingsWriter } from "../../lib/settings-save";
import { useAppStore } from "../../stores/app-store";

export const settingsWriter = createSettingsWriter({
  read: () => api.getSettings(),
  write: settings => api.setSettings(settings),
  publish: settings => useAppStore.setState({ settings }),
});
