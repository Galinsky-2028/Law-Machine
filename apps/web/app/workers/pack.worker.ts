import { createPackHandler } from '../lib/pack-runtime.ts';
import type { PackRequest, PackResponse } from '../lib/pack-protocol.ts';

const port = self as unknown as { postMessage(message: PackResponse): void; addEventListener(type: 'message', handler: (event: MessageEvent<PackRequest>) => void): void };
const handle = createPackHandler(message => port.postMessage(message));
port.addEventListener('message', event => { void handle(event.data); });
