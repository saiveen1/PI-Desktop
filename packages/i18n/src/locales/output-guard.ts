type Copy = {
  title: string; description: string; mode: string; modeDesc: string; off: string; warn: string; continue: string;
  recoveryLimit: string; recoveryDesc: string; symbolGuard: string; paragraphGuard: string;
  checklistDesc: string;
  symbolMinChars: string; symbolMinLines: string; symbolSingleLineChars: string; repeatedParagraphMinChars: string;
  repeatedParagraphMinRepeats: string; range: string; suspected: string; exhausted: string;
  normalizedReason: string; outputTokens: string; maxOutputTokens: string; recoveryAttempts: string;
  reason: { stop: string; length: string; toolUse: string; aborted: string; error: string; unknown: string };
};
export const outputGuard: Record<"en" | "zh-CN" | "zh-TW" | "de" | "es" | "fr" | "ko" | "pt-BR" | "tr", Copy> = {
  en: {
    title: "Local output guards", description: "Local checks normally add no reviewer or main-prompt overhead. Automatic continuations can add billed model requests. Changes apply from the next user turn.",
    mode: "Possible early ending", modeDesc: "Choose whether to ignore, warn, or automatically continue when an answer may have ended early.", off: "Off", warn: "Warn", continue: "Continue",
    recoveryLimit: "Shared correction allowance", recoveryDesc: "Shared by early-end, checklist and printed-tool-call corrections; one request by default. Zero disables these continuations, not transport retries. The checklist switch controls its participation.",
    checklistDesc: "Continue when this turn's TodoWrite list has unfinished items, within the shared correction allowance (default one). Stop still ends the turn. Changes apply next turn; continuations may incur extra model requests.",
    symbolGuard: "Repetitive-output protection", paragraphGuard: "Detect repeated paragraphs", symbolMinChars: "Symbol minimum characters", symbolMinLines: "Symbol minimum lines", symbolSingleLineChars: "Single-line symbol characters", repeatedParagraphMinChars: "Repeated paragraph minimum characters", repeatedParagraphMinRepeats: "Minimum paragraph repeats", range: "Enter a whole number from {{min}} to {{max}}.",
    suspected: "This answer may have ended early. You can ask the agent to continue or clarify in a follow-up.", exhausted: "This answer may have ended early, and automatic correction attempts were exhausted. You can ask the agent to continue or clarify in a follow-up.",
    normalizedReason: "Normalized termination reason", outputTokens: "Output tokens", maxOutputTokens: "Maximum output tokens", recoveryAttempts: "Correction attempts", reason: { stop: "Stop", length: "Length", toolUse: "Tool use", aborted: "Aborted", error: "Error", unknown: "Unknown" },
  },
  "zh-CN": {
    title: "本地输出防护", description: "本地检查通常不增加审查模型或主提示词开销。自动续跑可能产生额外计费的模型请求；更改从下一轮用户输入生效。",
    mode: "可能提前结束", modeDesc: "选择忽略、警告或在回答可能提前结束时自动续跑。", off: "关闭", warn: "警告", continue: "续跑",
    recoveryLimit: "共享纠正次数", recoveryDesc: "提前结束、清单续跑和文本工具调用纠正共用此额度，默认一次。零会禁用这些续跑，但不影响传输重试；清单开关控制是否参与。",
    checklistDesc: "本轮 TodoWrite 清单仍有未完成事项时，在共享纠正额度内续跑，默认一次。仍可随时停止；更改从下一轮生效，续跑可能产生额外模型请求。",
    symbolGuard: "重复输出保护", paragraphGuard: "检测重复段落", symbolMinChars: "符号最少字符数", symbolMinLines: "符号最少行数", symbolSingleLineChars: "单行符号字符数", repeatedParagraphMinChars: "重复段落最少字符数", repeatedParagraphMinRepeats: "段落最少重复次数", range: "请输入 {{min}} 到 {{max}} 之间的整数。",
    suspected: "回答可能提前结束。你可以通过后续消息要求继续或澄清。", exhausted: "回答可能提前结束，自动纠正次数已用尽。你可以通过后续消息要求继续或澄清。",
    normalizedReason: "标准化结束原因", outputTokens: "输出令牌数", maxOutputTokens: "输出令牌上限", recoveryAttempts: "纠正尝试次数", reason: { stop: "停止", length: "长度", toolUse: "工具调用", aborted: "已中止", error: "错误", unknown: "未知" },
  },
  "zh-TW": {
    title: "本機輸出防護", description: "本機檢查通常不增加審查模型或主要提示詞負擔。自動續跑可能增加計費的模型請求；變更從下一輪使用者輸入生效。",
    mode: "可能提前結束", modeDesc: "選擇忽略、警告或在回答可能提前結束時自動續跑。", off: "關閉", warn: "警告", continue: "續跑",
    recoveryLimit: "共用修正次數", recoveryDesc: "提前結束、清單續跑和文字工具呼叫修正共用此額度，預設一次。零會停用這些續跑，但不影響傳輸重試；清單開關控制是否參與。",
    checklistDesc: "本輪 TodoWrite 清單仍有未完成事項時，在共用修正額度內續跑，預設一次。仍可隨時停止；變更從下一輪生效，續跑可能增加模型請求。",
    symbolGuard: "重複輸出保護", paragraphGuard: "偵測重複段落", symbolMinChars: "符號最少字元數", symbolMinLines: "符號最少行數", symbolSingleLineChars: "單行符號字元數", repeatedParagraphMinChars: "重複段落最少字元數", repeatedParagraphMinRepeats: "段落最少重複次數", range: "請輸入 {{min}} 至 {{max}} 之間的整數。",
    suspected: "回答可能提前結束。你可以在後續訊息中要求繼續或釐清。", exhausted: "回答可能提前結束，且自動修正次數已用盡。你可以在後續訊息中要求繼續或釐清。",
    normalizedReason: "標準化結束原因", outputTokens: "輸出權杖數", maxOutputTokens: "輸出權杖上限", recoveryAttempts: "修正嘗試次數", reason: { stop: "停止", length: "長度", toolUse: "工具呼叫", aborted: "已中止", error: "錯誤", unknown: "未知" },
  },
  de: {
    title: "Lokale Ausgabeschutzmechanismen", description: "Lokale Prüfungen verursachen normalerweise keinen Aufwand für Prüfer oder Hauptprompt. Automatische Fortsetzungen können kostenpflichtige Modellanfragen erzeugen. Änderungen gelten ab der nächsten Benutzernachricht.",
    mode: "Mögliches vorzeitiges Ende", modeDesc: "Möglicherweise vorzeitig beendete Antworten ignorieren, warnen oder automatisch fortsetzen.", off: "Aus", warn: "Warnen", continue: "Fortsetzen",
    recoveryLimit: "Gemeinsames Korrekturlimit", recoveryDesc: "Gemeinsam für vorzeitige Enden, Checklisten und als Text ausgegebene Werkzeugaufrufe; standardmäßig eine Anfrage. Null deaktiviert diese Fortsetzungen, nicht Transportwiederholungen. Der Checklisten-Schalter steuert ihre Teilnahme.",
    checklistDesc: "Offene TodoWrite-Punkte dieses Laufs innerhalb des gemeinsamen Korrekturlimits fortsetzen, standardmäßig einmal. Stopp beendet den Lauf. Änderungen gelten ab dem nächsten Lauf; zusätzliche Modellanfragen können Kosten verursachen.",
    symbolGuard: "Schutz vor wiederholter Ausgabe", paragraphGuard: "Wiederholte Absätze erkennen", symbolMinChars: "Mindestzeichen für Symbole", symbolMinLines: "Mindestzeilen für Symbole", symbolSingleLineChars: "Zeichen für einzeilige Symbole", repeatedParagraphMinChars: "Mindestzeichen pro wiederholtem Absatz", repeatedParagraphMinRepeats: "Mindestwiederholungen von Absätzen", range: "Ganze Zahl zwischen {{min}} und {{max}} eingeben.",
    suspected: "Diese Antwort könnte vorzeitig beendet sein. Bitte den Agenten in einer Folgenachricht um Fortsetzung oder Klärung.", exhausted: "Diese Antwort könnte vorzeitig beendet sein; automatische Korrekturversuche sind aufgebraucht. Bitte den Agenten in einer Folgenachricht um Fortsetzung oder Klärung.",
    normalizedReason: "Normalisierter Beendigungsgrund", outputTokens: "Ausgabetoken", maxOutputTokens: "Maximale Ausgabetoken", recoveryAttempts: "Korrekturversuche", reason: { stop: "Stopp", length: "Länge", toolUse: "Werkzeugnutzung", aborted: "Abgebrochen", error: "Fehler", unknown: "Unbekannt" },
  },
  es: {
    title: "Protecciones locales de salida", description: "Las comprobaciones locales normalmente no añaden carga de revisión ni al prompt principal. Las continuaciones automáticas pueden generar solicitudes de pago. Los cambios se aplican desde el siguiente turno del usuario.",
    mode: "Posible final prematuro", modeDesc: "Ignorar, advertir o continuar automáticamente si una respuesta puede haber terminado antes de tiempo.", off: "Desactivado", warn: "Advertir", continue: "Continuar",
    recoveryLimit: "Límite compartido de correcciones", recoveryDesc: "Compartido entre finales prematuros, listas pendientes y llamadas a herramientas escritas como texto; una solicitud por defecto. Cero desactiva estas continuaciones, no los reintentos de transporte. El interruptor de listas controla su participación.",
    checklistDesc: "Continuar los puntos TodoWrite pendientes de este turno dentro del límite compartido, una vez por defecto. Detener termina el turno. Los cambios se aplican al siguiente turno y pueden añadir solicitudes de pago.",
    symbolGuard: "Protección contra salida repetitiva", paragraphGuard: "Detectar párrafos repetidos", symbolMinChars: "Caracteres mínimos de símbolos", symbolMinLines: "Líneas mínimas de símbolos", symbolSingleLineChars: "Caracteres de símbolos en una línea", repeatedParagraphMinChars: "Caracteres mínimos de párrafo repetido", repeatedParagraphMinRepeats: "Repeticiones mínimas de párrafo", range: "Introduce un entero entre {{min}} y {{max}}.",
    suspected: "Esta respuesta puede haber terminado antes de tiempo. Puedes pedir al agente que continúe o aclare en un mensaje posterior.", exhausted: "Esta respuesta puede haber terminado antes de tiempo y se agotaron los intentos de corrección. Puedes pedir al agente que continúe o aclare en un mensaje posterior.",
    normalizedReason: "Motivo de finalización normalizado", outputTokens: "Tokens de salida", maxOutputTokens: "Máximo de tokens de salida", recoveryAttempts: "Intentos de corrección", reason: { stop: "Parada", length: "Longitud", toolUse: "Uso de herramienta", aborted: "Cancelado", error: "Error", unknown: "Desconocido" },
  },
  fr: {
    title: "Protections locales de sortie", description: "Les vérifications locales n’ajoutent normalement aucune charge de révision ni au prompt principal. Les continuations automatiques peuvent entraîner des requêtes facturées. Les modifications prennent effet au prochain tour utilisateur.",
    mode: "Fin éventuellement prématurée", modeDesc: "Ignorer, avertir ou poursuivre automatiquement si une réponse semble s’être arrêtée trop tôt.", off: "Désactivé", warn: "Avertir", continue: "Continuer",
    recoveryLimit: "Quota partagé de corrections", recoveryDesc: "Partagé entre fins prématurées, listes inachevées et appels d’outils écrits en texte ; une requête par défaut. Zéro désactive ces continuations, pas les nouvelles tentatives de transport. Le commutateur des listes contrôle leur participation.",
    checklistDesc: "Continuer les éléments TodoWrite inachevés de ce tour dans le quota partagé, une fois par défaut. Arrêter termine le tour. Les changements prennent effet au prochain tour ; les continuations peuvent être facturées.",
    symbolGuard: "Protection contre les sorties répétitives", paragraphGuard: "Détecter les paragraphes répétés", symbolMinChars: "Caractères minimaux de symboles", symbolMinLines: "Lignes minimales de symboles", symbolSingleLineChars: "Caractères de symboles sur une ligne", repeatedParagraphMinChars: "Caractères minimaux du paragraphe répété", repeatedParagraphMinRepeats: "Répétitions minimales de paragraphe", range: "Saisissez un entier entre {{min}} et {{max}}.",
    suspected: "Cette réponse s’est peut-être terminée trop tôt. Vous pouvez demander à l’agent de continuer ou de préciser dans un message ultérieur.", exhausted: "Cette réponse s’est peut-être terminée trop tôt et les tentatives de correction sont épuisées. Vous pouvez demander à l’agent de continuer ou de préciser dans un message ultérieur.",
    normalizedReason: "Motif de fin normalisé", outputTokens: "Jetons de sortie", maxOutputTokens: "Maximum de jetons de sortie", recoveryAttempts: "Tentatives de correction", reason: { stop: "Arrêt", length: "Longueur", toolUse: "Utilisation d’outil", aborted: "Interrompu", error: "Erreur", unknown: "Inconnu" },
  },
  ko: {
    title: "로컬 출력 보호", description: "로컬 검사는 일반적으로 검토 모델이나 기본 프롬프트에 추가 부담을 주지 않습니다. 자동 계속은 유료 모델 요청을 추가할 수 있습니다. 변경 사항은 다음 사용자 턴부터 적용됩니다.",
    mode: "조기 종료 가능성", modeDesc: "응답이 일찍 끝났을 때 무시, 경고 또는 자동 계속을 선택합니다.", off: "끄기", warn: "경고", continue: "계속",
    recoveryLimit: "공유 수정 허용 횟수", recoveryDesc: "조기 종료, 미완료 목록, 텍스트로 출력된 도구 호출 수정이 공유하며 기본값은 한 번입니다. 0은 이 계속만 끄며 전송 재시도에는 영향이 없습니다. 목록 스위치는 목록의 참여를 제어합니다.",
    checklistDesc: "이번 턴의 미완료 TodoWrite 항목을 공유 수정 한도 내에서 계속합니다. 기본값은 한 번이며 중지로 종료할 수 있습니다. 변경은 다음 턴부터 적용되고 추가 모델 요청 비용이 발생할 수 있습니다.",
    symbolGuard: "반복 출력 보호", paragraphGuard: "반복 문단 감지", symbolMinChars: "기호 최소 문자 수", symbolMinLines: "기호 최소 줄 수", symbolSingleLineChars: "한 줄 기호 문자 수", repeatedParagraphMinChars: "반복 문단 최소 문자 수", repeatedParagraphMinRepeats: "최소 문단 반복 횟수", range: "{{min}}부터 {{max}}까지의 정수를 입력하세요.",
    suspected: "이 응답이 일찍 끝났을 수 있습니다. 후속 메시지에서 에이전트에게 계속하거나 설명해 달라고 요청할 수 있습니다.", exhausted: "이 응답이 일찍 끝났을 수 있으며 자동 수정 시도 횟수를 모두 사용했습니다. 후속 메시지에서 계속하거나 설명해 달라고 요청할 수 있습니다.",
    normalizedReason: "정규화된 종료 이유", outputTokens: "출력 토큰", maxOutputTokens: "최대 출력 토큰", recoveryAttempts: "수정 시도 횟수", reason: { stop: "중지", length: "길이", toolUse: "도구 사용", aborted: "중단됨", error: "오류", unknown: "알 수 없음" },
  },
  "pt-BR": {
    title: "Proteções locais de saída", description: "As verificações locais normalmente não adicionam carga de revisão nem ao prompt principal. Continuações automáticas podem gerar solicitações cobradas. As alterações valem a partir do próximo turno do usuário.",
    mode: "Possível término antecipado", modeDesc: "Ignore, avise ou continue automaticamente quando uma resposta puder ter terminado cedo.", off: "Desligado", warn: "Avisar", continue: "Continuar",
    recoveryLimit: "Limite compartilhado de correções", recoveryDesc: "Compartilhado entre términos antecipados, listas pendentes e chamadas de ferramentas em texto; uma solicitação por padrão. Zero desativa essas continuações, não as tentativas de transporte. O controle de listas define sua participação.",
    checklistDesc: "Continuar itens TodoWrite pendentes deste turno dentro do limite compartilhado, uma vez por padrão. Parar encerra o turno. Mudanças valem no próximo turno; continuações podem gerar solicitações cobradas.",
    symbolGuard: "Proteção contra saída repetitiva", paragraphGuard: "Detectar parágrafos repetidos", symbolMinChars: "Mínimo de caracteres de símbolos", symbolMinLines: "Mínimo de linhas de símbolos", symbolSingleLineChars: "Caracteres de símbolos em uma linha", repeatedParagraphMinChars: "Mínimo de caracteres do parágrafo repetido", repeatedParagraphMinRepeats: "Mínimo de repetições de parágrafo", range: "Digite um inteiro entre {{min}} e {{max}}.",
    suspected: "Esta resposta pode ter terminado cedo. Você pode pedir ao agente para continuar ou esclarecer em uma mensagem seguinte.", exhausted: "Esta resposta pode ter terminado cedo e as tentativas de correção se esgotaram. Você pode pedir ao agente para continuar ou esclarecer em uma mensagem seguinte.",
    normalizedReason: "Motivo de término normalizado", outputTokens: "Tokens de saída", maxOutputTokens: "Máximo de tokens de saída", recoveryAttempts: "Tentativas de correção", reason: { stop: "Parada", length: "Comprimento", toolUse: "Uso de ferramenta", aborted: "Abortado", error: "Erro", unknown: "Desconhecido" },
  },
  tr: {
    title: "Yerel çıktı korumaları", description: "Yerel denetimler normalde inceleyiciye veya ana isteme ek yük getirmez. Otomatik devamlar ücretli model istekleri ekleyebilir. Değişiklikler sonraki kullanıcı turunda uygulanır.",
    mode: "Olası erken bitiş", modeDesc: "Yanıt erken bitmiş olabilirse yok saymayı, uyarmayı veya otomatik devam etmeyi seçin.", off: "Kapalı", warn: "Uyar", continue: "Devam et",
    recoveryLimit: "Paylaşılan düzeltme hakkı", recoveryDesc: "Erken bitiş, tamamlanmamış liste ve metin olarak yazılan araç çağrısı düzeltmeleri paylaşır; varsayılan bir istektir. Sıfır bu devamları kapatır, taşıma yeniden denemelerini değil. Liste anahtarı katılımını belirler.",
    checklistDesc: "Bu turdaki tamamlanmamış TodoWrite öğelerini paylaşılan düzeltme sınırı içinde sürdürür; varsayılan bir kezdir. Durdur turu bitirir. Değişiklikler sonraki turda geçerlidir ve devamlar ek ücretli istek oluşturabilir.",
    symbolGuard: "Yinelenen çıktı koruması", paragraphGuard: "Yinelenen paragrafları algıla", symbolMinChars: "En az sembol karakteri", symbolMinLines: "En az sembol satırı", symbolSingleLineChars: "Tek satır sembol karakteri", repeatedParagraphMinChars: "Yinelenen paragrafın en az karakteri", repeatedParagraphMinRepeats: "En az paragraf tekrarı", range: "{{min}} ile {{max}} arasında bir tam sayı girin.",
    suspected: "Bu yanıt erken bitmiş olabilir. Bir takip mesajında ajandan devam etmesini veya açıklama yapmasını isteyebilirsiniz.", exhausted: "Bu yanıt erken bitmiş olabilir ve otomatik düzeltme denemeleri tükendi. Bir takip mesajında devam etmesini veya açıklama yapmasını isteyebilirsiniz.",
    normalizedReason: "Normalleştirilmiş bitiş nedeni", outputTokens: "Çıktı belirteçleri", maxOutputTokens: "En fazla çıktı belirteci", recoveryAttempts: "Düzeltme denemeleri", reason: { stop: "Dur", length: "Uzunluk", toolUse: "Araç kullanımı", aborted: "İptal edildi", error: "Hata", unknown: "Bilinmiyor" },
  },
};
