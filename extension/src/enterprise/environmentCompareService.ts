import type {
  ConnectionProfile,
  EnvironmentCompareResult,
  EnvironmentLayoutMatrixRow,
  EnvironmentSet,
  LayoutEnvironmentDiffResult
} from '../types/fm';
import { diffSchemaFields } from '../services/schemaDiff';
import type { FMClient } from '../services/fmClient';
import type { SchemaService } from '../services/schemaService';
import { hashObjectWithAlgorithm, stableStringify } from '../utils/hash';

interface CompareOptions {
  concurrency?: number;
  hashAlgorithm?: string;
}

interface CompareProfileContext {
  profile: ConnectionProfile;
  layouts: string[];
}

export class EnvironmentCompareService {
  public constructor(
    private readonly fmClient: FMClient,
    private readonly schemaService: SchemaService,
    private readonly logger: Pick<
      {
        debug: (message: string, meta?: unknown) => void;
        warn: (message: string, meta?: unknown) => void;
      },
      'debug' | 'warn'
    >
  ) {}

  public async compareEnvironmentSet(
    environmentSet: EnvironmentSet,
    profiles: ConnectionProfile[],
    options?: CompareOptions
  ): Promise<EnvironmentCompareResult> {
    const resolvedProfiles = filterEnvironmentProfiles(environmentSet, profiles);
    if (resolvedProfiles.length < 2) {
      throw new Error('Environment comparison requires at least two profiles from the environment set.');
    }

    const concurrency = normalizeConcurrency(options?.concurrency);
    const hashAlgorithm = normalizeHashAlgorithm(options?.hashAlgorithm);

    const profileContexts = await this.fetchLayoutsForProfiles(resolvedProfiles, concurrency);
    const layoutNames = collectLayoutNames(profileContexts);

    const metadataCache = new Map<string, Record<string, unknown>>();
    const hashCache = new Map<string, string>();

    const rows: EnvironmentLayoutMatrixRow[] = [];

    for (const layout of layoutNames) {
      const presence: Record<string, boolean> = {};
      const metadataHashes: Record<string, string | undefined> = {};
      const scripts: Record<string, string[]> = {};

      const tasks = profileContexts
        .filter((ctx) => ctx.layouts.includes(layout))
        .map((ctx) => async () => {
          presence[ctx.profile.id] = true;

          const metadata = await this.safeLoadMetadata(ctx.profile, layout, metadataCache);
          if (!metadata) {
            metadataHashes[ctx.profile.id] = undefined;
            scripts[ctx.profile.id] = [];
            return;
          }

          const serialized = stableStringify(metadata);
          const existingHash = hashCache.get(serialized);
          const metadataHash = existingHash ?? hashObjectWithAlgorithm(metadata, hashAlgorithm);
          if (!existingHash) {
            hashCache.set(serialized, metadataHash);
          }

          metadataHashes[ctx.profile.id] = metadataHash;
          scripts[ctx.profile.id] = extractScripts(metadata);
        });

      for (const ctx of profileContexts) {
        if (!presence[ctx.profile.id]) {
          presence[ctx.profile.id] = false;
          metadataHashes[ctx.profile.id] = undefined;
          scripts[ctx.profile.id] = [];
        }
      }

      await runWithConcurrency(tasks, concurrency);

      rows.push({
        layout,
        presence,
        metadataHashes,
        scripts
      });
    }

    const differentLayouts = rows.filter((row) => hasRowDifferences(row, resolvedProfiles)).length;

    return {
      environmentSetId: environmentSet.id,
      environmentSetName: environmentSet.name,
      generatedAt: new Date().toISOString(),
      rows,
      summary: {
        profileCount: resolvedProfiles.length,
        totalLayouts: rows.length,
        differentLayouts
      }
    };
  }

  public async diffLayoutAcrossEnvironments(
    environmentSet: EnvironmentSet,
    layout: string,
    profiles: ConnectionProfile[],
    options?: CompareOptions
  ): Promise<LayoutEnvironmentDiffResult> {
    const resolvedProfiles = filterEnvironmentProfiles(environmentSet, profiles);
    if (resolvedProfiles.length < 2) {
      throw new Error('Diff across environments requires at least two profiles from the environment set.');
    }

    const concurrency = normalizeConcurrency(options?.concurrency);
    const hashAlgorithm = normalizeHashAlgorithm(options?.hashAlgorithm);
    const baseline = resolvedProfiles[0];
    if (!baseline) {
      throw new Error('Baseline profile not found for environment diff.');
    }

    const profileResults = await runWithConcurrency(
      resolvedProfiles.map((profile) => async () => {
        try {
          const schema = await this.schemaService.getLayoutSchema(profile, layout);
          if (!schema.supported || !schema.metadata) {
            return {
              profile,
              available: false,
              fields: [],
              metadataHash: undefined,
              scripts: [] as string[]
            };
          }

          return {
            profile,
            available: true,
            fields: schema.fields,
            metadataHash: hashObjectWithAlgorithm(schema.metadata, hashAlgorithm),
            scripts: extractScripts(schema.metadata)
          };
        } catch (error) {
          this.logger.warn('Failed to load metadata while diffing layout across environments.', {
            profileId: profile.id,
            layout,
            error
          });

          return {
            profile,
            available: false,
            fields: [],
            metadataHash: undefined,
            scripts: [] as string[]
          };
        }
      }),
      concurrency
    );

    const baselineResult = profileResults.find((item) => item.profile.id === baseline.id);
    const baselineFields = baselineResult?.fields ?? [];

    return {
      environmentSetId: environmentSet.id,
      environmentSetName: environmentSet.name,
      generatedAt: new Date().toISOString(),
      layout,
      baselineProfileId: baseline.id,
      profileResults: profileResults.map((entry) => {
        if (!entry.available) {
          return {
            profileId: entry.profile.id,
            available: false,
            metadataHash: undefined,
            scripts: entry.scripts,
            addedFields: [],
            removedFields: [],
            changedFields: []
          };
        }

        const diff = diffSchemaFields({
          profileId: entry.profile.id,
          layout,
          beforeFields: baselineFields,
          afterFields: entry.fields
        });

        return {
          profileId: entry.profile.id,
          available: true,
          metadataHash: entry.metadataHash,
          scripts: entry.scripts,
          addedFields: diff.added.map((field) => field.name),
          removedFields: diff.removed.map((field) => field.name),
          changedFields: diff.changed.map((field) => ({
            fieldName: field.fieldName,
            attributes: field.changes.map((change) => change.attribute)
          }))
        };
      })
    };
  }

  public toMarkdownReport(compareResult: EnvironmentCompareResult): string {
    const lines: string[] = [];
    lines.push(`# FileMaker Environment Comparison: ${compareResult.environmentSetName}`);
    lines.push('');
    lines.push(`Generated: ${compareResult.generatedAt}`);
    lines.push('');
    lines.push(
      `Summary: ${compareResult.summary.profileCount} profiles, ${compareResult.summary.totalLayouts} layouts, ${compareResult.summary.differentLayouts} differing layouts.`
    );
    lines.push('');
    lines.push('| Layout | Present Profiles | Missing Profiles | Hash Variants |');
    lines.push('| --- | --- | --- | --- |');

    for (const row of compareResult.rows) {
      const present = Object.entries(row.presence)
        .filter(([, exists]) => exists)
        .map(([profileId]) => profileId)
        .join(', ');
      const missing = Object.entries(row.presence)
        .filter(([, exists]) => !exists)
        .map(([profileId]) => profileId)
        .join(', ');
      const hashVariants = new Set(
        Object.values(row.metadataHashes).filter((value): value is string => typeof value === 'string')
      ).size;

      lines.push(`| ${[row.layout, present || '-', missing || '-', String(hashVariants)].map(markdownCell).join(' | ')} |`);
    }

    lines.push('');
    lines.push('> Note: Hash variants compare metadata payload fingerprints across profiles.');

    return lines.join('\n');
  }

  private async fetchLayoutsForProfiles(
    profiles: ConnectionProfile[],
    concurrency: number
  ): Promise<CompareProfileContext[]> {
    const tasks = profiles.map((profile) => async () => {
      const layouts = await this.fmClient.listLayouts(profile);
      return {
        profile,
        layouts
      } satisfies CompareProfileContext;
    });

    return runWithConcurrency(tasks, concurrency);
  }

  private async safeLoadMetadata(
    profile: ConnectionProfile,
    layout: string,
    metadataCache: Map<string, Record<string, unknown>>
  ): Promise<Record<string, unknown> | undefined> {
    const cacheKey = `${profile.id}::${layout}`;
    const cached = metadataCache.get(cacheKey);
    if (cached) {
      return cached;
    }

    try {
      const schema = await this.schemaService.getLayoutSchema(profile, layout);
      if (!schema.supported || !schema.metadata) {
        return undefined;
      }

      metadataCache.set(cacheKey, schema.metadata);
      return schema.metadata;
    } catch (error) {
      this.logger.warn('Skipping metadata hash for layout due to metadata fetch failure.', {
        profileId: profile.id,
        layout,
        error
      });
      return undefined;
    }
  }
}

async function runWithConcurrency<T>(
  tasks: Array<() => Promise<T>>,
  concurrency: number
): Promise<T[]> {
  if (tasks.length === 0) {
    return [];
  }

  const normalized = normalizeConcurrency(concurrency);
  const results = new Array<T>(tasks.length);
  let cursor = 0;

  const workers = Array.from({ length: Math.min(normalized, tasks.length) }, async () => {
    while (cursor < tasks.length) {
      const current = cursor;
      cursor += 1;
      const task = tasks[current];
      if (!task) {
        continue;
      }

      results[current] = await task();
    }
  });

  await Promise.all(workers);

  return results;
}

function collectLayoutNames(profileContexts: CompareProfileContext[]): string[] {
  const set = new Set<string>();

  for (const context of profileContexts) {
    for (const layout of context.layouts) {
      set.add(layout);
    }
  }

  return Array.from(set).sort((left, right) => left.localeCompare(right));
}

function extractScripts(metadata: Record<string, unknown>): string[] {
  const candidates: unknown[] = [
    metadata.scripts,
    metadata.scriptList,
    metadata.scriptNames,
    (metadata.layout as Record<string, unknown> | undefined)?.scripts,
    (metadata.response as Record<string, unknown> | undefined)?.scripts
  ];

  for (const candidate of candidates) {
    if (!Array.isArray(candidate)) {
      continue;
    }

    const scripts = candidate
      .map((item) => {
        if (typeof item === 'string') {
          return item;
        }

        if (item && typeof item === 'object') {
          const record = item as Record<string, unknown>;
          if (typeof record.name === 'string') {
            return record.name;
          }

          if (typeof record.scriptName === 'string') {
            return record.scriptName;
          }
        }

        return undefined;
      })
      .filter((value): value is string => typeof value === 'string' && value.trim().length > 0);

    if (scripts.length > 0) {
      return Array.from(new Set(scripts)).sort((left, right) => left.localeCompare(right));
    }
  }

  return [];
}

function hasRowDifferences(row: EnvironmentLayoutMatrixRow, profiles: ConnectionProfile[]): boolean {
  const presenceValues = profiles.map((profile) => row.presence[profile.id] === true);
  const allPresent = presenceValues.every((value) => value);
  const nonePresent = presenceValues.every((value) => !value);

  if (!allPresent && !nonePresent) {
    return true;
  }

  const hashes = profiles
    .map((profile) => row.metadataHashes[profile.id])
    .filter((value): value is string => typeof value === 'string');

  const hashVariants = new Set(hashes);
  return hashVariants.size > 1;
}

function filterEnvironmentProfiles(
  environmentSet: EnvironmentSet,
  profiles: ConnectionProfile[]
): ConnectionProfile[] {
  const profileMap = new Map(profiles.map((profile) => [profile.id, profile]));

  return environmentSet.profiles
    .map((profileId) => profileMap.get(profileId))
    .filter((profile): profile is ConnectionProfile => Boolean(profile));
}

function normalizeConcurrency(value: number | undefined): number {
  if (!value || !Number.isInteger(value) || value <= 0) {
    return 4;
  }

  return Math.min(12, value);
}

function normalizeHashAlgorithm(value: string | undefined): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return 'sha256';
  }

  return value.trim();
}

function markdownCell(value: string): string {
  return value.replace(/[&\\|[\]<>`]/g, (character) => `&#${character.charCodeAt(0)};`).replace(/[\r\n\u2028\u2029]+/g, ' ');
}
