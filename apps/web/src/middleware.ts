import { NextResponse, type NextRequest } from 'next/server';

const SESSION_COOKIE = 'repeat_session';
const PUBLIC_PATHS = ['/login', '/register'];

/**
 * Cheap gate for page routes: without a session cookie, go to /login. The
 * cookie is validated for real in server components and API handlers; this
 * only avoids rendering the app shell for anonymous visitors.
 */
export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const hasSession = Boolean(request.cookies.get(SESSION_COOKIE)?.value);

  if (PUBLIC_PATHS.includes(pathname)) {
    if (hasSession) return NextResponse.redirect(new URL('/dashboard', request.url));
    return NextResponse.next();
  }

  if (!hasSession) {
    const login = new URL('/login', request.url);
    if (pathname !== '/') login.searchParams.set('next', pathname + request.nextUrl.search);
    return NextResponse.redirect(login);
  }
  return NextResponse.next();
}

export const config = {
  // Everything except API routes, Next internals and static files.
  matcher: ['/((?!api|_next/static|_next/image|favicon.ico|robots.txt).*)'],
};
