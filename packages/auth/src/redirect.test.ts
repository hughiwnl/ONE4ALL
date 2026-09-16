import { describe, expect, it } from 'vitest';
import { safeRedirectPath } from './redirect.js';

describe('safeRedirectPath', () => {
  it('keeps relative paths and rejects external or protocol-relative URLs', () => {
    expect(safeRedirectPath('/accounts?x=1')).toBe('/accounts?x=1');
    expect(safeRedirectPath('https://evil.example')).toBe('/dashboard');
    expect(safeRedirectPath('//evil.example')).toBe('/dashboard');
    expect(safeRedirectPath('/\\evil.example')).toBe('/dashboard');
    expect(safeRedirectPath(null)).toBe('/dashboard');
  });
});
