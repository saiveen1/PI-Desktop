import { IPC, isSubagentStyle, type UpdatePreference } from "@pi-desktop/shared";
import { resolveAgentOutputGuardSettings, resolveObserverGuardSettings } from "@pi-desktop/shared";
import type { AgentSidecar } from "../agent-sidecar";
import type { HostProcess } from "../host-process";
import type { IpcRegistrar } from "./types";
import type { LiveCallService } from "../live-voice/call-service";
import type { AppSettings } from "@pi-desktop/shared";
import { currentSystemProxyRelayUrl } from "../network-proxy";

export type SettingsIpcDependencies = {
  registrar: IpcRegistrar;
  sendToRenderer: (channel: string, payload: unknown) => void;
  getHost: () => HostProcess | null;
  getSidecar: () => AgentSidecar | null;
  dataDir: string;
  normalizeSettings: (settings: unknown) => unknown;
  validateSettingsWrite: (settings: unknown) => any;
  testNetworkProxy: (settings: unknown) => Promise<unknown>;
  applyNetworkProxyFromAppSettings: (settings: unknown) => Promise<unknown>;
  currentNetworkProxy: () => unknown;
  applyApplicationMenuSettings: (settings?: {
    language?: unknown;
    theme?: unknown;
    keybindings?: unknown;
    developerMode?: unknown;
    fontScale?: unknown;
  } | null) => void;
  applyDeveloperMode: (settings?: { developerMode?: unknown } | null) => void;
  applyPreventScreenSleep: (settings?: { preventScreenSleep?: unknown } | null) => void;
  applyKeepAwakeWhileRunning: (settings?: { keepAwakeWhileRunning?: unknown } | null) => void;
  applyUpdatePreference: (preference: UpdatePreference) => void;
  resolveEffectiveCommandShell: () => Promise<unknown>;
  delegationSettingsWritten?: () => Promise<void>;
  liveCallService?: Pick<LiveCallService, "beginSettingsWrite" | "settingsWritten">;
};

/** Register app settings and command-shell channels. */
export function registerSettingsIpc({
  registrar,
  sendToRenderer,
  getHost,
  getSidecar,
  dataDir,
  normalizeSettings,
  validateSettingsWrite,
  testNetworkProxy,
  applyNetworkProxyFromAppSettings,
  currentNetworkProxy,
  applyApplicationMenuSettings,
  applyDeveloperMode,
  applyPreventScreenSleep,
  applyKeepAwakeWhileRunning,
  applyUpdatePreference,
  resolveEffectiveCommandShell,
  liveCallService,
  delegationSettingsWritten,
}: SettingsIpcDependencies): void {
  let host: HostProcess | null = null;
  let sidecar: AgentSidecar | null = null;
  let settingsWriteTail: Promise<unknown> = Promise.resolve();
  const handle = (channel: string, fn: (...args: any[]) => Promise<any>) => {
    registrar.handle(channel, async (...args) => {
      host = getHost();
      sidecar = getSidecar();
      return fn(...args);
    });
  };

  handle(IPC.invoke.settingsGet, async () => {
    if (!host) throw new Error("host unavailable");
    const settings = await host.call("settings.get");
    return normalizeSettings(settings);
  });

  handle(IPC.invoke.networkProxyTest, async (settings: unknown) => {
    return testNetworkProxy(settings);
  });

  const writeSettings = async (settings: unknown) => {
    const host = getHost();
    const sidecar = getSidecar();
    if (!host) throw new Error("host unavailable");
    const incoming = validateSettingsWrite(settings);
    const currentSettings = await host.call<AppSettings>("settings.get");
    const guardPatch = incoming && typeof incoming === "object" && !Array.isArray(incoming)
      ? (incoming as Partial<AppSettings>).agentOutputGuard : undefined;
    const observerPatch = incoming && typeof incoming === "object" && !Array.isArray(incoming)
      ? (incoming as Partial<AppSettings>).observerGuard : undefined;
    const validatedSettings = guardPatch === undefined && observerPatch === undefined ? incoming : {
      ...incoming,
      ...(guardPatch === undefined ? {} : { agentOutputGuard: { ...resolveAgentOutputGuardSettings(currentSettings.agentOutputGuard), ...guardPatch } }),
      ...(observerPatch === undefined ? {} : { observerGuard: { ...resolveObserverGuardSettings(currentSettings.observerGuard), ...observerPatch } }),
    };
    const prospectiveSettings = validatedSettings && typeof validatedSettings === "object" && !Array.isArray(validatedSettings)
      ? { ...currentSettings, ...(validatedSettings as Partial<AppSettings>) }
      : currentSettings;
    const releaseSettingsWrite = liveCallService?.beginSettingsWrite(prospectiveSettings);
    let result: { ok: true };
    try {
      result = await host.call<{ ok: true }>("settings.set", validatedSettings);
      // The host acknowledges the write rather than returning stored settings.
      applyDeveloperMode(prospectiveSettings);
      const style = validatedSettings?.subagentStyle;
      if (isSubagentStyle(style)) {
        sendToRenderer(IPC.event.settingsChanged, { subagentStyle: style });
      }
      await delegationSettingsWritten?.();
      await liveCallService?.settingsWritten(prospectiveSettings);
    } finally {
      releaseSettingsWrite?.();
    }
    const updatePreference = (validatedSettings as { updatePreference?: unknown })
      .updatePreference;
    if (updatePreference === "automatic" || updatePreference === "manual") {
      applyUpdatePreference(updatePreference);
    }
    if (typeof (validatedSettings as { keepAwakeWhileRunning?: unknown })
      .keepAwakeWhileRunning === "boolean") {
      applyKeepAwakeWhileRunning(validatedSettings as { keepAwakeWhileRunning: boolean });
    }
    if (typeof (validatedSettings as { preventScreenSleep?: unknown })
      .preventScreenSleep === "boolean") {
      applyPreventScreenSleep(validatedSettings as { preventScreenSleep: boolean });
    }
    await applyNetworkProxyFromAppSettings(validatedSettings);
    if (sidecar) {
      try {
        await sidecar.call("sidecar.configure", {
          hostBinary: host.binaryPath,
          dataDir,
          networkProxy: currentNetworkProxy(),
          systemProxyRelayUrl: currentSystemProxyRelayUrl(),
        });
      } catch {
        // Sidecar will pick up PI_DESKTOP_PROXY_JSON on the next spawn.
      }
    }
    applyApplicationMenuSettings(
      validatedSettings as {
        language?: unknown;
        theme?: unknown;
        keybindings?: unknown;
        developerMode?: unknown;
        // A docked plugin view follows the saved type scale (D343), so the
        // Appearance write has to carry it to the host's view zoom.
        fontScale?: unknown;
      } | null,
    );
    return result;
  };
  handle(IPC.invoke.settingsSet, (settings: unknown) => {
    const operation = settingsWriteTail.then(() => writeSettings(settings));
    settingsWriteTail = operation.then(() => undefined, () => undefined);
    return operation;
  });

  handle(IPC.invoke.commandShellList, async () => resolveEffectiveCommandShell());
}
