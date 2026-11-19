export const sessionLabels = {
  customColor: "Eigene Farbe", hexColor: "HEX-Farbe", hue: "Farbton", saturation: "Sättigung", brightness: "Helligkeit",
  colorPreview: "Farbvorschau", invalidColor: "Eine gültige HEX-Farbe eingeben (#RGB oder #RRGGBB).",
  "title": "Labels",
  "add": "Label hinzufügen",
  "name": "Labelname",
  "color": "Farbe",
  "delete": "Label löschen",
  "deleteConfirm": "„{{name}}“ löschen und aus {{count}} Unterhaltungen entfernen? Die Unterhaltungen bleiben erhalten.",
  "moveUp": "Nach oben",
  "moveDown": "Nach unten",
  "save": "Speichern",
  "cancel": "Abbrechen",
  "none": "Keine Labels",
  "unclassified": "Nicht zugeordnet",
  "manage": "Labels verwalten",
  "filter": "Unterhaltungen filtern",
  "clearFilters": "Filter löschen",
  "allColors": "Alle Farben",
  "colorMark": "Farbmarkierung",
  "clearColor": "Keine Farbmarkierung",
  "overflow": "{{count}} weitere Labels",
  "reorderBefore": "Vor {{title}} verschieben",
  "reorderAfter": "Nach {{title}} verschieben",
  "activityOrder": "Aktivitätsreihenfolge",
  "investigation": "Untersuchung",
  "feature": "Funktion",
  "fix": "Fehlerbehebung",
  "colors": {
    "red": "Rot",
    "amber": "Bernstein",
    "green": "Grün",
    "blue": "Blau",
    "violet": "Violett",
    "pink": "Rosa"
  }
};

export const sessionGroups = {
  title: "Gruppen", manage: "Verwalten…", name: "Gruppenname", add: "Gruppe hinzufügen", delete: "Gruppe löschen",
  deleteConfirm: "„{{name}}“ löschen und {{count}} Unterhaltungen nach Nicht gruppiert verschieben? Die Unterhaltungen bleiben erhalten.",
  ungrouped: "Nicht gruppiert", moveTo: "In Gruppe verschieben",
  description: "Jede Unterhaltung gehört zu einer Gruppe dieses Projekts. Beim Löschen einer Gruppe bleiben die Unterhaltungen erhalten.",
  labelsDescription: "Labels beschreiben Unterhaltungen, ohne sie zu gruppieren oder zu filtern. Änderungen gelten nur für dieses Projekt.",
  usage: "{{count}} Unterhaltungen", folders: "{{count}} Ordner", primary: "Primär",
};

export const sessionDelegation = {
  "title": "Subagent-Modelle",
  "customCount": "Subagent-Modelle: {{count}} ausgewählt",
  "scope": "Modellpool",
  "inherit": "Global übernehmen",
  "custom": "Benutzerdefiniert",
  "inheritHint": "Verwendet die globalen Delegierungseinstellungen.",
  "taskFitHint": "Modelle und Genehmigungsregeln nur für diese Unterhaltung festlegen; globale Einstellungen bleiben unverändert. Teilaufgaben werden anhand der Modellbeschreibungen zugeordnet.",
  "search": "Modelle suchen",
  "models": "Verfügbare Subagent-Modelle",
  "unavailable": "Nicht verfügbar",
  "approvalRequired": "Genehmigung erforderlich",
  "autoAllowed": "Automatisch erlaubt",
  "approvalFor": "Genehmigung für {{model}}",
  "noModels": "Keine passenden Modelle.",
  "selectedCount": "{{count}} Modelle ausgewählt",
  "disabled": "Delegierung ist für diese Unterhaltung deaktiviert.",
  "busy": "Die Auswahl kann gespeichert werden, wenn die Unterhaltung inaktiv ist.",
  "invalidSelection": "Nicht verfügbare Modelle vor dem Speichern entfernen.",
  "cancel": "Abbrechen",
  "save": "Speichern",
  "saving": "Wird gespeichert…"
};

export const delegationDetails = {
  "title": "Modellauswahl",
  "requested": "Angefordertes Modell",
  "reason": "Auswahlgrund",
  "actual": "Tatsächliches Modell",
  "scheduling": "Planungsentscheidungen",
  "resumedFrom": "Fortgesetzt von",
  "selected": "Ausgewählt",
  "skipped": "Übersprungen",
  "cancelled": "Abgebrochen"
};
