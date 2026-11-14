import type { PackRequest, PackResponse } from './pack-protocol.ts';
import { createPackHandler } from './pack-runtime.ts';

type Waiter = { resolve: (value: PackResponse) => void };
/**
 * Latest generation of each request kind wins. If the browser cannot start a
 * worker, the same verified SDK runs on the main thread and reports that mode.
 */
export class PackEngineClient {
  private worker: Worker | null = null;
  private generation = 0;
  private waiting = new Map<number, Waiter>();
  private latest = new Map<string, number>();
  readonly mode: 'worker' | 'main-thread';
  private inline: ((request: PackRequest) => Promise<void>) | null = null;
  constructor() {
    let worker: Worker | null = null;
    try { if (typeof Worker !== 'undefined') worker = new Worker(new URL('../workers/pack.worker.ts', import.meta.url), { type: 'module' }); } catch { worker = null; }
    this.worker = worker;
    this.mode = worker ? 'worker' : 'main-thread';
    if (worker) {
      worker.addEventListener('message', (event: MessageEvent<PackResponse>) => this.receive(event.data));
      worker.addEventListener('error', () => this.crash());
    } else this.inline = createPackHandler(message => queueMicrotask(() => this.receive(message)));
  }
  private receive(message: PackResponse) {
    const waiter = this.waiting.get(message?.generation);
    if (!waiter) return;
    this.waiting.delete(message.generation);
    waiter.resolve(message);
  }
  private crash() {
    this.worker?.terminate();
    this.worker = null;
    for (const [generation, waiter] of this.waiting) waiter.resolve({ type: 'error', generation, code: 'WORKER_CRASH', message: 'The simulation worker stopped. Reload the page to try again.' });
    this.waiting.clear();
  }
  /** Sends a request; an older request of the same kind is cancelled and resolves as superseded. */
  request(kind: string, build: (generation: number) => PackRequest): Promise<PackResponse | null> {
    const generation = ++this.generation;
    const previous = this.latest.get(kind);
    if (previous !== undefined) this.cancel(previous);
    this.latest.set(kind, generation);
    const message = build(generation);
    return new Promise(resolve => {
      this.waiting.set(generation, { resolve: value => resolve(this.latest.get(kind) === generation ? value : null) });
      if (this.worker) this.worker.postMessage(message);
      else if (this.inline) void this.inline(message);
      else resolve({ type: 'error', generation, code: 'ENGINE_UNAVAILABLE', message: 'The simulation engine is unavailable.' });
    });
  }
  cancel(generation: number) {
    const waiter = this.waiting.get(generation);
    this.waiting.delete(generation);
    if (this.worker) this.worker.postMessage({ type: 'cancel', generation } satisfies PackRequest);
    else void this.inline?.({ type: 'cancel', generation });
    waiter?.resolve({ type: 'error', generation, code: 'CANCELLED', message: 'Cancelled' });
  }
  /** Cancel whatever request of this kind is in flight; its promise resolves as superseded (null). */
  cancelKind(kind: string) {
    const generation = this.latest.get(kind);
    if (generation === undefined) return;
    this.latest.delete(kind);
    this.cancel(generation);
  }
  dispose() { this.worker?.terminate(); this.worker = null; this.waiting.clear(); }
}
