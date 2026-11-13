import { AxiosError, isAxiosError, type AxiosProgressEvent, type AxiosRequestConfig } from 'axios';

/** Per response, after decompression. Exports can use smaller pages within this budget. */
export const DEFAULT_MAX_RESPONSE_BYTES = 64 * 1024 * 1024;

// Tiny trickles must not keep a transfer alive indefinitely (64 KiB per timeout window).
const TRANSFER_PROGRESS_BYTES = 64 * 1024;

/**
 * Axios' socket inactivity timeout can be kept alive by a dripping response. This deadline
 * covers the whole HTTP exchange, while retaining caller cancellation. Large transfers may
 * renew it after substantial byte progress. Use AbortController and a disposable timer rather
 * than requiring AbortSignal.any in older extension hosts.
 */
export async function withRequestLimits<T>(
  timeoutMs: number,
  signal: AbortSignal | undefined,
  send: (limits: AxiosRequestConfig) => Promise<T>,
  maxResponseBytes = DEFAULT_MAX_RESPONSE_BYTES,
  transfer = false
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
  const timer = setTimeout(expire, timeoutMs);
  timer.unref();
  let finished = false;
  const progress = () => {
    let renewedAt = 0;
    return ({ loaded }: AxiosProgressEvent) => {
      if (!finished && !controller.signal.aborted && loaded - renewedAt >= TRANSFER_PROGRESS_BYTES) {
        renewedAt = loaded;
        timer.refresh();
      }
    };
  };
  try {
    return await send({
      signal: controller.signal,
      timeout: timeoutMs,
      ...(transfer ? { onUploadProgress: progress(), onDownloadProgress: progress() } : {}),
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
    signal?.removeEventListener('abort', cancel);
  }
}
