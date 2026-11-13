// fmweb-managed: runtime template v9. Preview session security; keep this file identical to the shipped template.
// Server only: never import this module from a client component.
import { createHash, timingSafeEqual } from 'node:crypto';
import { open } from 'node:fs/promises';
import type { NextRequest } from 'next/server';

export const SESSION_COOKIE = 'fmweb_preview';
const digest = (value: string) => createHash('sha256').update(value).digest();
const equal = (value: string | undefined, expected: string | undefined) =>
  Boolean(value && expected && timingSafeEqual(digest(value), digest(expected)));

export function previewHostAllowed(request: NextRequest): boolean {
  return ['127.0.0.1:3000', 'localhost:3000'].includes(request.headers.get('host') ?? '');
}

export function previewSessionAllowed(request: NextRequest): boolean {
  return equal(request.cookies.get(SESSION_COOKIE)?.value, process.env.FMWEB_PREVIEW_SESSION);
}

/** Exclusive creation survives dev recompilation and makes redemption atomic across workers. */
export async function consumeLaunchCode(request: NextRequest): Promise<boolean> {
  if (request.method !== 'GET' || request.nextUrl.pathname !== '/' ||
      !equal(request.nextUrl.searchParams.get('launch') ?? undefined, process.env.FMWEB_LAUNCH_CODE) ||
      !Number.isFinite(Number(process.env.FMWEB_LAUNCH_EXPIRES)) ||
      Date.now() >= Number(process.env.FMWEB_LAUNCH_EXPIRES) ||
      !process.env.FMWEB_LAUNCH_STATE || !process.env.FMWEB_PREVIEW_SESSION) return false;
  try {
    const file = await open(process.env.FMWEB_LAUNCH_STATE, 'wx', 0o600);
    await file.close();
    return true;
  } catch {
    return false;
  }
}
