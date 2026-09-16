import { z } from 'zod';

/**
 * Request/response contracts for the HTTP API.
 *
 * These schemas are shared by the Next.js route handlers (validation) and by
 * clients (typed requests). A future dedicated cloud API or mobile client can
 * reuse them unchanged.
 */

export const registerRequestSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  password: z.string().min(10, 'Password must be at least 10 characters').max(256),
  name: z.string().trim().min(1).max(100).optional(),
});
export type RegisterRequest = z.infer<typeof registerRequestSchema>;

export const loginRequestSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  password: z.string().min(1).max(256),
});
export type LoginRequest = z.infer<typeof loginRequestSchema>;

export const updateAccountRequestSchema = z.object({
  enabled: z.boolean(),
});
export type UpdateAccountRequest = z.infer<typeof updateAccountRequestSchema>;

/** Provider-specific settings are validated by the provider itself; here they are just a JSON object. */
export const destinationSettingsSchema = z.record(z.string(), z.unknown()).default({});

export const createPostRequestSchema = z.object({
  mediaId: z.string().min(1),
  title: z.string().trim().max(500).optional(),
  caption: z.string().trim().max(5000).optional(),
  description: z.string().trim().max(10000).optional(),
  destinations: z
    .array(
      z.object({
        socialAccountId: z.string().min(1),
        settings: destinationSettingsSchema,
      }),
    )
    .min(1, 'Select at least one destination'),
});
export type CreatePostRequest = z.infer<typeof createPostRequestSchema>;

export const completeConnectionRequestSchema = z.object({
  pendingConnectionId: z.string().min(1),
  /** platformAccountIds (scoped by platform) the user chose to connect. */
  selected: z
    .array(z.object({ platform: z.string().min(1), platformAccountId: z.string().min(1) }))
    .min(1, 'Select at least one account'),
});
export type CompleteConnectionRequest = z.infer<typeof completeConnectionRequestSchema>;

export const connectMockAccountRequestSchema = z.object({
  displayName: z.string().trim().min(1).max(100),
  /** Controls how the mock provider behaves for this account. */
  behavior: z
    .enum(['succeed', 'succeed_after_processing', 'fail_retryable', 'fail_permanent', 'flaky'])
    .default('succeed'),
});
export type ConnectMockAccountRequest = z.infer<typeof connectMockAccountRequestSchema>;

export const listPostsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().optional(),
});
export type ListPostsQuery = z.infer<typeof listPostsQuerySchema>;

/** Standard error envelope returned by every API route on failure. */
export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
}
