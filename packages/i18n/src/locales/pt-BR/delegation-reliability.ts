export const delegationReliabilitySettings = {
  "delegationRunReportRecovery": "Recuperar relatório final ausente",
  "delegationRunReportRecoveryDesc": "Se uma subtarefa terminar sem relatório, solicitar uma vez um relatório sem ferramentas. O prazo configurado se aplica e pode haver uso adicional da API.",
  "delegationRunReportRecoveryOnce": "Uma vez",
  "delegationRunReportRecoveryOff": "Desativado",
  "unknownUpstreamRetryLimit": "Repetições de erros upstream desconhecidos",
  "unknownUpstreamRetryLimitDesc": "Repete erros upstream genéricos 400/422 até este limite por resposta. 0 desativa a recuperação; repetições ilimitadas não alteram este limite."
};

export const delegationDiagnostics = {
  "title": "Detalhes da delegação",
  "requestedModel": "Modelo solicitado",
  "actualModel": "Modelo utilizado",
  "activity": "Atividade",
  "activityCounts": "{{turns}} rodadas · {{tools}} chamadas de ferramentas",
  "stopReason": "Motivo do término",
  "reportOutcome": "Resultado do relatório",
  "responseStructure": "Estrutura da resposta",
  "responseCounts": "{{text}} texto · {{thinking}} raciocínio · {{tools}} ferramentas",
  "recoveryAttempts": "Tentativas de relatório",
  "failure": "Falha",
  "selection": "Seleção do modelo",
  "modelFailures": "Falhas de modelos",
  "selected": "Selecionado",
  "skipped": "Ignorado",
  "cancelled": "Cancelado",
  "retry": "Recuperação",
  "retryAttempt": "Tentativa {{attempt}} / {{limit}}",
  "stopReasons": {
    "stop": "Término normal",
    "tool_calls": "Solicitação de ferramenta",
    "length": "Limite de saída",
    "error": "Erro",
    "aborted": "Cancelado",
    "unknown": "Não registrado"
  },
  "reportOutcomes": {
    "delivered": "Relatório entregue",
    "missing": "Sem relatório final",
    "truncated": "Relatório truncado",
    "invalid_tool_ending": "Término de ferramenta inválido",
    "error": "Falha",
    "cancelled": "Cancelado"
  }
};
