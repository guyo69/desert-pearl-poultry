/// <reference lib="webworker" />
// Solves the sign-in puzzle off the main thread.
import { solve } from './sha256';

self.onmessage = (e: MessageEvent<{ salt: string; bits: number }>) => {
  const { salt, bits } = e.data;
  const nonce = solve(salt, bits, (tries) => (self as unknown as Worker).postMessage({ progress: tries / 2 ** bits }));
  (self as unknown as Worker).postMessage({ nonce });
};
