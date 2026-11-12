import { AxiosError, isAxiosError, type AxiosRequestConfig } from 'axios';

/** Per response, after decompression. Exports can use smaller pages within this budget. */
export const DEFAULT_MAX_RESPONSE_BYTES = 64 * 1024 * 1024;

/**
 * Axios' socket inactivity timeout can be kept alive by a dripping response. This deadline
 * covers the whole HTTP exchange, while retaining caller cancellation. Use AbortController
 * and a disposable timer rather than requiring AbortSignal.any in older extension hosts.
 */
export async function withRequestLimits<T>(
  timeoutMs: number,
  signal: AbortSignal | undefined,
  send: (limits: AxiosRequestConfig) => Promise<T>,
  maxResponseBytes = DEFAULT_MAX_RESPONSE_BYTES
): Promise<T> {
  const controller = new AbortController();
  const cancel = () => controller.abort(signal?.reason);
  if (signal?.aborted) cancel();
  else signal?.addEventListener('abort', cancel, { once: true });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  timer.unref();
  try {
    return await send({
      signal: controller.signal,
      timeout: timeoutMs,
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
    clearTimeout(timer);
    signal?.removeEventListener('abort', cancel);
  }
}
