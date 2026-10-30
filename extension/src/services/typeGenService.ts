import { createHash } from 'crypto';
import { lstat, readFile } from 'fs/promises';
import { basename, isAbsolute, relative, resolve, sep } from 'path';

import { GENERATED_MARKER, GenerationSkippedError, GenerationCancelledError, writeGeneratedFiles } from './generatedFileWriter';
import { hasInvisiblePathCharacter, PathConfinementError, resolveConfinedFile } from '../utils/pathConfinement';
import type { FMClient } from './fmClient';
import type { Logger } from './logger';
import type { SchemaService } from './schemaService';
import type {
  ConnectionProfile,
  FileMakerFieldMetadata,
  GeneratedLayoutArtifacts,
  GeneratedSnippetsArtifacts,
  GeneratedTypeScriptClientArtifacts
} from '../types/fm';
import { fieldsForGeneration } from '../utils/generatedFields';
import { hashObject } from '../utils/hash';
import { createNameMap, toPascalCaseIdentifier } from '../utils/nameSanitize';
import { commentText, distinctFileName, snippetPlaceholderText } from '../utils/safeText';

interface TypeGenServiceOptions {
  getOutputDir?: () => string;
  getWorkspaceRoot?: () => string | undefined;
  isWorkspaceTrusted?: () => boolean;
}

export class TypeGenService {
  private readonly getOutputDir: () => string;
  private readonly getWorkspaceRoot: () => string | undefined;
  private readonly isWorkspaceTrusted: () => boolean;

  public constructor(
    private readonly schemaService: SchemaService,
    private readonly fmClient: FMClient,
    private readonly logger: Pick<Logger, 'debug' | 'info' | 'warn' | 'error'>,
    options?: TypeGenServiceOptions
  ) {
    this.getOutputDir = options?.getOutputDir ?? (() => 'filemaker-types');
    this.getWorkspaceRoot = options?.getWorkspaceRoot ?? (() => undefined);
    this.isWorkspaceTrusted = options?.isWorkspaceTrusted ?? (() => true);
  }

  public async generateTypesForLayout(
    profile: ConnectionProfile,
    layout: string,
    fileStem?: string
  ): Promise<GeneratedLayoutArtifacts> {
    const schema = await this.schemaService.getLayoutSchema(profile, layout);
    if (!schema.supported) {
      throw new Error(schema.message ?? 'Schema metadata is not available for this layout.');
    }

    const metadataHash = hashObject(schema.metadata ?? schema.fields);
    const content = this.renderTypeFile(profile, layout, schema.fields, metadataHash);
    const filePath = await this.writeTypeFile(fileStem ?? sanitizeLayoutFileName(layout), content).catch((error: unknown) => {
      if (error instanceof GenerationCancelledError || error instanceof GenerationSkippedError) throw error;
      throw new GenerationOutputError(error instanceof Error ? error.message : String(error), { cause: error });
    });

    return {
      layout,
      filePath,
      content,
      metadataHash
    };
  }

  public async generateTypesForAllLayouts(profile: ConnectionProfile): Promise<GeneratedLayoutArtifacts[]> {
    const layouts = await this.fmClient.listLayouts(profile);
    const artifacts: GeneratedLayoutArtifacts[] = [];
    const fileStems = allocateLayoutFileStems(layouts);

    for (const [index, layout] of layouts.entries()) {
      try {
        artifacts.push(await this.generateTypesForLayout(profile, layout, fileStems[index]));
      } catch (error) {
        if (error instanceof GenerationCancelledError || error instanceof GenerationOutputError) throw error;
        this.logger.warn('Skipping type generation for layout due to metadata error.', {
          profileId: profile.id,
          layout,
          error
        });
      }
    }

    return artifacts;
  }

  public async generateSnippetsForLayout(
    profile: ConnectionProfile,
    layout: string
  ): Promise<GeneratedSnippetsArtifacts> {
    if (!this.isWorkspaceTrusted()) {
      throw new Error('Workspace is untrusted. Snippet generation to files is disabled.');
    }

    const root = this.getWorkspaceRoot();
    if (!root) {
      throw new Error('Open a workspace folder to generate snippets.');
    }

    const filePath = await resolveConfinedWorkspaceFile(root, 'snippets', 'filemaker-data-api.code-snippets');

    let fieldDescription = '';
    try {
      const schema = await this.schemaService.getLayoutSchema(profile, layout);
      if (schema.supported && schema.fields.length > 0) {
        fieldDescription = ' Fields: ' + fieldsForGeneration(schema.fields).map((field) =>
          `${field.name}: ${field.result ?? field.type ?? 'unknown'}${field.type ? ` (kind: ${field.type})` : ''}`
        ).join('; ');
      }
    } catch (error) {
      this.logger.warn('Field metadata is unavailable for snippet descriptions.', { layout, error });
    }

    const snippets = await this.readExistingSnippets(filePath);
    const keyPrefix = sanitizeSnippetKey(layout);

    snippets[`${keyPrefix} Find Records`] = {
      prefix: `fm find ${layout}`,
      description: `Find ${layout} records via extension client.${fieldDescription}`,
      body: [
        "const result = await vscode.commands.executeCommand('filemakerDataApiTools.runFindJson', {",
        `  profileId: '\${1:${snippetPlaceholderText(profile.id)}}',`,
        `  layout: '\${2:${snippetPlaceholderText(layout)}}'`,
        '});',
        'console.log(result);'
      ]
    };

    snippets[`${keyPrefix} Get Record`] = {
      prefix: `fm get ${layout}`,
      description: `Get ${layout} record by ID via extension client.${fieldDescription}`,
      body: [
        "await vscode.commands.executeCommand('filemakerDataApiTools.getRecordById', {",
        `  profileId: '\${1:${snippetPlaceholderText(profile.id)}}',`,
        `  layout: '\${2:${snippetPlaceholderText(layout)}}'`,
        '});'
      ]
    };

    const content = `// ${GENERATED_MARKER}\n${JSON.stringify(snippets, null, 2)}\n`;
    const skipped = await writeGeneratedFiles([{ path: filePath, content }], root);
    if (skipped.length) throw new GenerationSkippedError(filePath);

    return {
      filePath,
      content
    };
  }

  public async generateTypeScriptClient(
    profile: ConnectionProfile,
    layouts: string[],
    outputDirectory: string
  ): Promise<GeneratedTypeScriptClientArtifacts> {
    if (!this.isWorkspaceTrusted()) {
      throw new Error('Workspace is untrusted. TypeScript client generation to files is disabled.');
    }

    const selectedLayouts = normalizeLayouts(layouts);
    if (selectedLayouts.length === 0) {
      throw new Error('Choose at least one layout to generate a TypeScript client.');
    }

    if (/\.[a-z0-9]+$/i.test(basename(outputDirectory))) throw new Error('Choose an output folder, not a file name such as README.md.');
    // path-join disposition: the folder is the one the user picked in the folder picker, so it is the target root of these files.
    const outputDir = resolve(outputDirectory);

    const schemas: GeneratedClientSchema[] = [];
    for (const layout of selectedLayouts) {
      const schema = await this.schemaService.getLayoutSchema(profile, layout);
      if (!schema.supported) {
        throw new Error(
          schema.message ?? `Schema metadata is not available for layout "${layout}".`
        );
      }
      schemas.push({ layout, fields: schema.fields });
    }

    const generatedAt = new Date().toISOString();
    const layoutNames = allocateClientTypeSuffixes(selectedLayouts);
    const typesContent = renderClientTypes(profile, schemas, layoutNames, generatedAt);
    const clientContent = renderClientSource(profile, schemas, layoutNames, generatedAt);
    const readmeContent = renderClientReadme(profile, selectedLayouts, generatedAt);

    // path-join disposition: 'types.ts' is a fixed name inside the picked folder; the write is confined by writeGeneratedFiles.
    const typesPath = resolve(outputDir, 'types.ts');
    // path-join disposition: 'client.ts' is a fixed name inside the picked folder; the write is confined by writeGeneratedFiles.
    const clientPath = resolve(outputDir, 'client.ts');
    // path-join disposition: 'README.md' is a fixed name inside the picked folder; the write is confined by writeGeneratedFiles.
    const readmePath = resolve(outputDir, 'README.md');

    const workspaceRoot = this.getWorkspaceRoot();
    const outputRelative = workspaceRoot ? relative(workspaceRoot, outputDir) : undefined;
    const root = outputRelative !== undefined && outputRelative !== '..' && !outputRelative.startsWith(`..${sep}`) && !isAbsolute(outputRelative)
      ? workspaceRoot : outputDir;
    const skippedPaths = await writeGeneratedFiles([
      { path: typesPath, content: typesContent },
      { path: clientPath, content: clientContent },
      { path: readmePath, content: readmeContent }
    ], root);

    return {
      directory: outputDir,
      skippedPaths,
      typesPath,
      clientPath,
      readmePath,
      layouts: selectedLayouts
    };
  }

  private async writeTypeFile(fileStem: string, content: string): Promise<string> {
    if (!this.isWorkspaceTrusted()) {
      throw new Error('Workspace is untrusted. Type generation to files is disabled.');
    }

    const root = this.getWorkspaceRoot();
    if (!root) {
      throw new Error('Open a workspace folder to generate files.');
    }

    const outputDir = sanitizeRelativeOutputDir(this.getOutputDir());
    const fileName = `${fileStem}.ts`;
    const filePath = await resolveConfinedWorkspaceFile(root, outputDir, 'layouts', fileName);

    const skipped = await writeGeneratedFiles([{ path: filePath, content }], root);
    if (skipped.length) throw new GenerationSkippedError(filePath);

    return filePath;
  }

  private renderTypeFile(
    profile: ConnectionProfile,
    layout: string,
    fields: FileMakerFieldMetadata[],
    metadataHash: string
  ): string {
    fields = fieldsForGeneration(fields);
    const timestamp = new Date().toISOString();
    const nameMap = createNameMap(fields.map((field) => field.name));
    const baseName = toPascalCaseIdentifier(layout);
    const fieldDataTypeName = `${baseName}FieldData`;
    const rawFieldTypeName = `${baseName}RawFieldData`;
    const recordTypeName = `${baseName}Record`;
    const findRequestTypeName = `${baseName}FindRequest`;
    const findResponseTypeName = `${baseName}FindResponse`;

    const rawTypeRows = fields
      .map(renderFieldRow)
      .join('\n');

    const friendlyRows = nameMap.mappings
      .map(
        (mapping) =>
          `${fieldDoc(findField(fields, mapping.rawName))}  ${mapping.friendlyName}?: ${toTsType(findField(fields, mapping.rawName))}; // ${commentText(mapping.rawName)}`
      )
      .join('\n');

    const mapRows = nameMap.mappings
      .map((mapping) => `  ${JSON.stringify(mapping.friendlyName)}: ${JSON.stringify(mapping.rawName)},`)
      .join('\n');

    return `/**
 * ${GENERATED_MARKER}
 * AUTO-GENERATED FILE. DO NOT EDIT.
 * Generated at: ${timestamp}
 * Profile: ${commentText(profile.name)} (${commentText(profile.id)})
 * Layout: ${commentText(layout)}
 * Metadata hash (sha256): ${metadataHash}
 */

export interface ${rawFieldTypeName} {
${rawTypeRows}
}

export interface ${fieldDataTypeName} {
${friendlyRows}
}

export const ${baseName}FieldNameMap = {
${mapRows}
} as const;

export interface ${recordTypeName} {
  recordId: string;
  modId?: string;
  fieldData: ${rawFieldTypeName};
  portalData?: Record<string, Array<Record<string, unknown>>>;
}

export interface ${findRequestTypeName} {
  query: Array<Partial<${rawFieldTypeName}>>;
  sort?: Array<Record<string, unknown>>;
  limit?: number;
  offset?: number;
}

export interface ${findResponseTypeName} {
  data: ${recordTypeName}[];
  dataInfo?: Record<string, unknown>;
}
`;
  }

  private async readExistingSnippets(path: string): Promise<Record<string, unknown>> {
    try {
      const content = await readFile(path, 'utf8');
      const parsed = JSON.parse(content.replace(/^\/\/ Generated by FileMaker Data API Tools\.\r?\n/, '')) as Record<string, unknown>;
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  }
}

/** Filesystem refusals must reach the command, even when generating several layouts. */
class GenerationOutputError extends Error {}

interface GeneratedClientSchema {
  layout: string;
  fields: FileMakerFieldMetadata[];
}

function toTsType(field: FileMakerFieldMetadata | undefined): string {
  if (!field) {
    return 'unknown';
  }

  const type = `${field.result ?? field.type ?? ''}`.toLowerCase();

  if (type.includes('number') || type.includes('integer') || type.includes('float') || type.includes('decimal')) {
    return 'number';
  }

  if (type.includes('boolean')) {
    return 'boolean';
  }

  if (type.includes('timestamp') || type.includes('date') || type.includes('time')) {
    return 'string';
  }

  if (type.includes('container')) {
    return 'string';
  }

  if (type.length > 0) {
    return 'string';
  }

  return 'unknown';
}

function fieldDoc(field: FileMakerFieldMetadata | undefined): string {
  const type = String(field?.result ?? field?.type ?? '').toLowerCase();
  if (toTsType(field) === 'number') {
    return '  /** FileMaker numbers beyond 2^53 can lose precision in JavaScript. */\n';
  }
  if (/date|time/.test(type)) {
    return '  /** FileMaker date/time text uses the server locale; parse with that format. */\n';
  }
  if (type.includes('container')) {
    return '  /** Container URL returned by FileMaker. */\n';
  }
  return '';
}

function renderFieldRow(field: FileMakerFieldMetadata): string {
  return `${fieldDoc(field)}  ${JSON.stringify(field.name)}?: ${toTsType(field)};`;
}

function normalizeLayouts(layouts: string[]): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];

  for (const layout of layouts) {
    // Exactly as the server named it: ` Sales` and `Sales` are different layouts. Only an identical name is listed once.
    const value = layout;
    if (!value.trim() || seen.has(value)) {
      continue;
    }
    seen.add(value);
    normalized.push(value);
  }

  return normalized;
}

function renderClientTypes(
  profile: ConnectionProfile,
  schemas: GeneratedClientSchema[],
  layoutNames: Map<string, string>,
  generatedAt: string
): string {
  const layoutBlocks = schemas.map((schema) => {
    const suffix = typeSuffixForLayout(layoutNames, schema.layout);
    const rows = fieldsForGeneration(schema.fields)
      .map(renderFieldRow)
      .join('\n');

    return `export interface ${suffix}FieldData {
${rows}
}

export type ${suffix}Record = FileMakerRecord<${suffix}FieldData>;

export interface ${suffix}FindRequest {
  query: Array<Partial<${suffix}FieldData>>;
  sort?: Array<Record<string, unknown>>;
  limit?: number;
  offset?: number;
}`;
  });

  const recordMapRows = schemas
    .map((schema) => `  ${JSON.stringify(schema.layout)}: ${typeSuffixForLayout(layoutNames, schema.layout)}Record;`)
    .join('\n');
  const fieldDataMapRows = schemas
    .map((schema) => `  ${JSON.stringify(schema.layout)}: ${typeSuffixForLayout(layoutNames, schema.layout)}FieldData;`)
    .join('\n');
  const findRequestMapRows = schemas
    .map((schema) => `  ${JSON.stringify(schema.layout)}: ${typeSuffixForLayout(layoutNames, schema.layout)}FindRequest;`)
    .join('\n');

  return `/**
 * ${GENERATED_MARKER}
 * AUTO-GENERATED FILE. DO NOT EDIT.
 * Generated at: ${generatedAt}
 * Profile: ${commentText(profile.name)} (${commentText(profile.id)})
 * Layouts: ${schemas.map((schema) => commentText(schema.layout)).join(', ')}
 */

export interface FileMakerMessage {
  code: string;
  message: string;
}

export interface FileMakerRecord<TFieldData> {
  recordId: string;
  modId?: string;
  fieldData: TFieldData;
  portalData?: Record<string, Array<Record<string, unknown>>>;
}

${layoutBlocks.join('\n\n')}

export interface LayoutRecordMap {
${recordMapRows}
}

export interface LayoutFieldDataMap {
${fieldDataMapRows}
}

export interface LayoutFindRequestMap {
${findRequestMapRows}
}

export type LayoutName = keyof LayoutRecordMap;
`;
}

function renderClientSource(
  profile: ConnectionProfile,
  schemas: GeneratedClientSchema[],
  layoutNames: Map<string, string>,
  generatedAt: string
): string {
  const imports = schemas
    .flatMap((schema) => {
      const suffix = typeSuffixForLayout(layoutNames, schema.layout);
      return [`${suffix}FieldData`, `${suffix}FindRequest`, `${suffix}Record`];
    })
    .sort();

  const methods = schemas
    .map((schema) => renderLayoutClientMethods(schema.layout, typeSuffixForLayout(layoutNames, schema.layout)))
    .join('\n\n');

  return `/**
 * ${GENERATED_MARKER}
 * AUTO-GENERATED FILE. DO NOT EDIT.
 * Generated at: ${generatedAt}
 * Profile: ${commentText(profile.name)} (${commentText(profile.id)})
 */

import type {
  FileMakerMessage,
  ${imports.join(',\n  ')}
} from './types';

export interface FileMakerClientConfig {
  serverUrl: string;
  database: string;
  token: string;
  apiBasePath?: string;
  apiVersionPath?: string;
  fetch?: typeof fetch;
  headers?: Record<string, string>;
}

interface DataApiEnvelope<TResponse> {
  response: TResponse;
  messages: FileMakerMessage[];
}

interface FindResponse<TRecord> {
  data: TRecord[];
  dataInfo?: Record<string, unknown>;
}

interface MutateResponse {
  recordId?: string;
  modId?: string;
}

export class FileMakerDataApiError extends Error {
  public readonly code: string | undefined;
  public constructor(message: string, public readonly status: number, public readonly messages: FileMakerMessage[]) {
    super(message);
    this.name = 'FileMakerDataApiError';
    this.code = messages[0]?.code;
  }
}

export class FileMakerDataApiClient {
  private readonly fetchImpl: typeof fetch;
  private readonly baseUrl: string;

  public constructor(private readonly config: FileMakerClientConfig) {
    this.fetchImpl = config.fetch ?? globalThis.fetch;
    if (!this.fetchImpl) {
      throw new Error('No fetch implementation is available.');
    }

    const serverUrl = trimSlashes(config.serverUrl);
    const apiBasePath = trimSlashes(config.apiBasePath ?? 'fmi/data');
    const apiVersionPath = trimSlashes(config.apiVersionPath ?? 'vLatest');
    this.baseUrl = \`\${serverUrl}/\${apiBasePath}/\${apiVersionPath}/databases/\${encodeURIComponent(config.database)}\`;
  }

${indent(methods, 2)}

  private async request<TResponse>(
    path: string,
    init: RequestInit,
    allowNoRecords = false
  ): Promise<DataApiEnvelope<TResponse>> {
    const response = await this.fetchImpl(\`\${this.baseUrl}\${path}\`, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        Authorization: \`Bearer \${this.config.token}\`,
        ...this.config.headers,
        ...init.headers
      }
    });

    const text = await response.text();
    let body: DataApiEnvelope<TResponse> | undefined;
    try {
      body = text ? JSON.parse(text) as DataApiEnvelope<TResponse> : undefined;
    } catch {
      throw new FileMakerDataApiError(
        \`The server did not return Data API JSON (HTTP \${response.status}). Check the server address, API path and any proxy or gateway.\`,
        response.status, []
      );
    }
    const messages = Array.isArray(body?.messages) ? body.messages : [];
    const code = messages[0]?.code;
    if (allowNoRecords && String(code) === '401') {
      return { response: { data: [] } as TResponse, messages };
    }
    if (!response.ok || (code !== undefined && String(code) !== '0')) {
      const message = messages.map((item) => item.message).join('; ') || response.statusText;
      throw new FileMakerDataApiError(\`FileMaker Data API request failed (\${response.status}): \${message}\`, response.status, messages);
    }
    if (!body || !body.response || typeof body.response !== 'object' || !Array.isArray(body.messages)) {
      throw new FileMakerDataApiError(
        \`The server did not return Data API JSON (HTTP \${response.status}). Check the server address, API path and any proxy or gateway.\`,
        response.status, messages
      );
    }

    return body;
  }
}

function trimSlashes(value: string): string {
  return value.replace(/^\\/+|\\/+$/g, '');
}
`;
}

function renderLayoutClientMethods(layout: string, suffix: string): string {
  const encodedLayout = `\${encodeURIComponent(${JSON.stringify(layout)})}`;

  return `public async find${suffix}(request: ${suffix}FindRequest): Promise<${suffix}Record[]> {
  if (!Array.isArray(request.query) || request.query.length === 0 || request.query.some((criteria) =>
    !criteria || !Object.entries(criteria).some(([field, value]) => field !== 'omit' && value !== '' && value !== null && value !== undefined))) {
    throw new Error('Find criteria are empty. Enter at least one field value to search, or use Get records to list records.');
  }
  const envelope = await this.request<FindResponse<${suffix}Record>>(
    \`/layouts/${encodedLayout}/_find\`,
    {
      method: 'POST',
      body: JSON.stringify(request)
    },
    true
  );
  return envelope.response.data;
}

public async get${suffix}(recordId: string): Promise<${suffix}Record> {
  const envelope = await this.request<FindResponse<${suffix}Record>>(
    \`/layouts/${encodedLayout}/records/\${encodeURIComponent(recordId)}\`,
    { method: 'GET' }
  );
  const record = envelope.response.data[0];
  if (!record) {
    throw new Error(\`Record not found: \${recordId}\`);
  }
  return record;
}

public async create${suffix}(fieldData: Partial<${suffix}FieldData>): Promise<MutateResponse> {
  const envelope = await this.request<MutateResponse>(
    \`/layouts/${encodedLayout}/records\`,
    {
      method: 'POST',
      body: JSON.stringify({ fieldData })
    }
  );
  return envelope.response;
}

public async edit${suffix}(
  recordId: string,
  fieldData: Partial<${suffix}FieldData>
): Promise<MutateResponse> {
  const envelope = await this.request<MutateResponse>(
    \`/layouts/${encodedLayout}/records/\${encodeURIComponent(recordId)}\`,
    {
      method: 'PATCH',
      body: JSON.stringify({ fieldData })
    }
  );
  return envelope.response;
}

public async delete${suffix}(recordId: string): Promise<void> {
  await this.request<Record<string, never>>(
    \`/layouts/${encodedLayout}/records/\${encodeURIComponent(recordId)}\`,
    { method: 'DELETE' }
  );
}`;
}

function renderClientReadme(
  profile: ConnectionProfile,
  layouts: string[],
  generatedAt: string
): string {
  const firstLayout = layouts[0] ?? 'Layout';
  const firstMethod = typeSuffixForLayout(allocateClientTypeSuffixes(layouts), firstLayout);

  return `<!-- ${GENERATED_MARKER} -->
# FileMaker TypeScript Client

Generated at ${generatedAt} for profile \`${commentText(profile.name)}\`.

## Files

- \`types.ts\` contains interfaces for the selected layout fields and records.
- \`client.ts\` contains typed fetch wrappers for find, get, create, edit, and delete operations.

## Usage

\`\`\`ts
import { FileMakerDataApiClient } from './client';
import type { ${firstMethod}FieldData } from './types';

const client = new FileMakerDataApiClient({
  serverUrl: 'https://example.filemaker-cloud.com',
  database: '${escapeReadmeString(profile.database)}',
  token: process.env.FM_DATA_API_TOKEN ?? ''
});

const criteria: Partial<${firstMethod}FieldData> = Object.create(null);
// Replace this placeholder with a field on your layout and a non-empty search value.
Object.assign(criteria, { "REPLACE_WITH_A_FIELD_NAME": "REPLACE_WITH_A_SEARCH_VALUE" });
const records = await client.find${firstMethod}({
  query: [criteria],
  limit: 10
});
\`\`\`

Replace the field name and search value above with a field on your layout and the value to search for. A find needs at least one field value.

Selected layouts:

${layouts.map((layout) => `- ${commentText(layout)}`).join('\n')}

Start request fields with \`Object.create(null)\` as above, especially when a field is named \`constructor\`, \`toString\` or \`hasOwnProperty\`. This keeps those field names separate from JavaScript's built-in object properties.

Numbers are typed as \`number\`. Values beyond JavaScript's safe integer range (2^53 - 1), or with many decimal digits, may lose precision. Keep exact large identifiers or amounts in FileMaker text fields when needed.
Dates, times and timestamps are strings in FileMaker's locale format; they are not JavaScript Date objects. Containers are URL strings. Repeating fields use optional keys such as \`Name(1)\` through the maximum repetition.
A find with FileMaker code 401 returns an empty array, whatever the HTTP status. Other failures throw \`FileMakerDataApiError\` with \`code\`, \`status\` and \`messages\`. A web page instead of JSON gives an address/proxy check message.

Regenerating this client overwrites these files with a new timestamp.
`;
}

/** Names the generated client files declare themselves; a layout type must not reuse one. */
const RESERVED_CLIENT_TYPE_NAMES = new Set([
  'FileMakerMessage',
  'FileMakerRecord',
  'FileMakerClientConfig',
  'FileMakerDataApiError',
  'FileMakerDataApiClient',
  'DataApiEnvelope',
  'FindResponse',
  'MutateResponse',
  'LayoutRecordMap',
  'LayoutFieldDataMap',
  'LayoutFindRequestMap',
  'LayoutName'
]);

/**
 * The type name prefix of each layout (`Sales` gives `SalesFieldData`, `SalesRecord`, `SalesFindRequest`).
 * A layout called `FileMaker` would declare `FileMakerRecord` twice, so a prefix that makes a
 * reserved name gets `Layout` added; all other prefixes stay as they were.
 */
function allocateClientTypeSuffixes(layouts: string[]): Map<string, string> {
  const nameMap = createNameMap(layouts);
  const natural = new Map(layouts.map((layout): [string, string] => [layout, toPascalCaseIdentifier(nameMap.rawToFriendly[layout] ?? layout)]));
  const used = new Set(natural.values());
  const suffixes = new Map<string, string>();
  for (const [layout, suffix] of natural) {
    let chosen = suffix;
    for (let attempt = 1; isReservedClientSuffix(chosen) || (chosen !== suffix && used.has(chosen)); attempt += 1) {
      chosen = `${suffix}Layout${attempt === 1 ? '' : attempt}`;
    }
    used.add(chosen);
    suffixes.set(layout, chosen);
  }
  return suffixes;
}

function isReservedClientSuffix(suffix: string): boolean {
  return ['FieldData', 'Record', 'FindRequest'].some((name) => RESERVED_CLIENT_TYPE_NAMES.has(`${suffix}${name}`));
}

function typeSuffixForLayout(layoutNames: Map<string, string>, layout: string): string {
  return layoutNames.get(layout) ?? toPascalCaseIdentifier(layout);
}

function indent(value: string, spaces: number): string {
  const prefix = ' '.repeat(spaces);
  return value
    .split('\n')
    .map((line) => (line.length > 0 ? `${prefix}${line}` : line))
    .join('\n');
}

function escapeReadmeString(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

function findField(
  fields: FileMakerFieldMetadata[],
  fieldName: string
): FileMakerFieldMetadata | undefined {
  return fields.find((field) => field.name === fieldName);
}

function sanitizeLayoutFileName(layout: string): string {
  const normalized = layout
    .trim()
    .replace(/[^A-Za-z0-9_.-]+/g, '_')
    .replace(/^_+|_+$/g, '');

  return distinctFileName(layout, normalized);
}

/**
 * File names for a batch of layouts, the same whatever order the server lists them in.
 * `Sales` and `sales` are one file on a case-insensitive host (macOS, Windows), so every
 * layout whose sanitized name matches another's, ignoring case, gets a short hash of its raw
 * name; none of them keeps the bare name. A name that does not collide keeps its usual name.
 * A hashed name that still meets a taken name (an explicit layout that looks like a hashed
 * name) gets a numeric suffix, and names are settled in raw-name order, so the result never
 * depends on list order.
 */
function allocateLayoutFileStems(layouts: string[]): string[] {
  const unique = [...new Set(layouts)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const bases = new Map(unique.map((layout) => [layout, sanitizeLayoutFileName(layout)]));
  const groupSizes = new Map<string, number>();
  for (const base of bases.values()) {
    const key = base.toLowerCase();
    groupSizes.set(key, (groupSizes.get(key) ?? 0) + 1);
  }

  const taken = new Set<string>();
  const stems = new Map<string, string>();
  for (const layout of unique) {
    const base = bases.get(layout)!;
    const hash = createHash('sha1').update(layout).digest('hex').slice(0, 8);
    const wanted = (groupSizes.get(base.toLowerCase()) ?? 0) > 1 ? `${base}-${hash}` : base;
    let stem = wanted;
    for (let attempt = 1; taken.has(stem.toLowerCase()); attempt += 1) {
      stem = `${wanted}-${attempt}`;
    }
    taken.add(stem.toLowerCase());
    stems.set(layout, stem);
  }

  return layouts.map((layout) => stems.get(layout)!);
}

function sanitizeSnippetKey(layout: string): string {
  // ` Sales` and `Sales` are different layouts, so they must not share a snippet key (one would replace the other);
  // a name that changes when made safe gets a short hash, as file names do.
  return distinctFileName(layout, layout.replace(/[^\w\s-]+/g, '').trim(), 'Layout');
}

function sanitizeRelativeOutputDir(value: string): string {
  const normalized = value.replace(/\\/g, '/').trim().replace(/^\/+|\/+$/g, '');
  // A colon also rules out Windows drive-relative paths such as "D:folder", which are not
  // "absolute" to isAbsolute() but still leave the workspace.
  if (hasInvisiblePathCharacter(value) || !normalized || normalized.includes('..') || normalized.includes(':') || isAbsolute(normalized)) {
    return 'filemaker-types';
  }

  return normalized;
}

/**
 * The path of a generated file inside the workspace root. The shared confinement helper proves
 * that the joined path stays inside the root: a name that climbs out with "..", a path that
 * points elsewhere, or a folder that is a symbolic link is refused before anything is written.
 * The path keeps the spelling of the root the caller gave, so the file that is written is the
 * one the caller reports.
 */
export async function resolveConfinedWorkspaceFile(root: string, ...segments: string[]): Promise<string> {
  const relativePath = segments.join('/');
  // path-join disposition: guarded by resolveConfinedFile below; the path keeps the root's own spelling.
  const resolved = resolve(root, ...segments);
  const relativeToRoot = relative(root, resolved);
  // One absolute name makes the join leave the root, so the joined path itself is compared with
  // the root and not only the names that were checked.
  if (relativeToRoot === '..' || relativeToRoot.startsWith(`..${sep}`) || isAbsolute(relativeToRoot)) {
    throw new PathConfinementError('Refusing to write outside the workspace root.');
  }

  try {
    await resolveConfinedFile(relativePath, root, [root]);
  } catch (error) {
    if (!(error instanceof PathConfinementError)) throw error;
    // A link at the file itself is refused with the wording the writer uses for it; a link in
    // the folders above it is refused with the helper's own message.
    const linked = await lstat(resolved).then((stats) => stats.isSymbolicLink(), () => false);
    const reason = linked
      ? `Cannot replace ${resolved}: it is not a regular file.`
      : `${error.message} Refusing to write outside the workspace or through a symlink.`;
    throw new PathConfinementError(reason);
  }

  return resolved;
}
