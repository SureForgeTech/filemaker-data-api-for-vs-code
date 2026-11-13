// fmweb-managed: runtime template v9. Preview session security; keep this file identical to the shipped template.
import { NextRequest, NextResponse } from 'next/server';
import { consumeLaunchCode, previewHostAllowed, previewSessionAllowed, SESSION_COOKIE } from './lib/preview-security';

/** All paths, including static assets, require the private preview session. */
export async function proxy(request: NextRequest): Promise<NextResponse> {
  let response: NextResponse;
  if (!previewHostAllowed(request)) {
    response = new NextResponse('Preview Host is not allowed.', { status: 403 });
  } else if (request.nextUrl.searchParams.has('launch')) {
    if (await consumeLaunchCode(request)) {
      // Construct from the checked Host, never from forwarded headers.
      response = NextResponse.redirect(new URL('/', `http://${request.headers.get('host')}`), 303);
      response.cookies.set(SESSION_COOKIE, process.env.FMWEB_PREVIEW_SESSION!, {
        httpOnly: true, sameSite: 'strict', path: '/'
      });
    } else {
      response = new NextResponse('Preview launch is invalid, expired or already used. Start a new preview from VS Code.', { status: 401 });
    }
  } else if (!previewSessionAllowed(request)) {
    response = new NextResponse('Open this preview using the private launch link from VS Code.', { status: 401 });
  } else {
    response = NextResponse.next();
  }
  response.headers.set('Cache-Control', 'no-store');
  response.headers.set('Referrer-Policy', 'no-referrer');
  return response;
}
