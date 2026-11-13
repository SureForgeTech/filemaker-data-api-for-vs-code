import { NUL_TEXT_WARNING, nulTextFields, removeNulText } from '../../utils/nulText';
import { designerLayoutMetadata } from '../../fmweb/fieldMetadata';
import * as vscode from 'vscode';

import { isRecordModifiedConflict } from '../../services/errors';
import type { FMClient } from '../../services/fmClient';
import type { Logger } from '../../services/logger';
import type { ProfileStore } from '../../services/profileStore';
import { RecordEditService } from '../../services/recordEditService';
import type { SchemaService } from '../../services/schemaService';
import type { ConnectionProfile, EditRecordResult, FileMakerFieldMetadata, FileMakerRecord } from '../../types/fm';
import { isProxyProfile } from '../../types/fm';
import { extractPortalSpecs, sanitizeCreatePortalData, stripPortalPrefix, type CreatePortalData, type PortalRowSpec, MAX_PORTAL_ROWS_TOTAL } from '../../utils/createPortalRows';
import { buildWebviewCsp, createNonce, profileImageSources, serverOrigin } from '../common/csp';
import { guardDispatch, requestType } from '../common/dispatch';
import { getStringField, toRecord } from '../common/messageValidation';
import {
  deliverSnippet,
  parseRecordRequestPayload,
  recordOperation,
  type RecordRequestPayload
} from '../../snippets/deliver';
import { copyRecordRequestMenuHtml } from '../../snippets/recordMenuHtml';
import { describeScriptErrors } from '../../services/responseGuard';
import { isFeatureEnabled, isOfflineModeOn } from '../../utils/policySetting';
import { versionFooterHtml } from '../../about/runtimeVersion';
import { editableFieldData, metadataForField } from '../../utils/fieldAccess';

interface RecordEditorOpenOptions {
  profileId?: string;
  layout?: string;
  recordId?: string;
  mode?: 'edit' | 'create';
}

interface LoadRecordPayload {
  profileId: string;
  layout: string;
  recordId: string;
}

interface DraftPayload extends LoadRecordPayload {
  originalFieldData: Record<string, unknown>;
  draftFieldData: Record<string, unknown>;
}

const UNTRUSTED_EDITOR_MESSAGE =
  'The record editor is disabled in untrusted workspaces. Trust the workspace to edit or create records.';

interface CreateRecordPayload {
  profileId: string;
  layout: string;
  fieldData: Record<string, unknown>;
  /** Related rows to create with the record, keyed by portal name (`Portal::Field` keys inside rows). */
  portalData?: Record<string, Array<Record<string, unknown>>>;
}

const MAX_CREATE_FIELDS = 500;
const RECORD_EDIT_DISABLED_MESSAGE =
  'Record editing is disabled by the setting filemaker.features.recordEdit.enabled.';

type IncomingMessage =
  | { type: 'ready' }
  | { type: 'loadLayouts'; profileId: string }
  | { type: 'loadRecord'; payload: LoadRecordPayload }
  | { type: 'validateDraft'; payload: DraftPayload }
  | { type: 'previewPatch'; payload: DraftPayload }
  | { type: 'saveRecord'; payload: DraftPayload }
  | { type: 'createRecord'; payload: CreateRecordPayload }
  | { type: 'loadLayoutFields'; payload: { profileId: string; layout: string } }
  | { type: 'exportRecord' }
  | { type: 'copyRecordRequest'; payload: RecordRequestPayload };

export class RecordEditorPanel {
  private readonly requestsInFlight = new Set<string>();
  private static currentPanel: RecordEditorPanel | undefined;

  private pendingDefaults: RecordEditorOpenOptions | undefined;
  private loadedRecord: { profileId: string; layout: string; record: FileMakerRecord } | undefined;
  private saving = false;
  private fieldsByLayout = new Map<string, FileMakerFieldMetadata[]>();
  private portalsByLayout = new Map<string, { verified: boolean; specs: PortalRowSpec[] }>();

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly context: vscode.ExtensionContext,
    private readonly profileStore: ProfileStore,
    private readonly fmClient: FMClient,
    private readonly schemaService: SchemaService,
    private readonly logger: Logger,
    private readonly recordEditService: RecordEditService,
    defaults?: RecordEditorOpenOptions
  ) {
    this.pendingDefaults = defaults;
    this.panel.webview.html = this.getHtmlForWebview(this.panel.webview);

    this.panel.onDidDispose(() => {
      RecordEditorPanel.currentPanel = undefined;
    });

    this.panel.webview.onDidReceiveMessage((message: unknown) => {
      this.dispatch(() => this.handleMessage(message), requestType(message));
    });
  }

  public static createOrShow(
    context: vscode.ExtensionContext,
    profileStore: ProfileStore,
    fmClient: FMClient,
    schemaService: SchemaService,
    logger: Logger,
    defaults?: RecordEditorOpenOptions
  ): void {
    if (!vscode.workspace.isTrusted) {
      void vscode.window.showWarningMessage(UNTRUSTED_EDITOR_MESSAGE);
      return;
    }

    const column = vscode.ViewColumn.One;

    const current = RecordEditorPanel.currentPanel;
    if (current) {
      current.panel.reveal(column);
      current.pendingDefaults = defaults;
      current.dispatch(() => current.sendInit(), 'init');
      return;
    }

    const isCreateMode = defaults?.mode === 'create';
    const panelTitle = isCreateMode && defaults?.layout
      ? `Create Record — ${defaults.layout}`
      : 'FileMaker Record Editor';

    const panel = vscode.window.createWebviewPanel(
      'filemakerRecordEditor',
      panelTitle,
      column,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [
          vscode.Uri.joinPath(context.extensionUri, 'dist', 'webviews', 'recordEditor', 'ui')
        ]
      }
    );

    RecordEditorPanel.currentPanel = new RecordEditorPanel(
      panel,
      context,
      profileStore,
      fmClient,
      schemaService,
      logger,
      new RecordEditService(fmClient),
      defaults
    );
  }

  /**
   * The host hands the panel a message and returns; the handler runs on its own. A failure is
   * logged and posted to the page, so the user reads the reason instead of an empty panel.
   */
  private dispatch(run: () => PromiseLike<void>, type?: string): void {
    guardDispatch(run, {
      label: 'Record editor request',
      type,
      logger: this.logger,
      formatError: (error) => formatError(error),
      postError: (message) => this.postError(message)
    });
  }

  private async handleMessage(message: unknown): Promise<void> {
    const incoming = parseIncomingMessage(message);
    if (!incoming) {
      return;
    }

    // Tell the page immediately that a live extension host received Save. A trust change can
    // restart that host while leaving the old page visible; without this acknowledgement the page
    // cannot distinguish a slow confirmation from a panel whose message handler is gone.
    if (incoming.type === 'saveRecord') {
      await this.panel.webview.postMessage({ type: 'saveReceived' });
    }

    // Defence in depth: the commands refuse in an untrusted workspace, and so does every
    // message that reads or changes data, in case a panel outlives a change of trust.
    if (!vscode.workspace.isTrusted && incoming.type !== 'ready') {
      await this.postError(UNTRUSTED_EDITOR_MESSAGE);
      return;
    }

    // A user's own switch-off of record editing also applies to a panel that is already open.
    if (
      (incoming.type === 'saveRecord' || incoming.type === 'createRecord') &&
      !isFeatureEnabled(vscode.workspace.getConfiguration('filemaker'), 'features.recordEdit.enabled')
    ) {
      await this.postError(RECORD_EDIT_DISABLED_MESSAGE);
      return;
    }

    const guarded = ['loadRecord', 'saveRecord', 'createRecord'].includes(incoming.type);
    const requestKey = guarded && 'payload' in incoming ? incoming.type === 'loadRecord' ? `load:${JSON.stringify(incoming.payload)}` : 'write' : undefined;
    if (requestKey && this.requestsInFlight.has(requestKey)) return;
    if (requestKey) this.requestsInFlight.add(requestKey);
    try {
      switch (incoming.type) {
        case 'ready':
          await this.sendInit();
          break;
        case 'loadLayouts':
          await this.loadLayouts(incoming.profileId);
          break;
        case 'loadRecord':
          await this.loadRecord(incoming.payload);
          break;
        case 'validateDraft':
          await this.validateDraft(incoming.payload);
          break;
        case 'previewPatch':
          await this.previewPatch(incoming.payload);
          break;
        case 'saveRecord':
          await this.saveRecord(incoming.payload);
          break;
        case 'createRecord':
          await this.handleCreateRecord(incoming.payload);
          break;
        case 'exportRecord':
          await this.exportCurrentRecord();
          break;
        case 'copyRecordRequest':
          await this.copyRecordRequest(incoming.payload);
          break;
        case 'loadLayoutFields':
          await this.loadLayoutFields(incoming.payload);
          break;
        default:
          break;
      }
    } finally {
      if (requestKey) this.requestsInFlight.delete(requestKey);
    }
  }

  private async sendInit(): Promise<void> {
    const profiles = await this.profileStore.listProfiles();

    await this.panel.webview.postMessage({
      type: 'init',
      payload: {
        profiles: profiles.map((profile) => ({
          id: profile.id,
          name: profile.name,
          serverOrigin: serverOrigin(profile.serverUrl),
          database: profile.database
        })),
        activeProfileId: this.profileStore.getActiveProfileId(),
        defaults: this.pendingDefaults
      }
    });

    this.pendingDefaults = undefined;
  }

  private async loadLayouts(profileId: string): Promise<void> {
    const profile = await this.profileStore.getProfile(profileId);
    if (!profile) {
      await this.postError('Selected profile was not found.');
      return;
    }

    try {
      const layouts = await this.fmClient.listLayouts(profile);
      await this.panel.webview.postMessage({
        type: 'layoutsLoaded',
        payload: {
          profileId,
          layouts
        }
      });
    } catch (error) {
      await this.postError(formatError(error));
    }
  }

  private async loadRecord(payload: LoadRecordPayload): Promise<void> {
    if (this.saving) {
      await this.postError('A save is in progress. Load the record again when it finishes.');
      return;
    }

    const profile = await this.profileStore.getProfile(payload.profileId);
    if (!profile) {
      await this.postError('Selected profile was not found.');
      return;
    }

    try {
      const record = await this.fmClient.getRecord(profile, payload.layout, payload.recordId);

      const schema = await this.schemaService.getFields(profile, payload.layout);
      this.fieldsByLayout.set(this.layoutKey(payload.profileId, payload.layout), schema.fields);

      // Only now, once nothing more can fail, does the host's copy (and the modId saves are
      // checked against) change. Updating it earlier could pair a new modId with the page's
      // older draft after a failed load, letting a save overwrite someone else's change.
      this.loadedRecord = {
        profileId: payload.profileId,
        layout: payload.layout,
        record
      };

      await this.panel.webview.postMessage({
        type: 'recordLoaded',
        payload: {
          profileId: payload.profileId,
          layout: payload.layout,
          record,
          fields: schema.fields,
          presentationFields: designerLayoutMetadata(payload.layout, schema.metadata ?? { fields: schema.fields }).fields,
          metadataSupported: schema.supported,
          message: schema.message
        }
      });
    } catch (error) {
      this.logger.error('Failed to load record for editor.', {
        error,
        profileId: payload.profileId,
        layout: payload.layout,
        recordId: payload.recordId
      });
      await this.postError(formatError(error));
    }
  }

  private async validateDraft(payload: DraftPayload): Promise<void> {
    const fields = this.fieldsByLayout.get(this.layoutKey(payload.profileId, payload.layout));
    const validation = this.recordEditService.validateDraft(payload.draftFieldData, fields);

    await this.panel.webview.postMessage({
      type: 'draftValidated',
      payload: validation
    });
  }

  private async previewPatch(payload: DraftPayload): Promise<void> {
    const preview = this.recordEditService.previewPatch(payload.originalFieldData, payload.draftFieldData);
    await this.panel.webview.postMessage({
      type: 'patchPreview',
      payload: preview
    });
  }

  private async saveRecord(payload: DraftPayload): Promise<void> {
    if (isOfflineModeOn(vscode.workspace.getConfiguration('filemaker'))) {
      await this.postError('Offline mode is enabled; record writes are disabled.');
      return;
    }

    if (this.saving) {
      await this.postError('A save is already in progress.');
      return;
    }

    const profile = await this.profileStore.getProfile(payload.profileId);
    if (!profile) {
      await this.postError('Selected profile was not found.');
      return;
    }

    // The save is checked against the record as it was loaded, using the host's own copy
    // (not anything the webview sends). If the form no longer matches that record, an
    // edit could go out unchecked, so refuse and ask for a reload instead.
    const loaded = this.loadedRecord;
    if (
      !loaded ||
      loaded.profileId !== payload.profileId ||
      loaded.layout !== payload.layout ||
      !sameRecordId(loaded.record.recordId, payload.recordId)
    ) {
      await this.postError(
        'The record in the form is not the one that was loaded, so the save cannot check whether someone else changed it. Click Load, then make your changes again.'
      );
      return;
    }

    const fields = this.fieldsByLayout.get(this.layoutKey(payload.profileId, payload.layout));
    payload = { ...payload,
      originalFieldData: editableFieldData(payload.originalFieldData, fields),
      draftFieldData: editableFieldData(payload.draftFieldData, fields)
    };
    const initialPreview = this.recordEditService.previewPatch(payload.originalFieldData, payload.draftFieldData);
    if (initialPreview.changedFields.length === 0) {
      await this.postError('No field changes detected.');
      return;
    }

    const safePatch = await this.confirmNulText(initialPreview.patch);
    if (!safePatch) return;
    const draftFieldData = { ...payload.draftFieldData, ...safePatch.fields };

    const preview = this.recordEditService.previewPatch(payload.originalFieldData, draftFieldData);
    if (preview.changedFields.length === 0) {
      void vscode.window.showInformationMessage('After removing the NUL characters, the values match the original record. Nothing needs to be saved.');
      await this.panel.webview.postMessage({ type: 'saveCancelled' });
      return;
    }

    const confirmation = await vscode.window.showWarningMessage(
      `Save ${preview.changedFields.length} field changes to record ${payload.recordId}? (${preview.changedFields.join(', ')})\nRollback guidance: export the current record before save, then reapply previous values if needed.`,
      { modal: true },
      'Save'
    );

    if (confirmation !== 'Save') {
      await this.panel.webview.postMessage({
        type: 'saveCancelled'
      });
      return;
    }

    // The dialog above is a gap in which another save could have started.
    if (this.saving) {
      await this.postError('A save is already in progress.');
      return;
    }

    // Send the modification id of the record as it was loaded, so FileMaker refuses the
    // edit (error 306) if someone else changed the record in the meantime.
    const modId = loaded.record.modId;

    this.saving = true;
    try {
      let saveResult: EditRecordResult;
      try {
        saveResult = await this.recordEditService.saveRecord(
          profile,
          payload.layout,
          payload.recordId,
          payload.originalFieldData,
          draftFieldData,
          modId !== undefined ? { modId } : undefined
        );
      } catch (error) {
        if (isRecordModifiedConflict(error)) {
          await this.reportSaveConflict(profile, payload, preview.changedFields);
          return;
        }
        await this.postError(formatError(error));
        return;
      }

      warnAboutScriptErrors('Record saved', saveResult);

      try {
        const refreshedRecord = await this.fmClient.getRecord(profile, payload.layout, payload.recordId);
        this.loadedRecord = {
          profileId: payload.profileId,
          layout: payload.layout,
          record: refreshedRecord
        };

        await this.panel.webview.postMessage({
          type: 'recordSaved',
          payload: {
            saveResult,
            record: refreshedRecord
          }
        });
      } catch (error) {
        // The edit went through, so the modId held for this record is out of date. Drop it:
        // the next save is refused until the record is loaded again, instead of showing a
        // false "changed by someone else" conflict about the user's own write.
        this.loadedRecord = undefined;
        this.logger.warn('Record saved, but re-reading it failed.', {
          error,
          profileId: payload.profileId,
          layout: payload.layout,
          recordId: payload.recordId
        });
        await this.postError(
          `The change was saved, but the record could not be re-read (${formatError(error)}). Click Load before editing it again.`
        );
      }
    } finally {
      this.saving = false;
    }
  }

  /**
   * The record changed on the server after it was loaded. Nothing was written. Tell the
   * webview which fields differ now so the user can decide, and keep the draft in place
   * until they reload.
   */
  private async reportSaveConflict(
    profile: ConnectionProfile,
    payload: DraftPayload,
    yourFields: string[]
  ): Promise<void> {
    let changedByOthers: string[] = [];
    try {
      const current = await this.fmClient.getRecord(profile, payload.layout, payload.recordId);
      changedByOthers = Object.keys(
        this.recordEditService.computePatch(
          payload.originalFieldData,
          editableFieldData(current.fieldData, this.fieldsByLayout.get(this.layoutKey(payload.profileId, payload.layout)))
        )
      ).sort((left, right) => left.localeCompare(right));
    } catch (error) {
      this.logger.warn('Could not read the current record to describe an edit conflict.', {
        error,
        profileId: payload.profileId,
        layout: payload.layout,
        recordId: payload.recordId
      });
    }

    await this.panel.webview.postMessage({
      type: 'saveConflict',
      payload: {
        recordId: payload.recordId,
        changedByOthers,
        yourFields,
        overlap: yourFields.filter((field) => changedByOthers.includes(field))
      }
    });
  }

  /** Create mode: the layout's fields, so the form can list them (no record is loaded). */
  private async loadLayoutFields(payload: { profileId: string; layout: string }): Promise<void> {
    const profile = await this.profileStore.getProfile(payload.profileId);
    if (!profile) {
      await this.postError('Selected profile was not found.');
      return;
    }

    try {
      const schema = await this.schemaService.getFields(profile, payload.layout);
      this.fieldsByLayout.set(this.layoutKey(payload.profileId, payload.layout), schema.fields);
      const specs = extractPortalSpecs(schema.metadata ?? { fields: schema.fields });
      this.portalsByLayout.set(this.layoutKey(payload.profileId, payload.layout), { verified: schema.supported, specs });
      await this.panel.webview.postMessage({
        type: 'layoutFields',
        payload: {
          profileId: payload.profileId,
          layout: payload.layout,
          presentationFields: designerLayoutMetadata(payload.layout, schema.metadata ?? { fields: schema.fields }).fields,
          fields: schema.fields.map((field) => ({ name: field.name, type: field.type, global: field.global, result: field.result })),
          portals: specs,
          authMode: profile.authMode,
          metadataSupported: schema.supported,
          message: schema.message
        }
      });
    } catch (error) {
      await this.postError(formatError(error));
    }
  }

  private async handleCreateRecord(payload: CreateRecordPayload): Promise<void> {
    if (isOfflineModeOn(vscode.workspace.getConfiguration('filemaker'))) {
      await this.postError('Offline mode is enabled; record writes are disabled.');
      return;
    }
    if (this.saving) {
      await this.postError('A save is already in progress.');
      return;
    }

    const profile = await this.profileStore.getProfile(payload.profileId);
    if (!profile) {
      await this.postError('Selected profile was not found.');
      return;
    }

    let known = this.fieldsByLayout.get(this.layoutKey(payload.profileId, payload.layout));
    if (!known) {
      try {
        const schema = await this.schemaService.getFields(profile, payload.layout);
        known = schema.fields;
        this.fieldsByLayout.set(this.layoutKey(payload.profileId, payload.layout), schema.fields);
        this.portalsByLayout.set(this.layoutKey(payload.profileId, payload.layout), {
          verified: schema.supported,
          specs: extractPortalSpecs(schema.metadata ?? { fields: schema.fields })
        });
      } catch (error) {
        await this.postError(`Could not load the layout's fields: ${formatError(error).replace(/\.$/, '')}. Try again.`);
        return;
      }
    }

    let portalData: CreatePortalData | undefined;
    try {
      portalData = sanitizeCreatePortalData(payload.portalData);
    } catch (error) {
      await this.postError(formatError(error));
      return;
    }

    if (portalData && isProxyProfile(profile)) {
      await this.postError(
        'Creating related (portal) rows is not supported through a proxy connection. Create the parent record first, then add the related rows on the FileMaker layout, or use a direct Data API connection.'
      );
      return;
    }

    let nonEmptyFields = Object.fromEntries(
      Object.entries(editableFieldData(payload.fieldData, known)).filter(([, v]) => v !== '' && v !== undefined && v !== null)
    );
    const names = Object.keys(nonEmptyFields);

    // Names must be fields of the layout when its fields are known: the page cannot add
    // others, and `recordId`/`modId` are never fields to send.
    if (known?.length) {
      const unknown = names.filter((name) => !metadataForField(known, name));
      if (unknown.length > 0) {
        await this.postError(`These are not fields on layout "${payload.layout}": ${unknown.join(', ')}.`);
        return;
      }
    }

    // Related rows are validated against the layout's portal metadata when it is verified;
    // both `Portal::Field` and plain field names are accepted from the page.
    const portalsKnown = this.portalsByLayout.get(this.layoutKey(payload.profileId, payload.layout));
    if (portalData && portalsKnown?.verified) {
      const unknownPortals = Object.keys(portalData).filter(
        (portal) => !portalsKnown.specs.some((spec) => spec.portal === portal)
      );
      if (unknownPortals.length > 0) {
        await this.postError(`These are not portals on layout "${payload.layout}": ${unknownPortals.join(', ')}.`);
        return;
      }
      const unknownRowFields: string[] = [];
      for (const [portal, rows] of Object.entries(portalData)) {
        const spec = portalsKnown.specs.find((item) => item.portal === portal);
        for (const row of rows) {
          for (const fieldName of Object.keys(row)) {
            const display = stripPortalPrefix(portal, fieldName);
            if (!spec?.fields.includes(display) && !unknownRowFields.includes(display)) {
              unknownRowFields.push(display);
            }
          }
        }
      }
      if (unknownRowFields.length > 0) {
        await this.postError(
          `These are not fields of portals on layout "${payload.layout}": ${unknownRowFields.join(', ')}.`
        );
        return;
      }
    }

    if (names.length === 0 && !portalData) {
      await this.postError('At least one field must have a value, or one related row, to create a record.');
      return;
    }

    const confirmed = await this.confirmNulText(nonEmptyFields, portalData);
    if (!confirmed) return;
    nonEmptyFields = confirmed.fields;
    portalData = confirmed.portalData;

    const validation = this.recordEditService.validateDraft(nonEmptyFields, known);
    if (!validation.valid) {
      await this.postError(validation.errors.map((item) => `${item.field}: ${item.message}`).join(' | '));
      return;
    }

    const shown = names.slice(0, 10).join(', ') + (names.length > 10 ? `, and ${names.length - 10} more` : '');
    const rowCount = portalData
      ? Object.values(portalData).reduce((sum, rows) => sum + rows.length, 0)
      : 0;
    const detail =
      `Fields: ${shown}` +
      (portalData
        ? `\nRelated rows: ${Object.entries(portalData)
            .map(([portal, rows]) => `${rows.length} in ${portal}`)
            .join(', ')}.`
        : '');
    const confirmation = await vscode.window.showWarningMessage(
      `Create a new record in layout "${payload.layout}" on "${profile.name}" with ${names.length} field(s)${rowCount ? ` and ${rowCount} related row(s)` : ''}?`,
      { modal: true, detail },
      'Create'
    );

    if (confirmation !== 'Create') {
      await this.panel.webview.postMessage({ type: 'saveCancelled' });
      return;
    }

    this.saving = true;
    try {
      const result = portalData
        ? await this.fmClient.createRecord(profile, payload.layout, nonEmptyFields, undefined, { portalData })
        : await this.fmClient.createRecord(profile, payload.layout, nonEmptyFields);

      void vscode.window.showInformationMessage(`Record created (ID: ${result.recordId}).`);
      warnAboutScriptErrors('Record created', result);

      await this.panel.webview.postMessage({
        type: 'recordCreated',
        payload: { recordId: result.recordId, modId: result.modId, layout: payload.layout }
      });
    } catch (error) {
      await this.postError(formatError(error));
    } finally {
      this.saving = false;
    }
  }

  private async confirmNulText(
    fields: Record<string, unknown>,
    portalData?: CreatePortalData
  ): Promise<{ fields: Record<string, unknown>; portalData?: CreatePortalData } | undefined> {
    const names = nulTextFields(fields);
    const rowHits: string[] = [];
    for (const [portal, rows] of Object.entries(portalData ?? {})) {
      rows.forEach((row, index) => {
        if (nulTextFields(row).length > 0) {
          rowHits.push(`${portal} row ${index + 1}`);
        }
      });
    }
    if (names.length === 0 && rowHits.length === 0) return { fields, portalData };
    const cleaned = removeNulText(fields) as Record<string, unknown>;
    const cleanedPortalData = portalData
      ? Object.fromEntries(
          Object.entries(portalData).map(([portal, rows]) => [
            portal,
            rows.map((row) => removeNulText(row) as Record<string, unknown>)
          ])
        )
      : undefined;
    const empty = (value: unknown): boolean => value === '' || (Array.isArray(value) && value.every(empty));
    const emptied = names.filter((name) => empty(cleaned[name]));
    const emptyWarning = emptied.length ? ` Removing the character will leave these fields empty: ${emptied.join(', ')}. They will be sent as empty values if you continue.` : '';
    const rowWarning = rowHits.length ? ` Related rows with the character: ${rowHits.join(', ')}.` : '';
    const choice = await vscode.window.showWarningMessage(
      `NUL character (U+0000) in field(s): ${names.join(', ')}${rowHits.length ? ` and in related row(s): ${rowHits.join(', ')}` : ''}. ${NUL_TEXT_WARNING}${emptyWarning}${rowWarning}`,
      { modal: true },
      'Remove the character and continue'
    );
    if (choice !== 'Remove the character and continue') {
      await this.panel.webview.postMessage({ type: 'saveCancelled' });
      return undefined;
    }
    return { fields: cleaned, portalData: cleanedPortalData };
  }

  private async exportCurrentRecord(): Promise<void> {
    if (!this.loadedRecord) {
      await this.postError('No record has been loaded.');
      return;
    }

    const document = await vscode.workspace.openTextDocument({
      language: 'json',
      content: JSON.stringify(this.loadedRecord, null, 2)
    });

    await vscode.window.showTextDocument(document, { preview: false });
  }

  private async copyRecordRequest(payload: RecordRequestPayload): Promise<void> {
    const profile = await this.profileStore.getProfile(payload.profileId);
    if (!profile) {
      await this.postError('Selected profile was not found.');
      return;
    }

    // The fields that changed come from the host's own copy of the loaded record compared with the form,
    // so an edit request shows what Save would send. Without a loaded record it shows a field to fill in.
    const loaded = this.loadedRecord;
    const patch =
      payload.kind === 'edit' &&
      payload.draftFieldData &&
      loaded &&
      loaded.profileId === payload.profileId &&
      loaded.layout === payload.layout &&
      sameRecordId(loaded.record.recordId, payload.recordId)
        ? this.recordEditService.previewPatch(loaded.record.fieldData, payload.draftFieldData).patch
        : undefined;

    try {
      await deliverSnippet(
        profile,
        recordOperation(payload.kind, payload.layout, payload.recordId, patch),
        payload.delivery
      );
    } catch (error) {
      await this.postError(formatError(error));
    }
  }

  private layoutKey(profileId: string, layout: string): string {
    return `${profileId}::${layout}`;
  }

  private async postError(message: string): Promise<void> {
    await this.panel.webview.postMessage({
      type: 'error',
      message
    });
  }

  private getHtmlForWebview(webview: vscode.Webview): string {
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webviews', 'recordEditor', 'ui', 'styles.css')
    );

    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webviews', 'recordEditor', 'ui', 'index.js')
    );

    const standardsStyleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webviews', 'recordEditor', 'ui', 'fieldStandards.css')
    );
    const standardsScriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webviews', 'recordEditor', 'ui', 'fieldStandards.js')
    );

    const nonce = createNonce();
    const csp = buildWebviewCsp(webview, {
      nonce,
      // A container image is served by the FileMaker server of a profile.
      imageSources: profileImageSources(this.profileStore)
    });

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <title>FileMaker Record Editor</title>
  <link rel="stylesheet" href="${standardsStyleUri}" />
  <link rel="stylesheet" href="${styleUri}" />
</head>
<body>
  <div class="container">
    <header class="header">
      <h1>FileMaker Record Editor</h1>
      <p>Load a record, edit fieldData, preview patch JSON, and save safely.</p>
    </header>

    <section class="panel">
      <div class="row">
        <label for="profileSelect">Profile</label>
        <select id="profileSelect"></select>
      </div>
      <div class="row">
        <label for="layoutSelect">Layout</label>
        <select id="layoutSelect"></select>
      </div>
      <div class="row" id="recordIdRow">
        <label for="recordIdInput">Record ID</label>
        <input id="recordIdInput" type="text" placeholder="1" />
      </div>
      <div class="actions">
        <button class="secondary" id="loadButton">Load</button>
        <button class="secondary" id="validateButton">Validate</button>
        <button class="secondary" id="previewButton">Preview Update JSON</button>
        <button id="saveButton">Save</button>
        <button id="createButton" class="hidden">Create Record</button>
        <button class="secondary" id="discardButton">Discard Changes</button>
        <button class="secondary" id="exportButton">Export Record JSON</button>
        ${copyRecordRequestMenuHtml()}
      </div>
      <p id="status" class="status" role="status" aria-live="polite"></p>
      <div id="conflictBanner" class="conflict fm-banner error hidden" role="alert">
        <p id="conflictText"></p>
        <button class="secondary" id="reloadAfterConflictButton" type="button">Reload record (discard my edits)</button>
      </div>
    </section>

    <section class="panel">
      <h2>Field Data</h2>
      <p id="hiddenNote" class="status hidden" role="note"></p>
      <div id="fieldEditor"></div>
      <p id="duplicateFieldNote" class="status hidden" role="note"></p>
      <p id="fieldsFootnote" class="status" role="note">Fields your account cannot see are not listed here.</p>
      <h3 id="portalHeading" class="hidden">Related Rows</h3>
      <p id="portalNote" class="status hidden" role="note"></p>
      <div id="portalEditor"></div>
      <h3>Patch Preview</h3>
      <pre id="patchPreview" class="raw"></pre>
      <h3>Raw Record JSON</h3>
      <pre id="rawRecord" class="raw"></pre>
    </section>
  </div>

  ${versionFooterHtml()}
  <script nonce="${nonce}" src="${standardsScriptUri}"></script>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

function parseIncomingMessage(raw: unknown): IncomingMessage | undefined {
  const value = toRecord(raw);
  if (!value) {
    return undefined;
  }

  const type = getStringField(value, 'type');
  if (!type) {
    return undefined;
  }

  if (type === 'ready') {
    return { type };
  }

  const profileId = getStringField(value, 'profileId');
  if (type === 'loadLayouts' && profileId) {
    return {
      type,
      profileId
    };
  }

  if (type === 'exportRecord') {
    return { type };
  }

  if (type === 'copyRecordRequest') {
    const payload = parseRecordRequestPayload(value.payload);
    return payload ? { type, payload } : undefined;
  }

  if (type === 'loadLayoutFields' || type === 'createRecord') {
    const body = toRecord(value.payload);
    const bodyProfileId = body ? getStringField(body, 'profileId') : undefined;
    const bodyLayout = body ? getStringField(body, 'layout') : undefined;
    if (!body || !bodyProfileId || !bodyLayout) {
      return undefined;
    }
    if (type === 'loadLayoutFields') {
      return { type, payload: { profileId: bodyProfileId, layout: bodyLayout } };
    }
    const fieldData = body.fieldData;
    if (
      !fieldData ||
      typeof fieldData !== 'object' ||
      Array.isArray(fieldData) ||
      Object.keys(fieldData).length > MAX_CREATE_FIELDS
    ) {
      return undefined;
    }
    const portalData = readCreatePortalData(body.portalData);
    if (portalData === null) {
      return undefined;
    }
    return {
      type,
      payload: {
        profileId: bodyProfileId,
        layout: bodyLayout,
        fieldData: fieldData as Record<string, unknown>,
        ...(portalData ? { portalData } : {})
      }
    };
  }

  if (type === 'loadRecord' || type === 'validateDraft' || type === 'previewPatch' || type === 'saveRecord') {
    const payload = parseDraftPayload(value.payload, type === 'loadRecord');
    if (!payload) {
      return undefined;
    }

    if (type === 'loadRecord') {
      return {
        type,
        payload
      };
    }

    if (!('originalFieldData' in payload) || !('draftFieldData' in payload)) {
      return undefined;
    }

    return {
      type,
      payload
    } as IncomingMessage;
  }

  return undefined;
}

/**
 * Shape-check the related rows of a create request. Returns undefined when absent,
 * null when malformed (the message is dropped, as with other unparseable payloads);
 * the precise validation and its error messages happen in the create path itself.
 */
function readCreatePortalData(value: unknown): Record<string, Array<Record<string, unknown>>> | undefined | null {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  let total = 0;
  for (const rows of Object.values(value)) {
    if (!Array.isArray(rows)) {
      return null;
    }
    for (const row of rows) {
      if (!row || typeof row !== 'object' || Array.isArray(row)) {
        return null;
      }
      total += 1;
      if (total > MAX_PORTAL_ROWS_TOTAL) {
        return null;
      }
    }
  }
  return value as Record<string, Array<Record<string, unknown>>>;
}

function parseDraftPayload(raw: unknown, loadOnly = false): DraftPayload | undefined {
  const payload = toRecord(raw);
  if (!payload) {
    return undefined;
  }

  const profileId = getStringField(payload, 'profileId');
  const layout = getStringField(payload, 'layout');
  const recordId = getStringField(payload, 'recordId');
  if (!profileId || !layout || !recordId) {
    return undefined;
  }

  if (loadOnly) {
    return {
      profileId,
      layout,
      recordId,
      originalFieldData: {},
      draftFieldData: {}
    };
  }

  if (
    !payload.originalFieldData ||
    typeof payload.originalFieldData !== 'object' ||
    Array.isArray(payload.originalFieldData) ||
    !payload.draftFieldData ||
    typeof payload.draftFieldData !== 'object' ||
    Array.isArray(payload.draftFieldData)
  ) {
    return undefined;
  }

  return {
    profileId,
    layout,
    recordId,
    originalFieldData: payload.originalFieldData as Record<string, unknown>,
    draftFieldData: payload.draftFieldData as Record<string, unknown>
  };
}

/** Record ids are numbers, so "07" and "7" name the same record. */
function sameRecordId(left: unknown, right: unknown): boolean {
  const normalize = (value: unknown): string => {
    const text = String(value).trim();
    return /^\d+$/.test(text) ? String(Number(text)) : text;
  };
  return normalize(left) === normalize(right);
}

/** The write worked, but a script that ran with it reported an error: say so next to the success. */
function warnAboutScriptErrors(done: string, result: EditRecordResult): void {
  if (result.scriptErrors && result.scriptErrors.length > 0) {
    void vscode.window.showWarningMessage(`${done}, but ${describeScriptErrors(result.scriptErrors)}.`);
  }
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return 'Unexpected error.';
}
