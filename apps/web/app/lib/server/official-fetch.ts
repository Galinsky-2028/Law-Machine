import { lookup } from 'node:dns/promises';
import { request } from 'node:https';
import { preflightOfficialDnsAddresses } from '../../../../../packages/legislation/src/official-network-policy.ts';

/**
 * LM-044/LM-049 SSRF-guarded fetch for official sources. Only allowlisted
 * official hosts, only HTTPS, every resolved address must be public IPv4, the
 * socket is pinned to the vetted address (TLS still verifies the hostname),
 * redirects are rejected, proxies are ignored, and bodies are size and time bounded.
 */
export type Resolver = (hostname: string) => Promise<string[]>;
export type FetchedSource = { readonly url: string; readonly bytes: Uint8Array; readonly contentType: string; readonly retrievedAt: string };
const defaultResolver: Resolver = async hostname => (await lookup(hostname, { all: true, family: 4 })).map(a => a.address);

export async function fetchOfficialSource(url: string, options: { resolver?: Resolver; maxBytes?: number; timeoutMs?: number; transport?: typeof request } = {}): Promise<FetchedSource> {
  const resolver = options.resolver ?? defaultResolver;
  const hostname = new URL(url).hostname;
  const pinned = preflightOfficialDnsAddresses(url, await resolver(hostname));
  const maxBytes = Math.min(options.maxBytes ?? 5_000_000, pinned.maximumBodyBytes);
  const transport = options.transport ?? request;
  return new Promise((resolve, reject) => {
    const req = transport(pinned.url, {
      method: 'GET', agent: false, timeout: options.timeoutMs ?? 15000,
      headers: { 'user-agent': 'LawMachine-SourceRefresh/1.0', accept: 'text/plain, text/html, application/xml, text/xml;q=0.9' },
      lookup: (_host: string, _opts: unknown, cb: (err: Error | null, address: string, family: number) => void) => cb(null, pinned.pinnedIpv4, 4),
      servername: pinned.hostname
    }, res => {
      if ((res.statusCode ?? 0) >= 300 && (res.statusCode ?? 0) < 400) { res.resume(); reject(Error('SOURCE_REDIRECT_REJECTED')); return; }
      if (res.statusCode !== 200) { res.resume(); reject(Error('SOURCE_HTTP_' + res.statusCode)); return; }
      const declared = Number(res.headers['content-length'] ?? '0');
      if (declared > maxBytes) { res.destroy(); reject(Error('SOURCE_TOO_LARGE')); return; }
      const chunks: Buffer[] = [];
      let size = 0;
      res.on('data', (chunk: Buffer) => { size += chunk.length; if (size > maxBytes) { res.destroy(); reject(Error('SOURCE_TOO_LARGE')); return; } chunks.push(chunk); });
      res.on('end', () => resolve({ url: pinned.url, bytes: new Uint8Array(Buffer.concat(chunks)), contentType: String(res.headers['content-type'] ?? ''), retrievedAt: new Date().toISOString() }));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(Error('SOURCE_TIMEOUT')));
    req.on('error', reject);
    req.end();
  });
}
