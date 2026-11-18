import { useEffect } from "react";
import { api } from "./lib/api";
import { installPerformanceUiProbe } from "./lib/performance-ui-probe";
import { useAppStore } from "./stores/app-store";
import { ErrorBoundary } from "./features/app/chrome";
import { AppShell } from "./features/app/AppShell";

export default function App() {
  useEffect(() => {
    if (new URLSearchParams(window.location.search).get("surface")) return;
    return installPerformanceUiProbe({
      onCapture: (listener) => api.onPerformanceCapture(listener),
      sendPulse: (pulse) => api.sendPerformancePulse(pulse),
      getState: useAppStore.getState,
      subscribeState: (listener) => useAppStore.subscribe(listener),
      document,
    });
  }, []);
  return (
    <ErrorBoundary>
      <AppShell />
    </ErrorBoundary>
  );
}
