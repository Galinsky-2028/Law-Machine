/** Small in-memory per-client token bucket for unauthenticated endpoints (bounded map). */
const buckets = new Map<string, { tokens: number; at: number }>();
export function rateLimit(request: Request, scope: string, perMinute: number): boolean {
  const ip = (request.headers.get('x-forwarded-for') ?? '').split(',')[0]!.trim().slice(0, 64) || 'local';
  const key = scope + ':' + ip;
  const now = Date.now();
  const b = buckets.get(key) ?? { tokens: perMinute, at: now };
  b.tokens = Math.min(perMinute, b.tokens + ((now - b.at) / 60000) * perMinute);
  b.at = now;
  if (buckets.size > 10000) buckets.clear();
  if (b.tokens < 1) { buckets.set(key, b); return false; }
  b.tokens -= 1;
  buckets.set(key, b);
  return true;
}
