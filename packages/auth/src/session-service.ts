import { createHash, randomBytes } from 'node:crypto';
import type { Db, User } from '@repeat/database';

export const SESSION_COOKIE_NAME = 'repeat_session';
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** Extend the session when it is used within this window of expiring. */
const SESSION_RENEW_THRESHOLD_MS = 7 * 24 * 60 * 60 * 1000;

export interface SessionCookieOptions {
  name: string;
  httpOnly: true;
  sameSite: 'lax';
  secure: boolean;
  path: '/';
  maxAge: number;
}

export function sessionCookieOptions(appUrl: string): SessionCookieOptions {
  return {
    name: SESSION_COOKIE_NAME,
    httpOnly: true,
    sameSite: 'lax',
    secure: appUrl.startsWith('https://'),
    path: '/',
    maxAge: Math.floor(SESSION_TTL_MS / 1000),
  };
}

/**
 * Database-backed sessions. The browser holds a random opaque token; the
 * database stores only its SHA-256 hash, so a database leak does not yield
 * usable sessions.
 */
export class SessionService {
  constructor(private readonly db: Db) {}

  async create(userId: string): Promise<{ token: string; expiresAt: Date }> {
    const token = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
    await this.db.session.create({ data: { id: hashToken(token), userId, expiresAt } });
    return { token, expiresAt };
  }

  /** Resolve a token to its user, or null when missing/expired. Sliding expiration. */
  async validate(token: string | undefined | null): Promise<User | null> {
    if (!token || token.length > 512) return null;
    const session = await this.db.session.findUnique({
      where: { id: hashToken(token) },
      include: { user: true },
    });
    if (!session) return null;
    if (session.expiresAt.getTime() <= Date.now()) {
      await this.db.session.delete({ where: { id: session.id } }).catch(() => undefined);
      return null;
    }
    if (session.expiresAt.getTime() - Date.now() < SESSION_TTL_MS - SESSION_RENEW_THRESHOLD_MS) {
      await this.db.session
        .update({
          where: { id: session.id },
          data: { expiresAt: new Date(Date.now() + SESSION_TTL_MS) },
        })
        .catch(() => undefined);
    }
    return session.user;
  }

  async destroy(token: string | undefined | null): Promise<void> {
    if (!token) return;
    await this.db.session.deleteMany({ where: { id: hashToken(token) } });
  }

  async destroyAllForUser(userId: string): Promise<void> {
    await this.db.session.deleteMany({ where: { userId } });
  }

  async purgeExpired(): Promise<number> {
    const result = await this.db.session.deleteMany({ where: { expiresAt: { lt: new Date() } } });
    return result.count;
  }
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
