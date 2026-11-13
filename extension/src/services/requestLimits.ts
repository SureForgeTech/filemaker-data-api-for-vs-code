import http, { type ClientRequest, type IncomingMessage, type RequestOptions } from 'http';
import https from 'https';
import { AxiosError, isAxiosError, type AxiosProgressEvent, type AxiosRequestConfig } from 'axios';

/** Per response, after decompression. Exports can use smaller pages within this budget. */
export const DEFAULT_MAX_RESPONSE_BYTES = 64 * 1024 * 1024;

// Tiny trickles must not keep a transfer alive indefinitely (64 KiB per timeout window).
const TRANSFER_PROGRESS_BYTES = 64 * 1024;
const MAX_TRANSFER_MS = 30 * 60 * 1000;

/** Budget the whole upload exchange for a slow but real 32 KiB/s link. */
export function uploadDeadlineMs(timeoutMs: number, bodyBytes: number): number {
  return Math.min(MAX_TRANSFER_MS, Math.max(timeoutMs, bodyBytes / (32 * 1024) * 1000));
}

type Transport = { request(options: RequestOptions, callback: (response: IncomingMessage) => void): ClientRequest };

/**
 * Axios' socket inactivity timeout can be kept alive by a dripping response. This deadline
 * covers the whole HTTP exchange, while retaining caller cancellation. Downloads may renew
 * it after substantial byte progress. Upload events measure buffering, so uploads use a
 * size-based deadline instead. Every transfer has a 30 minute ceiling. Use disposable timers rather
 * than requiring AbortSignal.any in older extension hosts.
 */
export async function withRequestLimits<T>(
  timeoutMs: number,
  signal: AbortSignal | undefined,
  send: (limits: AxiosRequestConfig) => Promise<T>,
  maxResponseBytes = DEFAULT_MAX_RESPONSE_BYTES,
  transfer: boolean | 'upload' = false,
  transport?: Transport,
  uploadBytes = 0
): Promise<T> {
  const controller = new AbortController();
  const cancel = () => controller.abort(signal?.reason);
  if (signal?.aborted) cancel();
  else signal?.addEventListener('abort', cancel, { once: true });
  let timedOut = false;
  const expire = () => {
    if (controller.signal.aborted) return;
    timedOut = true;
    controller.abort();
  };
  const timer = setTimeout(expire, transfer === 'upload' ? uploadDeadlineMs(timeoutMs, uploadBytes) : timeoutMs);
  timer.unref();
  const ceiling = transfer === true ? setTimeout(expire, MAX_TRANSFER_MS) : undefined;
  ceiling?.unref();
  let connectionTimer: ReturnType<typeof setTimeout> | undefined;
  let finished = false;
  const progress = () => {
    let renewedAt = 0;
    return ({ loaded }: AxiosProgressEvent) => {
      if (!finished && !controller.signal.aborted && loaded - renewedAt >= TRANSFER_PROGRESS_BYTES) {
        renewedAt = loaded;
        timer?.refresh();
      }
    };
  };
  try {
    return await send({
      signal: controller.signal,
      // Socket inactivity cannot measure remote upload drain progress across platforms.
      timeout: transfer === 'upload' ? 0 : timeoutMs,
      ...(transfer === true ? { onDownloadProgress: progress() } : {}),
      ...(transfer === 'upload' ? { transport: {
        request: (options: RequestOptions, callback: (response: IncomingMessage) => void) => {
          const req = transport ? transport.request(options, callback)
            : (options.protocol === 'https:' ? https : http).request(options, callback);
          // Still bound DNS, proxy lookup and connection setup before a socket is ready.
          connectionTimer = setTimeout(expire, timeoutMs);
          connectionTimer.unref();
          req.once('socket', (socket) => {
            const connected = () => clearTimeout(connectionTimer);
            if (socket.connecting) socket.once('connect', connected);
            else connected();
          });
          return req;
        }
      } } : {}),
      maxContentLength: maxResponseBytes,
      // Retain the existing container limit (up to 2 GiB), including proxy base64 overhead.
      maxBodyLength: 3 * 1024 * 1024 * 1024
    });
  } catch (error) {
    if (timedOut) {
      const failure = isAxiosError(error) ? error : new AxiosError();
      failure.code = 'ECONNABORTED';
      failure.message = 'FileMaker request timed out.';
      throw failure;
    }
    throw error;
  } finally {
    finished = true;
    clearTimeout(timer);
    clearTimeout(ceiling);
    clearTimeout(connectionTimer);
    signal?.removeEventListener('abort', cancel);
  }
}
