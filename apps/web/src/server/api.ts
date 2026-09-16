import 'server-only';
import { NextResponse, type NextRequest } from 'next/server';
import { ZodError, type ZodType, type ZodTypeDef } from 'zod';
import { assertTrustedOrigin } from '@repeat/auth';
import { isAppError, ValidationError } from '@repeat/core';
import { isProviderError } from '@repeat/provider-sdk';
import type { ApiErrorBody } from '@repeat/types';
import { getContainer } from './container.js';

type RouteContext<P = Record<string, string>> = { params: Promise<P> };
type Handler<P> = (request: NextRequest, context: { params: P }) => Promise<Response>;

/**
 * Wrap a route handler: resolves params, enforces same-origin for mutating
 * requests (CSRF), and converts thrown errors into the standard JSON envelope.
 */
export function route<P = Record<string, string>>(handler: Handler<P>) {
  return async (request: NextRequest, context: RouteContext<P>): Promise<Response> => {
    const { env, logger } = getContainer();
    try {
      if (request.method !== 'GET' && request.method !== 'HEAD' && request.method !== 'OPTIONS') {
        assertTrustedOrigin(request.headers, env.APP_URL);
      }
      const params = await context.params;
      return await handler(request, { params });
    } catch (error) {
      return errorResponse(error, logger);
    }
  };
}

export function json<T>(body: T, init?: ResponseInit): NextResponse<T> {
  return NextResponse.json(body, init);
}

export function apiError(
  code: string,
  message: string,
  status: number,
  details?: unknown,
): NextResponse<ApiErrorBody> {
  return NextResponse.json(
    { error: { code, message, ...(details !== undefined ? { details } : {}) } },
    { status },
  );
}

function errorResponse(
  error: unknown,
  logger: { warn: (o: object, m: string) => void; error: (o: object, m: string) => void },
): NextResponse<ApiErrorBody> {
  if (error instanceof ZodError || (error instanceof Error && error.name === 'ZodError')) {
    return apiError('validation_error', 'Invalid request', 400, (error as ZodError).flatten());
  }
  if (isAppError(error)) {
    if (error.status >= 500) logger.error({ err: error }, 'request failed');
    return apiError(error.code, error.message, error.status, error.details);
  }
  if (isProviderError(error)) {
    // Provider errors reach the API only during account connection.
    logger.warn(
      { error_code: error.code, details: error.details },
      'provider error during request',
    );
    return apiError(error.code, error.message, 502, error.details);
  }
  logger.error({ err: error }, 'unhandled error in route');
  return apiError('internal_error', 'Something went wrong', 500);
}

/** Parse and validate a JSON body with a zod schema. */
export async function parseBody<T>(
  request: NextRequest,
  schema: ZodType<T, ZodTypeDef, unknown>,
): Promise<T> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    throw new ValidationError('Request body must be valid JSON');
  }
  return schema.parse(raw);
}

export function parseQuery<T>(request: NextRequest, schema: ZodType<T, ZodTypeDef, unknown>): T {
  return schema.parse(Object.fromEntries(request.nextUrl.searchParams));
}
