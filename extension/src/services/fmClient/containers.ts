import { randomUUID } from 'crypto';
import type { ConnectionProfile, ContainerUploadFile, EditRecordResult } from '../../types/fm';
import { isProxyProfile } from '../../types/fm';
import { FMClientError } from '../errors';
import { assertUsableUrlName } from '../../utils/urlSegment';
import type { FMClientContainerUploadOptions } from './types';
import type { ClientContext } from './context';
import { scriptErrorsOf } from './response';

export async function uploadContainer(
  client: ClientContext,
  profile: ConnectionProfile,
  layout: string,
  recordId: string,
  fieldName: string,
  file: ContainerUploadFile,
  options?: FMClientContainerUploadOptions
): Promise<EditRecordResult> {
  // Layout and field names are used exactly as given: a leading or trailing space is part of the name, and
  // trimming it would send the upload to a different layout or field (`Sales` instead of ` Sales`).
  const normalizedLayout = layout;
  const normalizedRecordId = recordId.trim();
  const normalizedFieldName = fieldName;
  assertUsableUrlName(normalizedLayout, 'layout');
  assertUsableUrlName(normalizedFieldName, 'field');
  const normalizedFileName = file.fileName.trim();
  const content = normalizeUploadContent(file.content);

  if (!normalizedLayout.trim()) {
    throw new FMClientError('Layout is required to upload container data.');
  }
  if (!normalizedRecordId) {
    throw new FMClientError('Record ID is required to upload container data.');
  }
  if (!normalizedFieldName.trim()) {
    throw new FMClientError('Container field name is required.');
  }
  if (!normalizedFileName) {
    throw new FMClientError('Upload file name is required.');
  }
  if (content.byteLength === 0) {
    throw new FMClientError('Upload file is empty.');
  }
  if (options?.maxBytes !== undefined && content.byteLength > options.maxBytes) {
    throw new FMClientError(
      `Container upload exceeds the configured limit (${content.byteLength} > ${options.maxBytes} bytes).`,
      {
        code: 'CONTAINER_UPLOAD_TOO_LARGE',
        details: {
          actualBytes: content.byteLength,
          maxBytes: options.maxBytes
        }
      }
    );
  }

  const fieldRepetition = normalizeContainerFieldRepetition(options?.fieldRepetition);
  const uploadFile = {
    ...file,
    fileName: normalizedFileName,
    content
  };

  return client.withHistory(
    {
      profileId: profile.id,
      operation: 'uploadContainer',
      layout: normalizedLayout,
      endpoint: `POST /layouts/${normalizedLayout}/records/${normalizedRecordId}/containers/${normalizedFieldName}/${fieldRepetition}`
    },
    async (trace) => {
      if (isProxyProfile(profile)) {
        return client.proxyClient.uploadContainer(
          profile,
          normalizedLayout,
          normalizedRecordId,
          normalizedFieldName,
          uploadFile,
          {
            fieldRepetition,
            modId: options?.modId,
            signal: options?.signal
          }
        );
      }

      const multipart = buildContainerUploadMultipart(uploadFile);
      const envelope = await client.requestWithAuth<Record<string, unknown>>(
        profile,
        {
          method: 'POST',
          path:
            `/layouts/${encodeURIComponent(normalizedLayout)}` +
            `/records/${encodeURIComponent(normalizedRecordId)}` +
            `/containers/${encodeURIComponent(normalizedFieldName)}/${fieldRepetition}`,
          data: multipart.body,
          transfer: 'upload',
          uploadBytes: multipart.body.byteLength,
          headers: {
            'Content-Type': multipart.contentType,
            'Content-Length': String(multipart.body.byteLength)
          },
          params: options?.modId ? { modId: options.modId } : undefined,
          signal: options?.signal
        },
        true,
        trace
      );

      return {
        recordId: normalizedRecordId,
        messages: envelope.messages,
        response: envelope.response,
        ...scriptErrorsOf(envelope.response)
      };
    }
  );
}

function normalizeUploadContent(content: Buffer | Uint8Array): Buffer {
  return Buffer.isBuffer(content) ? content : Buffer.from(content);
}

function normalizeContainerFieldRepetition(fieldRepetition: number | undefined): number {
  if (fieldRepetition === undefined) {
    return 1;
  }

  if (!Number.isInteger(fieldRepetition) || fieldRepetition < 1) {
    throw new FMClientError('Container field repetition must be a positive integer.');
  }

  return fieldRepetition;
}

function buildContainerUploadMultipart(file: ContainerUploadFile & { content: Buffer }): {
  body: Buffer;
  contentType: string;
} {
  const boundary = `----filemaker-data-api-tools-${randomUUID()}`;
  const contentType = sanitizeMultipartHeaderValue(file.contentType ?? 'application/octet-stream');
  const fileName = sanitizeMultipartHeaderValue(file.fileName);

  const header = Buffer.from(
    `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="upload"; filename="${fileName}"\r\n` +
      `Content-Type: ${contentType}\r\n\r\n`,
    'utf8'
  );
  const footer = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8');

  return {
    body: Buffer.concat([header, file.content, footer]),
    contentType: `multipart/form-data; boundary=${boundary}`
  };
}

function sanitizeMultipartHeaderValue(value: string): string {
  const normalized = value
    .replace(/[\r\n"]/g, '_')
    .replace(/\\/g, '\\\\')
    .trim();
  return normalized.length > 0 ? normalized : 'application/octet-stream';
}
