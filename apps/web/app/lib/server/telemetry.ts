/**
 * LM-052 structured operational telemetry. Only allowlisted, non-content fields
 * are ever written: no scenario facts, source text, request bodies, cookies or
 * tokens. Logs go to stdout as one JSON object per line.
 */
const ALLOWED = new Set(['requestId', 'packId', 'releaseId', 'valid', 'reason', 'route', 'status', 'durationMs', 'jobId', 'jobKind', 'attempt', 'state', 'organizationId', 'count', 'lagSeconds', 'code', 'mode', 'provider', 'kind']);
const counters = new Map<string, number>();
const started = Date.now();
export function requestId(request: Request): string {
  const supplied = request.headers.get('x-request-id');
  return supplied && /^[A-Za-z0-9-]{8,64}$/.test(supplied) ? supplied : crypto.randomUUID();
}
export function redact(fields: Record<string, unknown>): Record<string, string | number | boolean | null> {
  const out: Record<string, string | number | boolean | null> = {};
  for (const [k, v] of Object.entries(fields)) {
    if (!ALLOWED.has(k)) continue;
    if (v === null || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v))) out[k] = v as number | boolean | null;
    else if (typeof v === 'string') out[k] = v.replace(/[^\w.:@/-]/g, '').slice(0, 120);
  }
  return out;
}
export function logEvent(event: string, fields: Record<string, unknown> = {}, level: 'info' | 'warn' | 'error' = 'info'): void {
  if (!/^[a-z][a-z0-9_.-]{0,60}$/.test(event)) return;
  counters.set(event, (counters.get(event) ?? 0) + 1);
  if (process.env.LM_LOG_SILENT === '1') return;
  const line = JSON.stringify({ ts: new Date().toISOString(), level, event, ...redact(fields) });
  if (level === 'error') console.error(line); else console.log(line);
}
export function counterSnapshot(): { readonly uptimeSeconds: number; readonly events: Readonly<Record<string, number>> } {
  return { uptimeSeconds: Math.round((Date.now() - started) / 1000), events: Object.fromEntries([...counters].sort()) };
}
