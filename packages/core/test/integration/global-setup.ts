import { setupTestDatabase } from '@repeat/database/testing';

export default async function setup(): Promise<void> {
  await setupTestDatabase();
}
