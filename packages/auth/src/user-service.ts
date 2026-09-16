import type { Db, User } from '@repeat/database';
import { AppError, ConflictError, UnauthorizedError } from '@repeat/core';
import type { UserDto } from '@repeat/types';
import { hashPassword, verifyPassword } from './password.js';

export interface UserServiceOptions {
  db: Db;
  /** Whether sign-up is open once at least one user exists. The first user can always register. */
  allowRegistration: boolean;
}

export class UserService {
  constructor(private readonly options: UserServiceOptions) {}

  async count(): Promise<number> {
    return this.options.db.user.count();
  }

  async register(input: { email: string; password: string; name?: string }): Promise<User> {
    const { db, allowRegistration } = this.options;
    const existingUsers = await db.user.count();
    if (existingUsers > 0 && !allowRegistration) {
      throw new AppError(
        'registration_disabled',
        'Registration is disabled on this server (ALLOW_REGISTRATION=false)',
        403,
      );
    }
    const existing = await db.user.findUnique({ where: { email: input.email } });
    if (existing) throw new ConflictError('An account with this email already exists');
    return db.user.create({
      data: {
        email: input.email,
        name: input.name ?? null,
        passwordHash: await hashPassword(input.password),
      },
    });
  }

  async authenticate(input: { email: string; password: string }): Promise<User> {
    const user = await this.options.db.user.findUnique({ where: { email: input.email } });
    // Always run the hash comparison so timing does not reveal whether the email exists.
    const ok = await verifyPassword(input.password, user?.passwordHash ?? DUMMY_HASH);
    if (!user || !ok) throw new UnauthorizedError('Invalid email or password');
    return user;
  }
}

const DUMMY_HASH =
  'scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';

export function toUserDto(user: User): UserDto {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    createdAt: user.createdAt.toISOString(),
  };
}
