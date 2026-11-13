import { delegationObservability } from "../en/delegation-observability.js";

export const delegationReliabilitySettings = {
  providerStreamIdleTimeout: "Tiempo de inactividad de conexión del modelo",
  providerStreamIdleTimeoutDesc: "Cancela solo si no llegan datos durante el tiempo seleccionado. Pensar durante mucho tiempo no reinicia la solicitud. Se aplica desde el siguiente turno; si se desactiva, detén manualmente las solicitudes bloqueadas.",
  providerStreamIdleTimeoutDisabled: "Desactivado",
  providerStreamIdleTimeoutMinutes: "{{count}} minutos",
  "delegationRunReportRecovery": "Recuperar el informe final ausente",
  "delegationRunReportRecoveryDesc": "Si una subtarea termina sin informe, solicita una vez un informe sin herramientas. Se aplica el plazo configurado y puede consumir API.",
  "delegationRunReportRecoveryOnce": "Una vez",
  "delegationRunReportRecoveryOff": "Desactivado",
  "unknownUpstreamRetryLimit": "Reintentos de errores upstream desconocidos",
  "unknownUpstreamRetryLimitDesc": "Reintenta errores upstream genéricos 400/422 hasta este límite por respuesta. 0 desactiva la recuperación; los reintentos ilimitados no amplían este límite."
};

export const delegationDiagnostics = {
  ...delegationObservability,
  "title": "Detalles de delegación",
  "requestedModel": "Modelo solicitado",
  "actualModel": "Modelo utilizado",
  "activity": "Actividad",
  "activityCounts": "{{turns}} turnos · {{tools}} llamadas a herramientas",
  "stopReason": "Motivo de finalización",
  "reportOutcome": "Resultado del informe",
  "responseStructure": "Estructura de respuesta",
  "responseCounts": "{{text}} texto · {{thinking}} razonamiento · {{tools}} herramientas",
  "recoveryAttempts": "Intentos de recuperar informe",
  "failure": "Error",
  "selection": "Selección de modelo",
  "modelFailures": "Errores de modelo",
  "selected": "Seleccionado",
  "skipped": "Omitido",
  "cancelled": "Cancelado",
  "retry": "Recuperación",
  "retryAttempt": "Intento {{attempt}} / {{limit}}",
  "stopReasons": {
    "stop": "Finalización normal",
    "tool_calls": "Solicitud de herramienta",
    "length": "Límite de salida",
    "error": "Error",
    "aborted": "Cancelado",
    "unknown": "Sin registro"
  },
  "reportOutcomes": {
    "delivered": "Informe entregado",
    "missing": "Sin informe final",
    "truncated": "Informe truncado",
    "invalid_tool_ending": "Final de herramienta inválido",
    "error": "Error",
    "cancelled": "Cancelado"
  }
};
