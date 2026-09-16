import { describe, expect, it } from 'vitest';
import { hashPassword, verifyPassword } from './password.js';

describe('password hashing', () => {
  it('verifies the right password and rejects the wrong one', async () => {
    const hash = await hashPassword('correct horse battery staple');
    expect(hash.startsWith('scrypt$')).toBe(true);
    expect(await verifyPassword('correct horse battery staple', hash)).toBe(true);
    expect(await verifyPassword('wrong', hash)).toBe(false);
  });
  it('salts hashes', async () => {
    expect(await hashPassword('x')).not.toBe(await hashPassword('x'));
  });
  it('rejects malformed stored hashes', async () => {
    expect(await verifyPassword('x', 'garbage')).toBe(false);
  });
});
