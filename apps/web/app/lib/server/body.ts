/** Read a request body with a hard byte cap, independent of any client-supplied Content-Length. */
export class BodyTooLarge extends Error { constructor() { super('REQUEST_TOO_LARGE'); } }
export async function readBounded(request: Request, maxBytes: number): Promise<Uint8Array> {
  const declared = Number(request.headers.get('content-length') ?? '0');
  if (declared > maxBytes) throw new BodyTooLarge();
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) { await reader.cancel().catch(() => undefined); throw new BodyTooLarge(); }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.byteLength; }
  return out;
}
export async function readText(request: Request, maxBytes: number): Promise<string> {
  return new TextDecoder('utf-8', { fatal: false }).decode(await readBounded(request, maxBytes));
}
/** Parse multipart form data from an already bounded body. */
export async function readForm(request: Request, maxBytes: number): Promise<FormData> {
  const bytes = await readBounded(request, maxBytes);
  return new Response(Buffer.from(bytes), { headers: { 'content-type': request.headers.get('content-type') ?? '' } }).formData();
}
