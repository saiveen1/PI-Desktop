/** Best effort only: never forward common credential shapes to the reviewer. */
export function redactObserverText(text: string, secrets: readonly string[] = [], maxChars?: number): string {
  let safe = text.replace(/-----BEGIN [^-\n]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-\n]*PRIVATE KEY-----|$)/g, "[REDACTED]")
    .replace(/\b(?:sk-[\w-]{8,}|gh[pousr]_[\w]{8,}|github_pat_[\w]{8,}|AKIA[A-Z0-9]{16}|eyJ[\w-]+\.[\w-]+\.[\w-]+)\b/g, "[REDACTED]")
    .replace(/\b(Bearer|Basic)\s+[\w+/.=:-]+/gi, "$1 [REDACTED]")
    .replace(/((?:api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|password|secret|cookie)[\s"']*[:=][\s"']*)[^\s,;"'}]+/gi, "$1[REDACTED]")
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, "$1[REDACTED]@");
  for (const secret of secrets) if (secret.length >= 4) safe = safe.split(secret).join("[REDACTED]");
  return safe.slice(0, maxChars).replace(/\p{Cs}/gu, "");
}

/** No model-authored instructions or loose substring matches enter execution. */
export function parseObserverDecision(text: string): "continue" | "stop" | undefined {
  if (text.length > 32) return;
  const value = text.trim().toLowerCase();
  return value === "continue" || value === "stop" ? value : undefined;
}
