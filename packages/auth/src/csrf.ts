import { ForbiddenError } from '@repeat/core';

/**
 * CSRF protection for cookie-authenticated, state-changing requests.
 *
 * Browsers always attach `Origin` (and `Sec-Fetch-Site`) to cross-origin
 * requests that could be forged, so a mismatch is rejected. Requests without
 * either header cannot come from a cross-site browser context and are allowed
 * (curl, server-to-server). Combined with SameSite=Lax cookies this is the
 * OWASP-recommended header-based defense; no per-form token is needed for a
 * JSON API.
 */
export function isTrustedOrigin(headers: Headers, appUrl: string): boolean {
  const expectedOrigin = new URL(appUrl).origin;
  const origin = headers.get('origin');
  const fetchSite = headers.get('sec-fetch-site');

  if (origin) {
    if (origin === expectedOrigin) return true;
    // Allow the Host-based origin so a deployment reached through a different
    // hostname than APP_URL (e.g. http://127.0.0.1 during development) still works.
    const host = headers.get('x-forwarded-host') ?? headers.get('host');
    const proto =
      headers.get('x-forwarded-proto') ?? (appUrl.startsWith('https') ? 'https' : 'http');
    if (host && origin === `${proto}://${host}`) return true;
    return false;
  }
  if (fetchSite && fetchSite !== 'same-origin' && fetchSite !== 'none') return false;
  return true;
}

export function assertTrustedOrigin(headers: Headers, appUrl: string): void {
  if (!isTrustedOrigin(headers, appUrl)) {
    throw new ForbiddenError('Cross-origin request rejected');
  }
}
