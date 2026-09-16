import { NextResponse } from 'next/server';
import { getContainer } from '@/server/container';

export const dynamic = 'force-dynamic';

/** Liveness/readiness probe used by Docker Compose. */
export async function GET() {
  try {
    const { db } = getContainer();
    await db.$queryRaw`SELECT 1`;
    return NextResponse.json({ status: 'ok' });
  } catch (error) {
    return NextResponse.json(
      { status: 'error', message: error instanceof Error ? error.message : 'unknown' },
      { status: 503 },
    );
  }
}
