export const sessionLabels = {
  customColor: "Cor personalizada", hexColor: "Cor HEX", hue: "Matiz", saturation: "Saturação", brightness: "Brilho",
  colorPreview: "Prévia da cor", invalidColor: "Digite uma cor HEX válida (#RGB ou #RRGGBB).",
  "title": "Etiquetas",
  "add": "Adicionar etiqueta",
  "name": "Nome da etiqueta",
  "color": "Cor",
  "delete": "Excluir etiqueta",
  "deleteConfirm": "Excluir “{{name}}” e removê-la de {{count}} conversas? As conversas serão mantidas.",
  "moveUp": "Mover para cima",
  "moveDown": "Mover para baixo",
  "save": "Salvar",
  "cancel": "Cancelar",
  "none": "Sem etiquetas",
  "unclassified": "Sem classificação",
  "manage": "Gerenciar etiquetas",
  "filter": "Filtrar conversas",
  "clearFilters": "Limpar filtros",
  "allColors": "Todas as cores",
  "colorMark": "Marca de cor",
  "clearColor": "Sem marca de cor",
  "overflow": "Mais {{count}} etiquetas",
  "reorderBefore": "Mover antes de {{title}}",
  "reorderAfter": "Mover depois de {{title}}",
  "activityOrder": "Ordem de atividade",
  "investigation": "Investigação",
  "feature": "Funcionalidade",
  "fix": "Correção",
  "colors": {
    "red": "Vermelho",
    "amber": "Âmbar",
    "green": "Verde",
    "blue": "Azul",
    "violet": "Violeta",
    "pink": "Rosa"
  }
};

export const sessionGroups = {
  title: "Grupos", manage: "Gerenciar…", name: "Nome do grupo", add: "Adicionar grupo", delete: "Excluir grupo",
  deleteConfirm: "Excluir \"{{name}}\" e mover {{count}} conversas para Sem grupo? As conversas serão mantidas.",
  ungrouped: "Sem grupo", moveTo: "Mover para grupo",
  description: "Cada conversa pertence a um grupo deste projeto. Excluir um grupo mantém suas conversas.",
  labelsDescription: "As etiquetas descrevem conversas sem agrupá-las ou filtrá-las. As alterações se aplicam apenas a este projeto.",
  usage: "{{count}} conversas", folders: "{{count}} pastas", primary: "Principal",
};

export const sessionDelegation = {
  "title": "Modelos de subagentes",
  "customCount": "Modelos de subagentes: {{count}} selecionados",
  "scope": "Conjunto de modelos",
  "inherit": "Seguir global",
  "custom": "Personalizado",
  "inheritHint": "Usa as configurações globais de delegação.",
  "taskFitHint": "Escolha modelos e regras de aprovação apenas para esta conversa, sem alterar as configurações globais. As subtarefas são atribuídas conforme as descrições dos modelos.",
  "search": "Pesquisar modelos",
  "models": "Modelos de subagentes disponíveis",
  "unavailable": "Indisponível",
  "approvalRequired": "Requer aprovação",
  "autoAllowed": "Permitido automaticamente",
  "approvalFor": "Aprovação para {{model}}",
  "noModels": "Nenhum modelo correspondente.",
  "selectedCount": "{{count}} modelos selecionados",
  "disabled": "A delegação está desativada nesta conversa.",
  "busy": "A seleção pode ser salva quando a conversa estiver inativa.",
  "invalidSelection": "Remova os modelos indisponíveis antes de salvar.",
  "cancel": "Cancelar",
  "save": "Salvar",
  "saving": "Salvando…"
};

export const delegationDetails = {
  "title": "Seleção de modelo",
  "requested": "Modelo solicitado",
  "reason": "Motivo da seleção",
  "actual": "Modelo utilizado",
  "scheduling": "Decisões de agendamento",
  "selected": "Selecionado",
  "skipped": "Ignorado",
  "cancelled": "Cancelado"
};
