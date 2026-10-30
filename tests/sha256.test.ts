import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { leadingZeroBits, sha256Words, solve } from '../src/lib/sha256';

const hex = (H: Uint32Array) => [...H].map((w) => (w >>> 0).toString(16).padStart(8, '0')).join('');
describe('puzzle SHA-256', () => {
  it('matches Node crypto for short and multi-block inputs', () => {
    for (const s of ['', 'abc', 'a'.repeat(55), 'a'.repeat(56), 'a'.repeat(64), 'x'.repeat(200), '0123456789abcdef0123456789abcdef:123456']) {
      expect(hex(sha256Words(s))).toBe(createHash('sha256').update(s).digest('hex'));
    }
  });
  it('solves a puzzle the server accepts', () => {
    const nonce = solve('a1b2c3', 12);
    const d = createHash('sha256').update(`a1b2c3:${nonce}`).digest();
    let bits = 0; for (const b of d) { if (b === 0) { bits += 8; continue; } bits += Math.clz32(b) - 24; break; }
    expect(bits).toBeGreaterThanOrEqual(12);
    expect(leadingZeroBits(new Uint32Array([0, 1]))).toBe(63);
  });
  it('is fast enough for a phone (17-bit puzzle)', () => {
    const t = Date.now(); let n = 0;
    while (Date.now() - t < 300) { sha256Words(`0123456789abcdef0123456789abcdef:${n++}`); }
    console.log(`${Math.round(n / 0.3).toLocaleString()} hashes/s here; 17 bits needs ~131k on average`);
    expect(n).toBeGreaterThan(1000);
  });
});
