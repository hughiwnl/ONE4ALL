import { describe, expect, it } from 'vitest';
import { summarizeDestinations } from './mappers.js';

describe('summarizeDestinations', () => {
  it('counts every status independently', () => {
    const summary = summarizeDestinations([
      { status: 'published' },
      { status: 'published' },
      { status: 'failed' },
      { status: 'processing' },
      { status: 'queued' },
    ]);
    expect(summary).toEqual({
      total: 5,
      queued: 1,
      uploading: 0,
      processing: 1,
      published: 2,
      failed: 1,
      canceled: 0,
    });
  });
});
