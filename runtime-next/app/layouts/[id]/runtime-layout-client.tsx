// fmweb-managed: runtime template v11. The FileMaker Data API Tools extension refreshes this file when the template version changes; keep your own changes in other files.
'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';

import { LayoutContainer, runtimeFieldKind, computeRecordPatch, recordFieldKey, validateRecordDraft, numericText, nulTextFields, removeNulText, NUL_TEXT_WARNING, type LayoutDefinition, type LayoutObject } from '@fmweb/shared';

import { executeRuntimeBehaviorAction, type RuntimeBehaviorResult } from '../../../lib/runtime-behavior';
import { useRuntimeDataController } from '../../../lib/runtime-data';
import {
  consumeNavigationIntent,
  saveNavigationIntent,
  type RuntimeNavigationIntent
} from '../../../lib/runtime-session';

interface RuntimeLayoutClientProps {
  layout: LayoutDefinition;
  serverOrigin?: string;
  initialRecordId?: string;
  initialRecordIndex?: number;
  debug?: boolean;
}

export function RuntimeLayoutClient({
  layout,
  serverOrigin,
  initialRecordId,
  initialRecordIndex,
  debug = false
}: RuntimeLayoutClientProps): React.JSX.Element {
  const router = useRouter();
  const canvasHostRef = React.useRef<HTMLDivElement | null>(null);
  const [viewport, setViewport] = React.useState<{ width: number; height: number } | undefined>(undefined);
  const [edit, setEdit] = React.useState<{
    creating: boolean; original: Record<string, unknown>; draft: Record<string, unknown>; modId?: string;
  } | undefined>();
  const [editMessage, setEditMessage] = React.useState<string | undefined>();
  const savingRef = React.useRef(false);
  const [result, setResult] = React.useState<RuntimeBehaviorResult | undefined>(undefined);
  const [navigationIntent, setNavigationIntent] = React.useState<RuntimeNavigationIntent | undefined>(undefined);

  React.useEffect(() => {
    const consumed = consumeNavigationIntent(layout.id);
    setNavigationIntent(consumed);
  }, [layout.id]);

  const resolvedInitialRecordId = initialRecordId ?? navigationIntent?.recordId;
  const resolvedInitialRecordIndex = initialRecordIndex ?? navigationIntent?.currentRecordIndex;
  const runtime = useRuntimeDataController(layout, viewport, {
    initialRecordId: resolvedInitialRecordId,
    initialRecordIndex: resolvedInitialRecordIndex
  });

  React.useEffect(() => {
    const host = canvasHostRef.current;
    if (!host || typeof ResizeObserver === 'undefined') {
      return;
    }

    const observer = new ResizeObserver((entries) => {
      const next = entries[0];
      if (!next) {
        return;
      }

      const width = Math.floor(next.contentRect.width);
      // Only the parent-controlled content width is observed. Canvas height must not
      // become a new input to its own layout (narrow forms grow vertically).
      if (width > 0) {
        setViewport((previous) => previous?.width === width ? previous : { width, height: layout.canvas.height });
      }
    });

    observer.observe(host);
    return () => observer.disconnect();
  }, [layout.canvas.height]);

  const editableFields = layout.objects.filter((object) => object.type === 'field' &&
    !['calculation', 'summary', 'container'].includes(runtimeFieldKind(object)));
  const beginEdit = (creating: boolean): void => {
    const original = creating ? {} : { ...runtime.currentRecord?.fieldData };
    setEdit({ creating, original, draft: { ...original }, modId: creating ? undefined : runtime.currentRecord?.modId });
    setEditMessage(undefined);
  };
  const save = async (): Promise<void> => {
    if (!edit || savingRef.current) return;
    savingRef.current = true;
    try {
      const original = Object.create(null) as Record<string, unknown>;
      const draft = Object.create(null) as Record<string, unknown>;
      for (const field of editableFields) {
        if (field.type !== 'field') continue;
        // A repeated field keeps its value under `Name(1)`, so the edit is written back under the
        // key the value came from; the other repetitions of the field stay untouched.
        const name = recordFieldKey(edit.original, field.fmFieldName);
        if (Object.hasOwn(edit.original, name)) original[name] = edit.original[name];
        if (!Object.hasOwn(edit.draft, name)) continue;
        const value = edit.draft[name];
        draft[name] = field.format === 'number' && typeof value === 'string' && value !== edit.original[name]
          ? numericText(value) : value;
      }
      let values = edit.creating
        ? Object.fromEntries(Object.entries(draft).filter(([, value]) => value !== '' && value !== undefined && value !== null))
        : computeRecordPatch(original, draft);
      const names = nulTextFields(values);
      if (names.length) {
        const cleaned = removeNulText(values) as Record<string, unknown>;
        const emptied = names.filter((name) => cleaned[name] === '');
        const warning = emptied.length ? ` Removing the character will leave these fields empty: ${emptied.join(', ')}. They will be sent as empty values if you continue.` : '';
        if (!window.confirm(`NUL character (U+0000) in field(s): ${names.join(', ')}. ${NUL_TEXT_WARNING}${warning} Remove the character and continue?`)) return;
        values = edit.creating ? cleaned : computeRecordPatch(original, { ...draft, ...cleaned });
      }
      const validation = validateRecordDraft(edit.creating ? values : { ...original, ...values }, editableFields.map((field) => {
        if (field.type !== 'field') throw new Error('Expected a field.');
        return { name: field.fmFieldName, required: field.required, type: field.kind, result: field.format };
      }));
      if (!validation.valid) {
        setEditMessage(validation.errors.map((error) => `${error.field}: ${error.message}`).join(' '));
        return;
      }
      if (!edit.creating && Object.keys(values).length === 0) {
        setEdit(undefined);
        setEditMessage('No field changes to save.');
        return;
      }
      const saved = edit.creating ? await runtime.createRecord(values) : await runtime.editCurrentRecord(values, edit.modId);
      if (saved) { setEdit(undefined); setEditMessage(undefined); }
    } finally {
      savingRef.current = false;
    }
  };
  const deleteRecord = async (): Promise<void> => {
    if (savingRef.current) return;
    savingRef.current = true;
    try {
      if (window.confirm(`Delete record ${runtime.currentRecord?.recordId}? This cannot be undone.`)) await runtime.deleteCurrentRecord();
    } finally { savingRef.current = false; }
  };
  const busy = runtime.loading || edit !== undefined;

  const handleObjectAction = React.useCallback(
    async (object: LayoutObject): Promise<void> => {
      if (edit || runtime.loading) return;
      const actionResult = await executeRuntimeBehaviorAction(object, {
        layoutId: layout.id,
        layoutName: layout.name,
        fmLayoutName: layout.fmLayoutName,
        bridgeBaseUrl: '/api/bridge',
        currentRecordId: runtime.currentRecord?.recordId,
        currentRecordIndex: runtime.currentIndex,
        currentFoundSetRecordIds: runtime.foundSet.map((record) => record.recordId),
        navigateToLayout: (layoutId, state) => {
          saveNavigationIntent({
            targetLayoutId: layoutId,
            sourceLayoutId: state?.sourceLayoutId ?? layout.id,
            sourceLayoutName: state?.sourceLayoutName ?? layout.name,
            sourceFmLayoutName: state?.sourceFmLayoutName ?? layout.fmLayoutName,
            recordId: state?.recordId,
            currentRecordIndex: state?.currentRecordIndex,
            foundSetRecordIds: state?.foundSetRecordIds
          });

          const query = new URLSearchParams();
          if (state?.recordId) {
            query.set('recordId', state.recordId);
          }
          if (typeof state?.currentRecordIndex === 'number' && Number.isFinite(state.currentRecordIndex)) {
            query.set('foundIndex', String(Math.max(0, Math.floor(state.currentRecordIndex))));
          }
          if (state?.sourceLayoutId) {
            query.set('fromLayoutId', state.sourceLayoutId);
          }

          const encodedId = encodeURIComponent(layoutId);
          const queryString = query.toString();
          router.push(queryString ? `/layouts/${encodedId}?${queryString}` : `/layouts/${encodedId}`);
        },
        openUrl: (url) => {
          window.open(url, '_blank', 'noopener,noreferrer');
        },
        showDialog: (dialogId, parameter) => {
          const suffix = parameter ? `\n\nParameter: ${parameter}` : '';
          window.alert(`Dialog: ${dialogId}${suffix}`);
        }
      });

      setResult(actionResult);
    },
    [
      edit,
      runtime.loading,
      layout.fmLayoutName,
      layout.id,
      layout.name,
      router,
      runtime.currentIndex,
      runtime.currentRecord?.recordId,
      runtime.foundSet
    ]
  );

  return (
    <>
      <div className="runtime-layout-header">
        <h1>{layout.name}</h1>
        {debug ? <p>Bridge: {runtime.bridgeConfigured ? 'connected' : 'not connected'}</p> : null}
        <div className="runtime-toolbar">
          <button type="button" onClick={() => void runtime.findAll()} disabled={busy}>
            Find
          </button>
          <button
            type="button"
            onClick={runtime.prevRecord}
            disabled={busy || runtime.currentIndex <= 0}
          >
            Prev
          </button>
          <button
            type="button"
            onClick={runtime.nextRecord}
            disabled={busy || runtime.currentIndex >= runtime.foundSet.length - 1}
          >
            Next
          </button>
          <button
            type="button"
            onClick={() => void runtime.reloadRecord()}
            disabled={busy || !runtime.currentRecord}
          >
            Reload
          </button>
          {edit ? <>
            <button type="button" onClick={() => void save()} disabled={runtime.loading}>Save</button>
            <button type="button" onClick={() => { setEdit(undefined); setEditMessage(undefined); }} disabled={runtime.loading}>Cancel</button>
          </> : <>
            <button type="button" onClick={() => beginEdit(false)} disabled={busy || !runtime.currentRecord || runtime.currentRecord.modId === undefined}>Edit</button>
            <button type="button" onClick={() => beginEdit(true)} disabled={busy}>Create</button>
            <button type="button" onClick={() => void deleteRecord()} disabled={busy || !runtime.currentRecord}>Delete</button>
          </>}
        </div>
        <p>{edit?.creating ? 'New record' : runtime.currentRecord
          ? `Record ${runtime.currentIndex + 1} of ${runtime.foundSet.length} (ID ${runtime.currentRecord.recordId})`
          : 'No record selected'}</p>
      </div>
      <div className="runtime-canvas-host" ref={canvasHostRef}>
        <LayoutContainer
          layout={layout}
          mode="runtime"
          onObjectAction={handleObjectAction}
          runtimeData={{ ...runtime.runtimeData, serverOrigin,
            fieldValues: edit ? edit.draft : runtime.runtimeData.fieldValues,
            creating: edit?.creating,
            editing: edit !== undefined && !runtime.loading,
            onFieldChange: (name, value) => setEdit((previous) => previous ? { ...previous, draft: { ...previous.draft, [name]: value } } : previous)
          }}
        />
      </div>
      <div className={`runtime-action-result ${runtime.errorMessage ? 'error' : ''}`}
        role={runtime.errorMessage ? 'alert' : 'status'} aria-live="polite">
        {runtime.loading ? 'Loading records…' : runtime.errorMessage ?? runtime.statusMessage}
      </div>
      {!runtime.loading && runtime.currentRecord && runtime.currentRecord.modId === undefined ? <div className="runtime-action-result" role="status">The record version is missing. Choose Reload before editing.</div> : null}
      {editMessage ? <div className="runtime-action-result" role="status">{editMessage}</div> : null}
      {result ? <div className={`runtime-action-result ${result.ok ? 'ok' : 'error'}`} role={result.ok ? 'status' : 'alert'}>
        {result.message}
      </div> : null}
    </>
  );
}
