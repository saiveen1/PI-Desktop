export const sessionLabels = {
  customColor: "Couleur personnalisée", hexColor: "Couleur HEX", hue: "Teinte", saturation: "Saturation", brightness: "Luminosité",
  colorPreview: "Aperçu de la couleur", invalidColor: "Saisissez une couleur HEX valide (#RGB ou #RRGGBB).",
  "title": "Étiquettes",
  "add": "Ajouter une étiquette",
  "name": "Nom de l’étiquette",
  "color": "Couleur",
  "delete": "Supprimer l’étiquette",
  "deleteConfirm": "Supprimer « {{name}} » et la retirer de {{count}} conversations ? Les conversations seront conservées.",
  "moveUp": "Monter",
  "moveDown": "Descendre",
  "save": "Enregistrer",
  "cancel": "Annuler",
  "none": "Aucune étiquette",
  "unclassified": "Non classé",
  "manage": "Gérer les étiquettes",
  "filter": "Filtrer les conversations",
  "clearFilters": "Effacer les filtres",
  "allColors": "Toutes les couleurs",
  "colorMark": "Repère de couleur",
  "clearColor": "Aucun repère de couleur",
  "overflow": "{{count}} étiquettes supplémentaires",
  "reorderBefore": "Déplacer avant {{title}}",
  "reorderAfter": "Déplacer après {{title}}",
  "activityOrder": "Ordre d’activité",
  "investigation": "Investigation",
  "feature": "Fonctionnalité",
  "fix": "Correction",
  "colors": {
    "red": "Rouge",
    "amber": "Ambre",
    "green": "Vert",
    "blue": "Bleu",
    "violet": "Violet",
    "pink": "Rose"
  }
};

export const sessionGroups = {
  title: "Groupes", manage: "Gérer…", name: "Nom du groupe", add: "Ajouter un groupe", delete: "Supprimer le groupe",
  deleteConfirm: "Supprimer « {{name}} » et déplacer {{count}} conversations vers Sans groupe ? Les conversations seront conservées.",
  ungrouped: "Sans groupe", moveTo: "Déplacer vers un groupe",
  description: "Chaque conversation appartient à un groupe de ce projet. Supprimer un groupe conserve ses conversations.",
  labelsDescription: "Les étiquettes décrivent les conversations sans les regrouper ni les filtrer. Les modifications concernent uniquement ce projet.",
  usage: "{{count}} conversations", folders: "{{count}} dossiers", primary: "Principal",
};

export const sessionDelegation = {
  "title": "Modèles des sous-agents",
  "customCount": "Modèles des sous-agents : {{count}} sélectionnés",
  "scope": "Ensemble de modèles",
  "inherit": "Suivre les réglages globaux",
  "custom": "Personnalisé",
  "inheritHint": "Utilise les paramètres globaux de délégation.",
  "taskFitHint": "Choisissez les modèles et les règles d’approbation pour cette conversation uniquement, sans modifier les paramètres globaux. Les sous-tâches sont attribuées selon les descriptions des modèles.",
  "search": "Rechercher des modèles",
  "models": "Modèles de sous-agents disponibles",
  "unavailable": "Indisponible",
  "approvalRequired": "Approbation requise",
  "autoAllowed": "Autorisé automatiquement",
  "approvalFor": "Approbation pour {{model}}",
  "noModels": "Aucun modèle correspondant.",
  "selectedCount": "{{count}} modèles sélectionnés",
  "disabled": "La délégation est désactivée pour cette conversation.",
  "busy": "La sélection peut être enregistrée lorsque la conversation est inactive.",
  "invalidSelection": "Retirez les modèles indisponibles avant d’enregistrer.",
  "cancel": "Annuler",
  "save": "Enregistrer",
  "saving": "Enregistrement…"
};

export const delegationDetails = {
  "title": "Sélection du modèle",
  "requested": "Modèle demandé",
  "reason": "Motif du choix",
  "actual": "Modèle utilisé",
  "scheduling": "Décisions d’ordonnancement",
  "selected": "Sélectionné",
  "skipped": "Ignoré",
  "cancelled": "Annulé"
};
