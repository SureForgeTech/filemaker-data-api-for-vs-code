// fmweb-managed: runtime template v9. The FileMaker Data API Tools extension refreshes this file when the template version changes; keep your own changes in other files.
export interface RuntimeRecord {
  recordId: string;
  modId?: string;
  fieldData: Record<string, unknown>;
  portalData?: Record<string, Array<Record<string, unknown>>>;
}

export interface RuntimeFindRequest {
  layout: string;
  query: Array<Record<string, unknown>>;
  sort?: Array<Record<string, unknown>>;
  limit?: number;
  offset?: number;
}

export interface RuntimeFindResponse {
  data: RuntimeRecord[];
  dataInfo?: Record<string, unknown>;
}

export interface RuntimeEditResponse {
  recordId: string;
  modId?: string;
  response: Record<string, unknown>;
}

export interface RuntimeRunScriptResponse {
  response: Record<string, unknown>;
  messages: Array<{ code: string; message: string }>;
}

export class RuntimeBridgeError extends Error {
  constructor(message: string, public readonly code?: string) { super(message); }
}

export const BRIDGE_TOKEN_HEADER = 'X-FM-Bridge-Token';

export class RuntimeBridgeClient {
  /**
   * `bridgeToken` is the per-session token the extension's bridge server requires in the
   * `X-FM-Bridge-Token` header; without it every request is refused with 403. The default
   * `fetchFn` wraps the global `fetch` so it is not called detached from `window` (browsers
   * reject that with "Illegal invocation").
   */
  public constructor(
    private readonly baseUrl?: string,
    private readonly fetchFn: typeof fetch = (input, init) => fetch(input, init),
    private readonly bridgeToken?: string
  ) {}

  public isConfigured(): boolean {
    return Boolean(normalizeBridgeBaseUrl(this.baseUrl));
  }

  public async find(request: RuntimeFindRequest): Promise<RuntimeFindResponse> {
    try {
      return await this.post<RuntimeFindResponse>('find', request);
    } catch (error) {
      if (error instanceof RuntimeBridgeError && error.code === '401') return { data: [] };
      throw error;
    }
  }

  public async getRecord(layout: string, recordId: string): Promise<RuntimeRecord> {
    return this.post<RuntimeRecord>('getRecord', { layout, recordId });
  }

  public async editRecord(
    layout: string,
    recordId: string,
    fieldData: Record<string, unknown>,
    modId?: string
  ): Promise<RuntimeEditResponse> {
    return this.post<RuntimeEditResponse>('editRecord', { layout, recordId, fieldData, modId });
  }

  public async createRecord(layout: string, fieldData: Record<string, unknown>): Promise<RuntimeEditResponse> {
    return this.post<RuntimeEditResponse>('createRecord', { layout, fieldData });
  }

  public async deleteRecord(layout: string, recordId: string): Promise<RuntimeEditResponse> {
    return this.post<RuntimeEditResponse>('deleteRecord', { layout, recordId });
  }

  public async runScript(request: {
    layout: string;
    scriptName: string;
    scriptParam?: string;
    recordId?: string;
  }): Promise<RuntimeRunScriptResponse> {
    return this.post<RuntimeRunScriptResponse>('runScript', request);
  }

  private async post<T>(route: string, payload: unknown): Promise<T> {
    const normalizedBaseUrl = normalizeBridgeBaseUrl(this.baseUrl);
    if (!normalizedBaseUrl) {
      throw new Error('Bridge URL is not configured.');
    }

    let response: Response;
    try {
      response = await this.fetchFn(`${normalizedBaseUrl}/${route}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(this.bridgeToken ? { [BRIDGE_TOKEN_HEADER]: this.bridgeToken } : {})
        },
        body: JSON.stringify(payload)
      });
    } catch {
      throw new RuntimeBridgeError('Cannot reach the extension. Is the preview server running in VS Code?');
    }

    const body = await parseResponse(response);
    if (!response.ok) {
      const message = body && typeof body === 'object' ? String((body as { error?: string }).error ?? '') : '';
      const code = body && typeof body === 'object' ? (body as { code?: string }).code : undefined;
      if (code === '306') {
        throw new RuntimeBridgeError('This record changed since you opened it (306). Your changes have not been saved. Cancel, reload the record, and try again.', '306');
      }
      if (code === '201') {
        throw new RuntimeBridgeError('FileMaker will not let you edit this field. It may be calculated, summarized, or read-only for your account. Your changes have not been saved.', code);
      }
      throw new RuntimeBridgeError(message || `Bridge request failed with status ${response.status}.`, code);
    }

    return body as T;
  }
}

async function parseResponse(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text.trim()) {
    return {};
  }

  try {
    return JSON.parse(text) as unknown;
  } catch {
    return {
      error: text
    };
  }
}

export function normalizeBridgeBaseUrl(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }

  return trimmed.replace(/\/+$/, '');
}
