import http, { type ClientRequest, type IncomingMessage, type RequestOptions } from 'http';
import https from 'https';
import { AxiosError, isAxiosError, type AxiosProgressEvent, type AxiosRequestConfig } from 'axios';

/** Per response, after decompression. Exports can use smaller pages within this budget. */
export const DEFAULT_MAX_RESPONSE_BYTES = 64 * 1024 * 1024;

// Tiny trickles must not keep a transfer alive indefinitely (64 KiB per timeout window).
const TRANSFER_PROGRESS_BYTES = 64 * 1024;
const MAX_TRANSFER_MS = 30 * 60 * 1000;

type Transport = { request(options: RequestOptions, callback: (response: IncomingMessage) => void): ClientRequest };

/**
 * Axios' socket inactivity timeout can be kept alive by a dripping response. This deadline
 * covers the whole HTTP exchange, while retaining caller cancellation. Downloads may renew
 * it after substantial byte progress. Upload events measure buffering, so uploads use socket
 * inactivity instead. Every transfer has a 30 minute ceiling. Use disposable timers rather
 * than requiring AbortSignal.any in older extension hosts.
 */
export async function withRequestLimits<T>(
  timeoutMs: number,
  signal: AbortSignal | undefined,
  send: (limits: AxiosRequestConfig) => Promise<T>,
  maxResponseBytes = DEFAULT_MAX_RESPONSE_BYTES,
  transfer: boolean | 'upload' = false,
  transport?: Transport
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
  let timer = transfer === 'upload' ? undefined : setTimeout(expire, timeoutMs);
  timer?.unref();
  const ceiling = transfer ? setTimeout(expire, MAX_TRANSFER_MS) : undefined;
  ceiling?.unref();
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
      timeout: timeoutMs,
      ...(transfer === true ? { onDownloadProgress: progress() } : {}),
      ...(transfer === 'upload' ? { transport: {
        request: (options: RequestOptions, callback: (response: IncomingMessage) => void) => {
          const req = transport ? transport.request(options, callback)
            : (options.protocol === 'https:' ? https : http).request(options, callback);
          // Axios 1.20 and our TLS transport otherwise start a deadline lasting until
          // response headers. Use the native idle timeout while the upload drains.
          req.setTimeout = (ms, listener) => http.ClientRequest.prototype.setTimeout.call(req, ms, listener);
          // Still bound DNS, proxy lookup and connection setup before a socket is ready.
          timer = setTimeout(expire, timeoutMs);
          timer.unref();
          req.once('socket', (socket) => {
            const connected = () => clearTimeout(timer);
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
    signal?.removeEventListener('abort', cancel);
  }
}
