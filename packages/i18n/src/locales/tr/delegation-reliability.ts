export const delegationReliabilitySettings = {
  providerStreamIdleTimeout: "Model bağlantısı boşta kalma zaman aşımı",
  providerStreamIdleTimeoutDesc: "Yalnızca seçilen süre boyunca yanıt verisi gelmezse iptal eder. Uzun düşünme tek başına isteği yeniden başlatmaz. Sonraki turda uygulanır; kapalıyken takılan isteği elle durdurun.",
  providerStreamIdleTimeoutDisabled: "Devre dışı",
  providerStreamIdleTimeoutMinutes: "{{count}} dakika",
  "delegationRunReportRecovery": "Eksik son raporu tamamla",
  "delegationRunReportRecoveryDesc": "Alt görev raporsuz biterse araç kullanmadan bir kez rapor iste. Yapılandırılmış rapor süresi uygulanır ve API kullanımı artabilir.",
  "delegationRunReportRecoveryOnce": "Bir kez",
  "delegationRunReportRecoveryOff": "Kapalı",
  "unknownUpstreamRetryLimit": "Bilinmeyen üst sunucu hatası denemeleri",
  "unknownUpstreamRetryLimitDesc": "Genel üst sunucu 400/422 hatalarını yanıt başına bu sınıra kadar yeniden dene. 0 kurtarmayı kapatır; sınırsız yeniden deneme bu sınırı değiştirmez."
};

export const delegationDiagnostics = {
  "title": "Görevlendirme ayrıntıları",
  "requestedModel": "İstenen model",
  "actualModel": "Kullanılan model",
  "activity": "Etkinlik",
  "activityCounts": "{{turns}} tur · {{tools}} araç çağrısı",
  "stopReason": "Bitiş nedeni",
  "reportOutcome": "Rapor sonucu",
  "responseStructure": "Yanıt yapısı",
  "responseCounts": "{{text}} metin · {{thinking}} düşünme · {{tools}} araç",
  "recoveryAttempts": "Rapor kurtarma denemeleri",
  "failure": "Hata",
  "selection": "Model seçimi",
  "modelFailures": "Model hataları",
  "selected": "Seçildi",
  "skipped": "Atlandı",
  "cancelled": "İptal edildi",
  "retry": "Kurtarma",
  "retryAttempt": "Deneme {{attempt}} / {{limit}}",
  "stopReasons": {
    "stop": "Normal bitiş",
    "tool_calls": "Araç isteği",
    "length": "Çıktı sınırı",
    "error": "Hata",
    "aborted": "İptal edildi",
    "unknown": "Kaydedilmedi"
  },
  "reportOutcomes": {
    "delivered": "Rapor teslim edildi",
    "missing": "Son rapor yok",
    "truncated": "Rapor kesildi",
    "invalid_tool_ending": "Geçersiz araç bitişi",
    "error": "Başarısız",
    "cancelled": "İptal edildi"
  }
};
