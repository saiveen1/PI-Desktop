export const sessionLabels = {
  customColor: "Color personalizado", hexColor: "Color HEX", hue: "Tono", saturation: "Saturación", brightness: "Brillo",
  colorPreview: "Vista previa del color", invalidColor: "Introduce un color HEX válido (#RGB o #RRGGBB).",
  "title": "Etiquetas",
  "add": "Añadir etiqueta",
  "name": "Nombre de etiqueta",
  "color": "Color",
  "delete": "Eliminar etiqueta",
  "deleteConfirm": "¿Eliminar «{{name}}» y quitarla de {{count}} conversaciones? Se conservarán las conversaciones.",
  "moveUp": "Subir",
  "moveDown": "Bajar",
  "save": "Guardar",
  "cancel": "Cancelar",
  "none": "Sin etiquetas",
  "unclassified": "Sin clasificar",
  "manage": "Gestionar etiquetas",
  "filter": "Filtrar conversaciones",
  "clearFilters": "Borrar filtros",
  "allColors": "Todos los colores",
  "colorMark": "Marca de color",
  "clearColor": "Sin marca de color",
  "overflow": "{{count}} etiquetas más",
  "reorderBefore": "Mover antes de {{title}}",
  "reorderAfter": "Mover después de {{title}}",
  "activityOrder": "Orden de actividad",
  "investigation": "Investigación",
  "feature": "Función",
  "fix": "Corrección",
  "colors": {
    "red": "Rojo",
    "amber": "Ámbar",
    "green": "Verde",
    "blue": "Azul",
    "violet": "Violeta",
    "pink": "Rosa"
  }
};

export const sessionGroups = {
  title: "Grupos", manage: "Administrar…", name: "Nombre del grupo", add: "Añadir grupo", delete: "Eliminar grupo",
  deleteConfirm: "¿Eliminar «{{name}}» y mover {{count}} conversaciones a Sin grupo? Se conservarán las conversaciones.",
  ungrouped: "Sin grupo", moveTo: "Mover al grupo",
  description: "Cada conversación pertenece a un grupo de este proyecto. Eliminar un grupo no elimina sus conversaciones.",
  labelsDescription: "Las etiquetas describen conversaciones, sin agruparlas ni filtrarlas. Los cambios solo afectan a este proyecto.",
  usage: "{{count}} conversaciones", folders: "{{count}} carpetas", primary: "Principal",
};

export const sessionDelegation = {
  "title": "Modelos de subagentes",
  "customCount": "Modelos de subagentes: {{count}} seleccionados",
  "scope": "Conjunto de modelos",
  "inherit": "Seguir global",
  "custom": "Personalizado",
  "inheritHint": "Usa la configuración global de delegación.",
  "taskFitHint": "Elige modelos y reglas de aprobación solo para esta conversación, sin cambiar la configuración global. Las subtareas se asignan según las descripciones de los modelos.",
  "search": "Buscar modelos",
  "models": "Modelos de subagentes disponibles",
  "unavailable": "No disponible",
  "approvalRequired": "Requiere aprobación",
  "autoAllowed": "Permitido automáticamente",
  "approvalFor": "Aprobación para {{model}}",
  "noModels": "No hay modelos coincidentes.",
  "selectedCount": "{{count}} modelos seleccionados",
  "disabled": "La delegación está desactivada en esta conversación.",
  "busy": "La selección se puede guardar cuando la conversación esté inactiva.",
  "invalidSelection": "Quita los modelos no disponibles antes de guardar.",
  "cancel": "Cancelar",
  "save": "Guardar",
  "saving": "Guardando…"
};

export const delegationDetails = {
  "title": "Selección de modelo",
  "requested": "Modelo solicitado",
  "reason": "Motivo de selección",
  "actual": "Modelo utilizado",
  "scheduling": "Decisiones de programación",
  "selected": "Seleccionado",
  "skipped": "Omitido",
  "cancelled": "Cancelado"
};
