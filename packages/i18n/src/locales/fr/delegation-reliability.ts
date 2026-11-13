import { delegationObservability } from "../en/delegation-observability.js";

export const delegationReliabilitySettings = {
  providerStreamIdleTimeout: "Délai d'inactivité de connexion au modèle",
  providerStreamIdleTimeoutDesc: "Annule uniquement si aucune donnée ne parvient pendant la durée choisie. Une réflexion longue ne relance pas la requête. Applicable au prochain tour ; si désactivé, arrêtez manuellement une requête bloquée.",
  providerStreamIdleTimeoutDisabled: "Désactivé",
  providerStreamIdleTimeoutMinutes: "{{count}} minutes",
  "delegationRunReportRecovery": "Récupérer le rapport final manquant",
  "delegationRunReportRecoveryDesc": "Si une sous-tâche se termine sans rapport, demander une fois un rapport sans outils. Le délai configuré s'applique et des frais API peuvent s'ajouter.",
  "delegationRunReportRecoveryOnce": "Une fois",
  "delegationRunReportRecoveryOff": "Désactivé",
  "unknownUpstreamRetryLimit": "Tentatives pour les erreurs upstream inconnues",
  "unknownUpstreamRetryLimitDesc": "Réessayer les erreurs upstream génériques 400/422 jusqu'à cette limite par réponse. 0 désactive la récupération ; les tentatives illimitées ne modifient pas cette limite."
};

export const delegationDiagnostics = {
  ...delegationObservability,
  "title": "Détails de délégation",
  "requestedModel": "Modèle demandé",
  "actualModel": "Modèle utilisé",
  "activity": "Activité",
  "activityCounts": "{{turns}} tours · {{tools}} appels d'outils",
  "stopReason": "Motif de fin",
  "reportOutcome": "Résultat du rapport",
  "responseStructure": "Structure de réponse",
  "responseCounts": "{{text}} texte · {{thinking}} réflexion · {{tools}} outils",
  "recoveryAttempts": "Tentatives de rapport",
  "failure": "Échec",
  "selection": "Sélection du modèle",
  "modelFailures": "Échecs des modèles",
  "selected": "Sélectionné",
  "skipped": "Ignoré",
  "cancelled": "Annulé",
  "retry": "Récupération",
  "retryAttempt": "Tentative {{attempt}} / {{limit}}",
  "stopReasons": {
    "stop": "Fin normale",
    "tool_calls": "Demande d'outil",
    "length": "Limite de sortie",
    "error": "Erreur",
    "aborted": "Annulé",
    "unknown": "Non enregistré"
  },
  "reportOutcomes": {
    "delivered": "Rapport livré",
    "missing": "Aucun rapport final",
    "truncated": "Rapport tronqué",
    "invalid_tool_ending": "Fin d'outil invalide",
    "error": "Échec",
    "cancelled": "Annulé"
  }
};
