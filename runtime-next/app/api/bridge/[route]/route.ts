// fmweb-managed: runtime template v11. Preview session security; keep this file identical to the shipped template.
import type { NextRequest } from 'next/server';
import { previewHostAllowed, previewSessionAllowed } from '../../../../lib/preview-security';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const routes = new Set(['find', 'getRecord', 'editRecord', 'createRecord', 'deleteRecord', 'runScript']);
const reply = (error: string, status: number) => Response.json({ error }, { status, headers: { 'Cache-Control': 'no-store' } });

export async function POST(request: NextRequest, context: { params: Promise<{ route: string }> }): Promise<Response> {
  if (!previewHostAllowed(request)) return reply('Preview Host is not allowed.', 403);
  if (!previewSessionAllowed(request)) return reply('Preview session is required.', 401);
  const origin = `http://${request.headers.get('host')}`;
  if (request.headers.get('origin') !== origin) return reply('Origin is not allowed.', 403);
  const { route } = await context.params;
  if (!routes.has(route)) return reply('Unknown bridge route.', 404);
  const base = process.env.FMWEB_BRIDGE_URL;
  const token = process.env.FMWEB_BRIDGE_TOKEN;
  if (!base || !/^http:\/\/127\.0\.0\.1:\d+\/fm$/.test(base) || !token) return reply('Bridge is not configured.', 503);
  // Bound memory before parsing; never forward cookies, client auth headers or arbitrary destinations.
  const reader = request.body?.getReader();
  let body = '';
  if (reader) {
    const decoder = new TextDecoder();
    let length = 0;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > 1_048_576) { await reader.cancel(); return reply('Request is too large.', 413); }
      body += decoder.decode(value, { stream: true });
    }
    body += decoder.decode();
  }
  try {
    const upstream = await fetch(`${base}/${route}`, {
      method: 'POST', redirect: 'error', cache: 'no-store',
      headers: { 'Content-Type': 'application/json', Origin: origin, 'X-FM-Bridge-Token': token },
      body, signal: AbortSignal.timeout(180_000)
    });
    return new Response(await upstream.text(), {
      status: upstream.status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
    });
  } catch {
    return reply('Cannot reach the extension bridge.', 502);
  }
}
