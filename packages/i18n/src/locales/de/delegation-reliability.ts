import { delegationObservability } from "../en/delegation-observability.js";

export const delegationReliabilitySettings = {
  providerStreamIdleTimeout: "Leerlaufzeit der Modellverbindung",
  providerStreamIdleTimeoutDesc: "Bricht nur ab, wenn innerhalb der gewählten Zeit keine Antwortdaten eintreffen. Langes Nachdenken startet die Anfrage nicht neu. Gilt ab der nächsten Runde; deaktivierte festgefahrene Anfragen müssen manuell gestoppt werden.",
  providerStreamIdleTimeoutDisabled: "Deaktiviert",
  providerStreamIdleTimeoutMinutes: "{{count}} Minuten",
  "delegationRunReportRecovery": "Fehlenden Abschlussbericht anfordern",
  "delegationRunReportRecoveryDesc": "Endet ein Unterauftrag ohne Bericht, wird einmal ein Bericht ohne Werkzeuge angefordert. Es gilt die Berichtsfrist; API-Verbrauch kann entstehen.",
  "delegationRunReportRecoveryOnce": "Einmal",
  "delegationRunReportRecoveryOff": "Aus",
  "unknownUpstreamRetryLimit": "Wiederholungen bei unbekanntem Upstream-Fehler",
  "unknownUpstreamRetryLimitDesc": "Generische Upstream-Fehler 400/422 werden pro Antwort höchstens so oft wiederholt. 0 deaktiviert dies; unbegrenzte Wiederholungen ändern diese Grenze nicht."
};

export const delegationDiagnostics = {
  ...delegationObservability,
  "title": "Delegationsdetails",
  "requestedModel": "Angefordertes Modell",
  "actualModel": "Tatsächliches Modell",
  "activity": "Aktivität",
  "activityCounts": "{{turns}} Runden · {{tools}} Werkzeugaufrufe",
  "stopReason": "Abschlussgrund",
  "reportOutcome": "Berichtsergebnis",
  "responseStructure": "Antwortstruktur",
  "responseCounts": "{{text}} Text · {{thinking}} Denken · {{tools}} Werkzeuge",
  "recoveryAttempts": "Berichtswiederholungen",
  "failure": "Fehler",
  "selection": "Modellauswahl",
  "modelFailures": "Modellfehler",
  "selected": "Ausgewählt",
  "skipped": "Übersprungen",
  "cancelled": "Abgebrochen",
  "retry": "Wiederherstellung",
  "retryAttempt": "Versuch {{attempt}} / {{limit}}",
  "stopReasons": {
    "stop": "Normal beendet",
    "tool_calls": "Werkzeuganfrage",
    "length": "Ausgabelimit",
    "error": "Fehler",
    "aborted": "Abgebrochen",
    "unknown": "Nicht aufgezeichnet"
  },
  "reportOutcomes": {
    "delivered": "Bericht geliefert",
    "missing": "Kein Abschlussbericht",
    "truncated": "Bericht abgeschnitten",
    "invalid_tool_ending": "Ungültiges Werkzeugende",
    "error": "Fehlgeschlagen",
    "cancelled": "Abgebrochen"
  }
};
