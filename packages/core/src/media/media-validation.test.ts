import { describe, expect, it } from 'vitest';
import { sanitizeFilename, sniffVideoHeader, validateUpload } from './media-validation.js';

const MB = 1024 * 1024;

describe('validateUpload', () => {
  it('accepts a normal mp4', () => {
    const result = validateUpload({
      filename: 'clip.MP4',
      mimeType: 'video/mp4',
      declaredSizeBytes: 5 * MB,
      maxSizeBytes: 100 * MB,
    });
    expect(result).toMatchObject({
      ok: true,
      extension: 'mp4',
      mimeType: 'video/mp4',
      safeFilename: 'clip.MP4',
    });
  });
  it('rejects non-video mime types', () => {
    expect(
      validateUpload({ filename: 'a.mp4', mimeType: 'application/octet-stream', maxSizeBytes: MB }),
    ).toMatchObject({ ok: false, code: 'invalid_type' });
    expect(
      validateUpload({ filename: 'a.png', mimeType: 'image/png', maxSizeBytes: MB }),
    ).toMatchObject({ ok: false, code: 'invalid_type' });
  });
  it('rejects extensions that do not match the declared type', () => {
    expect(
      validateUpload({ filename: 'a.exe', mimeType: 'video/mp4', maxSizeBytes: MB }),
    ).toMatchObject({ ok: false, code: 'invalid_extension' });
    expect(
      validateUpload({ filename: 'a.webm', mimeType: 'video/mp4', maxSizeBytes: MB }),
    ).toMatchObject({ ok: false, code: 'invalid_extension' });
  });
  it('rejects oversized and empty files', () => {
    expect(
      validateUpload({
        filename: 'a.mp4',
        mimeType: 'video/mp4',
        declaredSizeBytes: 2 * MB,
        maxSizeBytes: MB,
      }),
    ).toMatchObject({ ok: false, code: 'too_large' });
    expect(
      validateUpload({
        filename: 'a.mp4',
        mimeType: 'video/mp4',
        declaredSizeBytes: 0,
        maxSizeBytes: MB,
      }),
    ).toMatchObject({ ok: false });
  });
  it('strips paths from filenames (path traversal)', () => {
    const result = validateUpload({
      filename: '../../etc/passwd.mp4',
      mimeType: 'video/mp4',
      maxSizeBytes: MB,
    });
    expect(result).toMatchObject({ ok: true, safeFilename: 'passwd.mp4' });
    expect(sanitizeFilename('C:\\Users\\x\\video.mov')).toBe('video.mov');
    expect(sanitizeFilename('..')).toBe('');
    expect(sanitizeFilename('bad\u0000name.mp4')).toBe('badname.mp4');
  });
});

describe('sniffVideoHeader', () => {
  it('accepts an ftyp box for mp4/mov', () => {
    const header = Buffer.concat([
      Buffer.from([0, 0, 0, 0x18]),
      Buffer.from('ftypisom'),
      Buffer.alloc(8),
    ]);
    expect(sniffVideoHeader(header, 'video/mp4')).toBeNull();
    expect(sniffVideoHeader(header, 'video/quicktime')).toBeNull();
    expect(sniffVideoHeader(header, 'video/webm')).toMatch(/EBML/);
  });
  it('rejects a PE executable declared as mp4', () => {
    const header = Buffer.concat([Buffer.from('MZ'), Buffer.alloc(14)]);
    expect(sniffVideoHeader(header, 'video/mp4')).toMatch(/does not look like/);
  });
  it('accepts EBML for webm/mkv', () => {
    const header = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(12)]);
    expect(sniffVideoHeader(header, 'video/webm')).toBeNull();
    expect(sniffVideoHeader(header, 'video/x-matroska')).toBeNull();
  });
});
