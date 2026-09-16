import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Application-level encryption for provider credentials (AES-256-GCM).
 *
 * Ciphertext format: `v1.<iv>.<authTag>.<ciphertext>` (all base64url). The
 * version prefix allows rotating the algorithm later. Each value gets a fresh
 * random 96-bit IV, and the version string is bound as additional
 * authenticated data.
 */
export class TokenCipher {
  private static readonly VERSION = 'v1';
  private readonly key: Buffer;

  constructor(key: string | Buffer) {
    this.key = typeof key === 'string' ? TokenCipher.parseKey(key) : key;
    if (this.key.length !== 32) {
      throw new Error('TokenCipher requires a 32-byte key');
    }
  }

  static parseKey(value: string): Buffer {
    if (/^[0-9a-fA-F]{64}$/.test(value)) return Buffer.from(value, 'hex');
    const decoded = Buffer.from(value, 'base64');
    if (decoded.length !== 32) {
      throw new Error('TOKEN_ENCRYPTION_KEY must decode to exactly 32 bytes (base64 or hex)');
    }
    return decoded;
  }

  encrypt(plaintext: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(Buffer.from(TokenCipher.VERSION));
    const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return [TokenCipher.VERSION, b64url(iv), b64url(tag), b64url(encrypted)].join('.');
  }

  decrypt(payload: string): string {
    const parts = payload.split('.');
    if (parts.length !== 4) throw new Error('Malformed encrypted payload');
    const [version, ivB64, tagB64, dataB64] = parts as [string, string, string, string];
    if (!timingSafeEqual(Buffer.from(version), Buffer.from(TokenCipher.VERSION))) {
      throw new Error(`Unsupported encrypted payload version "${version}"`);
    }
    const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(ivB64, 'base64url'));
    decipher.setAAD(Buffer.from(TokenCipher.VERSION));
    decipher.setAuthTag(Buffer.from(tagB64, 'base64url'));
    const decrypted = Buffer.concat([
      decipher.update(Buffer.from(dataB64, 'base64url')),
      decipher.final(),
    ]);
    return decrypted.toString('utf8');
  }

  encryptJson(value: unknown): string {
    return this.encrypt(JSON.stringify(value));
  }

  decryptJson<T = unknown>(payload: string): T {
    return JSON.parse(this.decrypt(payload)) as T;
  }
}

function b64url(buffer: Buffer): string {
  return buffer.toString('base64url');
}
