// fmweb-managed: runtime template v9. The FileMaker Data API Tools extension refreshes this file when the template version changes; keep your own changes in other files.
import * as React from 'react';

import type { LayoutDefinition, LayoutObject, RuntimeLayoutData } from '@fmweb/shared';

import { RuntimeBridgeClient, type RuntimeRecord } from './bridge-client';
import { loadLayoutSnapshot, saveLayoutSnapshot } from './runtime-session';

export interface RuntimeDataState {
  bridgeConfigured: boolean;
  foundSet: RuntimeRecord[];
  currentRecord?: RuntimeRecord;
  currentIndex: number;
  statusMessage: string;
  errorMessage?: string;
  loading: boolean;
  runtimeData: RuntimeLayoutData;
}

export interface RuntimeDataActions {
  findAll: () => Promise<void>;
  reloadRecord: () => Promise<void>;
  nextRecord: () => void;
  prevRecord: () => void;
  createRecord: (fieldData: Record<string, unknown>) => Promise<boolean>;
  editCurrentRecord: (fieldData: Record<string, unknown>, modId?: string) => Promise<boolean>;
  deleteCurrentRecord: () => Promise<void>;
}

export interface RuntimeDataControllerOptions {
  initialRecordId?: string;
  initialRecordIndex?: number;
}

export function useRuntimeDataController(
  layout: LayoutDefinition,
  viewport: { width: number; height: number } | undefined,
  options?: RuntimeDataControllerOptions
): RuntimeDataState & RuntimeDataActions {
  const bridgeClient = React.useMemo(
    () => new RuntimeBridgeClient('/api/bridge'),
    []
  );

  const initialRecordId = normalizeString(options?.initialRecordId);
  const initialRecordIndex =
    typeof options?.initialRecordIndex === 'number' && Number.isFinite(options.initialRecordIndex)
      ? Math.max(0, Math.floor(options.initialRecordIndex))
      : undefined;

  const [foundSet, setFoundSet] = React.useState<RuntimeRecord[]>([]);
  const [currentIndex, setCurrentIndex] = React.useState(0);
  const [statusMessage, setStatusMessage] = React.useState('Loading records…');
  const [loading, setLoading] = React.useState(true);
  const [errorMessage, setErrorMessage] = React.useState<string | undefined>();
  const initialFindRef = React.useRef(false);
  const [snapshotReady, setSnapshotReady] = React.useState(false);
  const initialRecordHydratedRef = React.useRef(false);
  const initialIndexAppliedRef = React.useRef(false);
  const layoutSnapshotKey = React.useMemo(
    () => ({
      id: layout.id,
      name: layout.name,
      fmLayoutName: layout.fmLayoutName
    }),
    [layout.fmLayoutName, layout.id, layout.name]
  );

  const currentRecord = foundSet[currentIndex];
  const runtimeData = React.useMemo<RuntimeLayoutData>(() => {
    return {
      fieldValues: currentRecord?.fieldData ?? {},
      portalRowsByObjectId: resolvePortalRows(layout, currentRecord),
      viewport
    };
  }, [currentRecord, layout, viewport]);

  const withAsyncStatus = React.useCallback(async <T,>(task: () => Promise<T>): Promise<T> => {
    setLoading(true);
    setErrorMessage(undefined);
    try {
      return await task();
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    const snapshot = loadLayoutSnapshot(layoutSnapshotKey);
    if (snapshot && snapshot.foundSet.length > 0) {
      setFoundSet(snapshot.foundSet);
      setCurrentIndex(Math.max(0, Math.min(snapshot.currentIndex, snapshot.foundSet.length - 1)));
      setStatusMessage(`Showing ${snapshot.foundSet.length} saved record(s).`);
    }

    setSnapshotReady(true);
    initialFindRef.current = false;
    initialRecordHydratedRef.current = false;
    initialIndexAppliedRef.current = false;
  }, [layoutSnapshotKey]);

  React.useEffect(() => {
    if (!snapshotReady) {
      return;
    }

    saveLayoutSnapshot(layoutSnapshotKey, foundSet, currentIndex);
  }, [currentIndex, foundSet, layoutSnapshotKey, snapshotReady]);

  React.useEffect(() => {
    if (initialIndexAppliedRef.current) {
      return;
    }

    if (initialRecordId || initialRecordIndex === undefined || foundSet.length === 0) {
      return;
    }

    initialIndexAppliedRef.current = true;
    setCurrentIndex(Math.max(0, Math.min(initialRecordIndex, foundSet.length - 1)));
  }, [foundSet.length, initialRecordId, initialRecordIndex]);

  React.useEffect(() => {
    if (!snapshotReady || initialRecordHydratedRef.current) {
      return;
    }

    if (!initialRecordId) return;
    if (!bridgeClient.isConfigured()) {
      setErrorMessage('The preview is not connected to FileMaker. Start the FM Web preview from the extension and try again.');
      setLoading(false);
      return;
    }

    const existingIndex = foundSet.findIndex((record) => record.recordId === initialRecordId);
    if (existingIndex >= 0) {
      initialRecordHydratedRef.current = true;
      setLoading(false);
      if (existingIndex !== currentIndex) {
        setCurrentIndex(existingIndex);
      }
      return;
    }

    let cancelled = false;
    void withAsyncStatus(async () => {
      try {
        const record = await bridgeClient.getRecord(layout.fmLayoutName ?? layout.name, initialRecordId);
        if (cancelled) {
          return;
        }

        initialRecordHydratedRef.current = true;
        setFoundSet((existing) => [record, ...existing.filter((item) => item.recordId !== record.recordId)]);
        setCurrentIndex(0);
        setStatusMessage(`Loaded navigation record ${record.recordId}.`);
      } catch (error) {
        if (cancelled) {
          return;
        }

        initialRecordHydratedRef.current = true;
        setErrorMessage(`The requested record could not be loaded. ${formatError(error)}`);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [bridgeClient, currentIndex, foundSet, initialRecordId, layout.fmLayoutName, layout.name, snapshotReady, withAsyncStatus]);

  const findAll = React.useCallback(async (): Promise<void> => {
    if (!bridgeClient.isConfigured()) {
      setErrorMessage('The preview is not connected to FileMaker. Start the FM Web preview from the extension and try again.');
      setLoading(false);
      return;
    }

    await withAsyncStatus(async () => {
      try {
        const result = await bridgeClient.find({
          layout: layout.fmLayoutName ?? layout.name,
          query: [{}],
          limit: 100
        });
        setFoundSet(result.data ?? []);
        setCurrentIndex(0);
        setStatusMessage(result.data?.length ? `Showing ${result.data.length} record(s).` : 'No records on this layout. Choose Create to add a record, or Find to try again.');
      } catch (error) {
        setErrorMessage(formatError(error));
      }
    });
  }, [bridgeClient, layout.fmLayoutName, layout.name, withAsyncStatus]);

  React.useEffect(() => {
    if (!snapshotReady || initialFindRef.current || initialRecordId) return;
    initialFindRef.current = true;
    void findAll();
  }, [findAll, initialRecordId, snapshotReady]);

  const reloadRecord = React.useCallback(async (): Promise<void> => {
    if (!bridgeClient.isConfigured()) {
      setErrorMessage('The preview is not connected to FileMaker. Start the FM Web preview from the extension and try again.');
      setLoading(false);
      return;
    }

    if (!currentRecord) {
      setStatusMessage('No current record to reload.');
      return;
    }

    await withAsyncStatus(async () => {
      try {
        const refreshed = await bridgeClient.getRecord(
          layout.fmLayoutName ?? layout.name,
          currentRecord.recordId
        );
        setFoundSet((existing) =>
          existing.map((item) => (item.recordId === refreshed.recordId ? refreshed : item))
        );
        setStatusMessage(`Reloaded record ${currentRecord.recordId}.`);
      } catch (error) {
        setErrorMessage(formatError(error));
      }
    });
  }, [bridgeClient, currentRecord, layout.fmLayoutName, layout.name, withAsyncStatus]);

  const nextRecord = React.useCallback(() => {
    setCurrentIndex((value) => Math.max(0, Math.min(foundSet.length - 1, value + 1)));
    setStatusMessage('');
  }, [foundSet.length]);

  const prevRecord = React.useCallback(() => {
    setCurrentIndex((value) => Math.max(0, value - 1));
    setStatusMessage('');
  }, []);

  const createRecord = React.useCallback(
    async (fieldData: Record<string, unknown>): Promise<boolean> => {
      if (!bridgeClient.isConfigured()) {
        setErrorMessage('The preview is not connected to FileMaker. Start the FM Web preview from the extension and try again.');
        setLoading(false);
        return false;
      }

      return withAsyncStatus(async () => {
        try {
          const created = await bridgeClient.createRecord(layout.fmLayoutName ?? layout.name, fieldData);
          let record: RuntimeRecord = { recordId: created.recordId, modId: created.modId, fieldData };
          try {
            record = await bridgeClient.getRecord(layout.fmLayoutName ?? layout.name, created.recordId);
          } catch (error) {
            setErrorMessage(`Record ${created.recordId} was created, but could not be reloaded. Choose Reload before editing. ${formatError(error)}`);
          }
          setFoundSet((existing) => [...existing, record]);
          setCurrentIndex(foundSet.length);
          setStatusMessage(`Created record ${created.recordId}.`);
          return true;
        } catch (error) {
          setErrorMessage(formatError(error));
          return false;
        }
      });
    },
    [bridgeClient, foundSet.length, layout.fmLayoutName, layout.name, withAsyncStatus]
  );

  const editCurrentRecord = React.useCallback(
    async (fieldData: Record<string, unknown>, modId?: string): Promise<boolean> => {
      if (!bridgeClient.isConfigured()) {
        setErrorMessage('The preview is not connected to FileMaker. Start the FM Web preview from the extension and try again.');
        setLoading(false);
        return false;
      }

      if (!currentRecord) {
        setStatusMessage('No current record to edit.');
        return false;
      }

      return withAsyncStatus(async () => {
        try {
          const saved = await bridgeClient.editRecord(layout.fmLayoutName ?? layout.name, currentRecord.recordId, fieldData, modId);
          let refreshed: RuntimeRecord = { ...currentRecord, modId: saved.modId, fieldData: { ...currentRecord.fieldData, ...fieldData } };
          try {
            refreshed = await bridgeClient.getRecord(layout.fmLayoutName ?? layout.name, currentRecord.recordId);
          } catch (error) {
            setErrorMessage(`Record ${currentRecord.recordId} was saved, but could not be reloaded. Choose Reload before editing. ${formatError(error)}`);
          }
          setFoundSet((existing) =>
            existing.map((item) => (item.recordId === refreshed.recordId ? refreshed : item))
          );
          setStatusMessage(`Saved record ${currentRecord.recordId}.`);
          return true;
        } catch (error) {
          setErrorMessage(formatError(error));
          return false;
        }
      });
    },
    [bridgeClient, currentRecord, layout.fmLayoutName, layout.name, withAsyncStatus]
  );

  const deleteCurrentRecord = React.useCallback(async (): Promise<void> => {
    if (!bridgeClient.isConfigured()) {
      setErrorMessage('The preview is not connected to FileMaker. Start the FM Web preview from the extension and try again.');
      setLoading(false);
      return;
    }

    if (!currentRecord) {
      setStatusMessage('No current record to delete.');
      return;
    }

    await withAsyncStatus(async () => {
      try {
        await bridgeClient.deleteRecord(layout.fmLayoutName ?? layout.name, currentRecord.recordId);
        setFoundSet((existing) => existing.filter((item) => item.recordId !== currentRecord.recordId));
        setCurrentIndex((value) => Math.max(0, Math.min(value, foundSet.length - 2)));
        setStatusMessage(`Deleted record ${currentRecord.recordId}.`);
      } catch (error) {
        setErrorMessage(formatError(error));
      }
    });
  }, [bridgeClient, currentRecord, foundSet.length, layout.fmLayoutName, layout.name, withAsyncStatus]);

  return {
    bridgeConfigured: bridgeClient.isConfigured(),
    foundSet,
    currentRecord,
    currentIndex,
    statusMessage,
    errorMessage,
    loading,
    runtimeData,
    findAll,
    reloadRecord,
    nextRecord,
    prevRecord,
    createRecord,
    editCurrentRecord,
    deleteCurrentRecord
  };
}

function normalizeString(value: string | undefined): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function resolvePortalRows(
  layout: LayoutDefinition,
  currentRecord: RuntimeRecord | undefined
): RuntimeLayoutData['portalRowsByObjectId'] {
  const mapped: NonNullable<RuntimeLayoutData['portalRowsByObjectId']> = {};
  const portalData = currentRecord?.portalData ?? {};

  const portals = layout.objects.filter((item): item is Extract<LayoutObject, { type: 'portal' }> => item.type === 'portal');
  for (const portal of portals) {
    const contextKey = portal.relatedContext;
    const exact = contextKey ? portalData[contextKey] : undefined;
    if (exact && Array.isArray(exact)) {
      mapped[portal.id] = exact;
      continue;
    }

    const fallback = Object.values(portalData).find((rows) => Array.isArray(rows));
    if (fallback) {
      mapped[portal.id] = fallback;
    }
  }

  return mapped;
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return 'Unexpected runtime data error.';
}
