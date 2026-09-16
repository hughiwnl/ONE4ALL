import { describe, expect, it } from 'vitest';
import { isTrustedOrigin } from './csrf.js';

const app = 'https://repeat.example.com';

describe('isTrustedOrigin', () => {
  it('accepts same-origin browser requests', () => {
    expect(
      isTrustedOrigin(new Headers({ origin: app, 'sec-fetch-site': 'same-origin' }), app),
    ).toBe(true);
  });
  it('rejects cross-origin browser requests', () => {
    expect(
      isTrustedOrigin(
        new Headers({ origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' }),
        app,
      ),
    ).toBe(false);
    expect(isTrustedOrigin(new Headers({ 'sec-fetch-site': 'cross-site' }), app)).toBe(false);
  });
  it('accepts non-browser clients that send neither header', () => {
    expect(isTrustedOrigin(new Headers(), app)).toBe(true);
  });
  it('accepts the request host as origin when it differs from APP_URL', () => {
    expect(
      isTrustedOrigin(
        new Headers({
          origin: 'http://127.0.0.1:3000',
          host: '127.0.0.1:3000',
          'x-forwarded-proto': 'http',
        }),
        'http://localhost:3000',
      ),
    ).toBe(true);
  });
});
