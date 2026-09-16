import { NextResponse } from 'next/server';
import { SESSION_COOKIE_NAME } from '@repeat/auth';
import { route } from '@/server/api';
import { getContainer } from '@/server/container';

type Params = { connector: string };

/**
 * OAuth callback. Validates state, exchanges the code and discovers accounts.
 * A single discovered account is connected immediately; several go to a
 * selection page. Errors are shown on the Accounts page, never as raw JSON.
 */
export const GET = route<Params>(async (request, { params }) => {
  const { env, sessions, oauth, logger } = getContainer();
  const accountsUrl = new URL('/accounts', env.APP_URL);

  const user = await sessions.validate(request.cookies.get(SESSION_COOKIE_NAME)?.value);
  if (!user) {
    return NextResponse.redirect(new URL('/login?next=/accounts', env.APP_URL));
  }

  const search = request.nextUrl.searchParams;
  try {
    const result = await oauth.complete(user.id, params.connector, {
      state: search.get('state'),
      code: search.get('code'),
      error: search.get('error'),
      errorDescription: search.get('error_description'),
    });

    if (result.accounts.length === 1) {
      const only = result.accounts[0]!;
      await oauth.finalize(user.id, result.pendingConnectionId, [
        { platform: only.platform, platformAccountId: only.platformAccountId },
      ]);
      accountsUrl.searchParams.set('connected', only.displayName);
      return NextResponse.redirect(accountsUrl);
    }

    const select = new URL(
      `/accounts/connect/${encodeURIComponent(params.connector)}`,
      env.APP_URL,
    );
    select.searchParams.set('pending', result.pendingConnectionId);
    return NextResponse.redirect(select);
  } catch (error) {
    logger.warn(
      { err: error, connector: params.connector, user_id: user.id },
      'oauth callback failed',
    );
    const message = error instanceof Error ? error.message : 'Connection failed';
    accountsUrl.searchParams.set('error', message.slice(0, 500));
    return NextResponse.redirect(accountsUrl);
  }
});
