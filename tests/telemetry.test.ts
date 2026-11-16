import { describe, expect, it } from 'vitest';
import { deviceOf, scrub } from '../src/lib/telemetry';

describe('problem notes', () => {
  it('blank anything personal', () => {
    const t = scrub('Failed for 0712 345 678 and +254712345678, jane.w@example.co.ke, receipt 4581276', 300);
    expect(t).not.toMatch(/0712|254712|jane|4581276/);
    expect(t).toContain('[number]'); expect(t).toContain('[email]');
    expect(scrub('Cannot read properties of undefined (reading "n") at line 42', 300)).toContain('line 42');   // short numbers stay
  });
  it('name the kind of device only', () => {
    expect(deviceOf('Mozilla/5.0 (Linux; Android 13; SM-A145F)')).toBe('Android');
    expect(deviceOf('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)')).toBe('iPhone');
    expect(deviceOf('Mozilla/5.0 (Windows NT 10.0; Win64; x64)')).toBe('Windows');
  });
});
