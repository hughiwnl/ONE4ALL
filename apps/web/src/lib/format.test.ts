import { describe, expect, it } from 'vitest';
import { formatBytes, formatDuration, platformLabel } from './format';

describe('format helpers', () => {
  it('formats bytes and durations', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(3 * 1024 * 1024 * 1024)).toBe('3.0 GB');
    expect(formatDuration(65)).toBe('1:05');
    expect(formatDuration(3725)).toBe('1:02:05');
    expect(formatDuration(null)).toBe('—');
  });
  it('labels known and unknown platforms', () => {
    expect(platformLabel('youtube')).toBe('YouTube');
    expect(platformLabel('tiktok')).toBe('TikTok');
    expect(platformLabel('newthing')).toBe('Newthing');
  });
});
