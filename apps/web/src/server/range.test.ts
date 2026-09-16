import { describe, expect, it } from 'vitest';
import { parseRange } from './range';

describe('parseRange', () => {
  it('parses open, closed and suffix ranges', () => {
    expect(parseRange(null, 100)).toBeNull();
    expect(parseRange('bytes=0-9', 100)).toEqual({ start: 0, end: 9 });
    expect(parseRange('bytes=50-', 100)).toEqual({ start: 50, end: 99 });
    expect(parseRange('bytes=-10', 100)).toEqual({ start: 90, end: 99 });
    expect(parseRange('bytes=0-999', 100)).toEqual({ start: 0, end: 99 });
  });
  it('rejects malformed or unsatisfiable ranges', () => {
    expect(parseRange('bytes=-', 100)).toBe('invalid');
    expect(parseRange('items=0-1', 100)).toBe('invalid');
    expect(parseRange('bytes=100-', 100)).toBe('invalid');
    expect(parseRange('bytes=5-2', 100)).toBe('invalid');
  });
});
