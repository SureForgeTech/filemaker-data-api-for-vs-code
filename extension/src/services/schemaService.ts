import type { ConnectionProfile, FileMakerFieldMetadata, SchemaMetadataResult } from '../types/fm';
import type { FMClient } from './fmClient';
import { FMClientError } from './errors';
import { NOT_DATA_API_CODE } from './responseGuard';
import type { Logger } from './logger';
import type { OfflineModeService } from '../offline/offlineModeService';
import { buildProfileCacheKey, cacheKeyMatchesProfile } from '../utils/profileCacheKey';

interface SchemaCacheEntry {
  expiresAt: number;
  value: SchemaMetadataResult;
}

export class SchemaService {
  private readonly cache = new Map<string, SchemaCacheEntry>();
  private readonly getCacheTtlMs: () => number;
  private readonly isMetadataEnabled: () => boolean;

  public constructor(
    private readonly fmClient: FMClient,
    private readonly logger: Pick<Logger, 'debug' | 'info' | 'warn' | 'error'>,
    options?: {
      getCacheTtlMs?: () => number;
      isMetadataEnabled?: () => boolean;
      offlineModeService?: OfflineModeService;
    }
  ) {
    this.getCacheTtlMs = options?.getCacheTtlMs ?? (() => 300_000);
    this.isMetadataEnabled = options?.isMetadataEnabled ?? (() => true);
    this.offlineModeService = options?.offlineModeService;
    // The account decides which layouts and fields are visible, so whatever drops the client's
    // caches for a profile (a new sign-in, a sign-out, a profile edit) drops these too.
    fmClient.onProfileInvalidated?.((profileId) => this.invalidateProfile(profileId));
  }

  private readonly offlineModeService: OfflineModeService | undefined;

  public invalidateAll(): void {
    this.cache.clear();
  }

  public invalidateProfile(profileId: string): void {
    for (const key of this.cache.keys()) {
      if (cacheKeyMatchesProfile(key, profileId)) {
        this.cache.delete(key);
      }
    }
  }

  public invalidateLayout(profile: ConnectionProfile, layout: string): void {
    this.cache.delete(buildSchemaCacheKey(profile, layout));
  }

  public async getFields(profile: ConnectionProfile, layout: string): Promise<SchemaMetadataResult> {
    return this.getLayoutSchema(profile, layout);
  }

  public async getLayoutSchema(profile: ConnectionProfile, layout: string): Promise<SchemaMetadataResult> {
    if (!this.isMetadataEnabled()) {
      return {
        supported: false,
        fromCache: false,
        fields: [],
        message: 'Schema metadata lookups are disabled by setting filemaker.schema.metadataEnabled.'
      };
    }

    const cacheKey = buildSchemaCacheKey(profile, layout);
    const now = Date.now();

    if (this.offlineModeService?.isOfflineModeEnabled()) {
      const offlineMetadata = await this.offlineModeService.getCachedLayoutMetadata(profile, layout);
      if (!offlineMetadata) {
        return {
          supported: false,
          fromCache: false,
          fields: [],
          message: 'Offline mode is enabled and no cached metadata is available for this layout.'
        };
      }

      const fields = extractFieldsFromMetadata(offlineMetadata.metadata);
      const result: SchemaMetadataResult = {
        supported: true,
        fromCache: true,
        metadata: offlineMetadata.metadata,
        fields,
        message: `Offline metadata cache loaded (${offlineMetadata.capturedAt}).`
      };

      this.cache.set(cacheKey, {
        expiresAt: now + this.getCacheTtlMs(),
        value: result
      });

      return result;
    }

    const cached = this.cache.get(cacheKey);
    if (cached && cached.expiresAt > now) {
      return {
        ...cached.value,
        fromCache: true
      };
    }

    try {
      const metadata = await this.fmClient.getLayoutMetadata(profile, layout);
      const fields = extractFieldsFromMetadata(metadata);

      if (this.offlineModeService) {
        try {
          await this.offlineModeService.cacheLayoutMetadata(profile, layout, metadata);
        } catch (cacheError) {
          // The offline cache is optional; the schema from the server is still good.
          this.logger.warn('Failed to write the offline metadata cache.', {
            profileId: profile.id,
            layout,
            error: cacheError
          });
        }
      }

      const result: SchemaMetadataResult = {
        supported: true,
        fromCache: false,
        metadata,
        fields,
        message:
          fields.length === 0
            ? 'No field metadata returned for this layout on this server.'
            : undefined
      };

      this.cache.set(cacheKey, {
        expiresAt: now + this.getCacheTtlMs(),
        value: result
      });

      return result;
    } catch (error) {
      if (isUnsupportedMetadataError(error)) {
        const unsupported: SchemaMetadataResult = {
          supported: false,
          fromCache: false,
          fields: [],
          message: 'Metadata is not supported on this server/profile.'
        };

        this.cache.set(cacheKey, {
          expiresAt: now + this.getCacheTtlMs(),
          value: unsupported
        });

        return unsupported;
      }

      this.logger.warn('Failed to fetch layout metadata.', {
        profileId: profile.id,
        layout,
        error
      });

      throw error;
    }
  }
}

function extractFields(metadata: Record<string, unknown>): FileMakerFieldMetadata[] {
  const candidates = collectFieldArrays(metadata);

  for (const candidate of candidates) {
    const parsed = candidate
      .map((item) => toFieldMetadata(item))
      .filter((item): item is FileMakerFieldMetadata => item !== undefined);

    if (parsed.length > 0) {
      return parsed;
    }
  }

  return [];
}

export function extractFieldsFromMetadata(
  metadata: Record<string, unknown>
): FileMakerFieldMetadata[] {
  return extractFields(metadata);
}

function collectFieldArrays(metadata: Record<string, unknown>): Array<Array<Record<string, unknown>>> {
  const arrays: Array<Array<Record<string, unknown>>> = [];

  const roots: unknown[] = [
    metadata.fieldMetaData,
    metadata.fields,
    metadata.fieldMetadata,
    getPath(metadata, ['layout', 'fieldMetaData']),
    getPath(metadata, ['response', 'fieldMetaData'])
  ];

  for (const root of roots) {
    if (!Array.isArray(root)) {
      continue;
    }

    const records = root.filter((item): item is Record<string, unknown> =>
      Boolean(item && typeof item === 'object' && !Array.isArray(item))
    );

    if (records.length > 0) {
      arrays.push(records);
    }
  }

  return arrays;
}

function getPath(value: Record<string, unknown>, path: string[]): unknown {
  let current: unknown = value;

  for (const key of path) {
    if (!current || typeof current !== 'object') {
      return undefined;
    }

    current = (current as Record<string, unknown>)[key];
  }

  return current;
}

function toFieldMetadata(value: Record<string, unknown>): FileMakerFieldMetadata | undefined {
  const name =
    typeof value.name === 'string'
      ? value.name
      : typeof value.fieldName === 'string'
        ? value.fieldName
        : undefined;

  if (!name) {
    return undefined;
  }

  return {
    ...value,
    name,
    result:
      typeof value.result === 'string'
        ? value.result
        : typeof value.type === 'string'
          ? value.type
          : undefined,
    type: typeof value.type === 'string' ? value.type : undefined,
    repetitions:
      typeof value.repetitions === 'number'
        ? value.repetitions
        : typeof value.maxRepeat === 'number'
          ? value.maxRepeat
          : undefined,
    validation:
      value.validation && typeof value.validation === 'object'
        ? (value.validation as Record<string, unknown>)
        : undefined
  };
}

function isUnsupportedMetadataError(error: unknown): boolean {
  if (!(error instanceof FMClientError)) {
    return false;
  }

  // 405 and 501 say the method is not implemented. A 404 means "metadata unsupported" only when it
  // carries a FileMaker error code; a bare 404 is a wrong address or a disabled Data API, which is
  // an error to report (and not to cache as "not supported").
  if (error.status === 405 || error.status === 501) {
    return true;
  }
  return error.status === 404 && error.code !== undefined && error.code !== NOT_DATA_API_CODE;
}

export function normalizeSchemaCacheTtlMs(seconds: number): number {
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return 300_000;
  }

  return Math.round(seconds * 1000);
}

function buildSchemaCacheKey(profile: ConnectionProfile, layout: string): string {
  return buildProfileCacheKey(profile, layout);
}
