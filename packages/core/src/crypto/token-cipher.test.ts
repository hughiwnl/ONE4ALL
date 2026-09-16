import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { TokenCipher } from './token-cipher.js';

describe('TokenCipher', () => {
  const key = randomBytes(32);
  const cipher = new TokenCipher(key);

  it('round-trips text and JSON', () => {
    const token = 'ya29.a0AfH6SMB-very-secret-token';
    const encrypted = cipher.encrypt(token);
    expect(encrypted).not.toContain(token);
    expect(encrypted.startsWith('v1.')).toBe(true);
    expect(cipher.decrypt(encrypted)).toBe(token);
    expect(cipher.decryptJson(cipher.encryptJson({ a: 1 }))).toEqual({ a: 1 });
  });

  it('produces different ciphertexts for the same plaintext (random IV)', () => {
    expect(cipher.encrypt('same')).not.toBe(cipher.encrypt('same'));
  });

  it('fails authentication when the payload is tampered with', () => {
    const encrypted = cipher.encrypt('secret');
    const parts = encrypted.split('.');
    const data = Buffer.from(parts[3]!, 'base64url');
    data[0] = data[0]! ^ 0xff;
    parts[3] = data.toString('base64url');
    expect(() => cipher.decrypt(parts.join('.'))).toThrow();
  });

  it('cannot decrypt with a different key', () => {
    const other = new TokenCipher(randomBytes(32));
    expect(() => other.decrypt(cipher.encrypt('secret'))).toThrow();
  });

  it('accepts base64 and hex keys and rejects wrong sizes', () => {
    expect(() => new TokenCipher(key.toString('base64'))).not.toThrow();
    expect(() => new TokenCipher(key.toString('hex'))).not.toThrow();
    expect(() => new TokenCipher('too-short')).toThrow(/32 bytes/);
  });

  it('rejects malformed payloads', () => {
    expect(() => cipher.decrypt('nope')).toThrow(/Malformed/);
    expect(() => cipher.decrypt('v2.a.b.c')).toThrow(/Unsupported/);
  });
});
