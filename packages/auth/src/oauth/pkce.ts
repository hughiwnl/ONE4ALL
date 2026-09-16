import { createHash, randomBytes } from 'node:crypto';

export function generateState(): string {
  return randomBytes(32).toString('base64url');
}

/** PKCE (RFC 7636) S256 verifier/challenge pair. */
export function generatePkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(48).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}
