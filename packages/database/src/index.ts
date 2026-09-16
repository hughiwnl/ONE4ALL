export { PrismaClient, Prisma, DestinationStatus as DbDestinationStatus } from '@prisma/client';
export type {
  User,
  Session,
  SocialAccount,
  Media,
  Post,
  PostDestination,
  OAuthState,
  PendingConnection,
} from '@prisma/client';
export { createPrismaClient } from './client.js';
export type { Db } from './client.js';
