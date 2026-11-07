/** A generic gateway wrapper supplies no evidence of a repairable or permanent cause. */
export function isUnknownUpstreamWrapper(message: string, status: number | undefined): boolean {
  if (status !== 400 && status !== 422) return false;
  const start = message.indexOf("{");
  if (start < 0) return false;
  let body: unknown;
  try { body = JSON.parse(message.slice(start)); } catch { return false; }
  if (!body || typeof body !== "object" || Array.isArray(body)) return false;
  const envelope = body as Record<string, unknown>;
  if (envelope.error !== undefined && Object.keys(envelope).some(key => key !== "error")) return false;
  const error = envelope.error ?? envelope;
  if (!error || typeof error !== "object" || Array.isArray(error)) return false;
  const fields = error as Record<string, unknown>;
  // Detailed errors must retain their own recovery path even under the same code.
  if (Object.keys(fields).some(key => !["code", "message", "type"].includes(key))) return false;
  if (fields.type !== undefined && !["api_error", "upstream_error", "gateway_error", "server_error"].includes(String(fields.type))) return false;
  return fields.code === `upstream_${status}` && typeof fields.message === "string" &&
    new RegExp(`^Upstream returned (?:HTTP )?status(?: code)? ${status}\\.?$`, "i").test(fields.message.trim());
}
