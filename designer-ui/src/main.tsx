import * as React from 'react';
import { createRoot } from 'react-dom/client';

import {
  createBlankLayout,
  FIELD_LAYOUT,
  LayoutContainer,
  type BehaviorBinding,
  type FieldLayoutObject,
  type LayoutDefinition,
  type LayoutObject,
  type PortalLayoutObject,
  type StandardFieldMetadata
} from '@fmweb/shared';
import {
  arrangeStandardForm,
  standardizeFields,
  createStandardField,
  nextStandardFieldPosition,
  createStarterTemplate,
  type StarterTemplate,
  type StandardPortalMetadata,
  clampRect,
  cloneLayout,
  computeDragInteraction,
  computeResizeInteraction,
  type ExecutedCommand,
  layoutsEqual,
  normalizeRect,
  popHistoryEntry,
  pushHistoryEntry,
  selectByMarquee,
  snapToGrid,
  toRect,
  type GuideLine,
  type Point,
  type Rect,
  type ResizeHandle,
  uniqueIds,
  withNormalizedZIndex
} from './canvas-engine';
import './styles.css';

type IncomingMessage =
  | {
      type: 'init';
      payload: {
        layout: LayoutDefinition;
        availableFields: string[];
        availableFieldMetadata?: StandardFieldMetadata[];
        isNewLayout?: boolean;
        templateLayoutNames?: string[];
        templateLayouts?: Array<{ layoutName: string; fields: StandardFieldMetadata[]; portals: StandardPortalMetadata[] }>;
        scripts: string[];
        projectName: string;
      };
    }
  | { type: 'templateMetadata'; payload?: { layoutName: string; fields: StandardFieldMetadata[]; portals: StandardPortalMetadata[] } }
  | { type: 'saveResult'; payload: { ok: boolean; message?: string } }
  | {
      type: 'behaviorResult';
      payload: {
        ok: boolean;
        action: string;
        stub: boolean;
        message: string;
      };
    }
  | { type: 'error'; payload: { message: string } };

type OutgoingMessage =
  | { type: 'ready' }
  | { type: 'loadTemplateMetadata'; payload: { layoutName: string } }
  | { type: 'saveLayout'; payload: { layout: LayoutDefinition; autosave: boolean } }
  | {
      type: 'executeBehavior';
      payload: {
        layoutId: string;
        layoutName: string;
        fmLayoutName?: string;
        objectId: string;
        objectName: string;
        behavior: BehaviorBinding;
      };
    };

interface VsCodeApi<T> {
  postMessage: (message: T) => void;
  setState: (state: unknown) => void;
  getState: () => unknown;
}

const TOOL_TYPES: LayoutObject['type'][] = [
  'field',
  'text',
  'button',
  'portal',
  'rectangle',
  'image',
  'tabPanel'
];

const vscode = acquireVsCodeApiSafe<OutgoingMessage>();

function acquireVsCodeApiSafe<T>(): VsCodeApi<T> {
  const globalScope = globalThis as unknown as {
    acquireVsCodeApi?: () => VsCodeApi<T>;
  };

  if (typeof globalScope.acquireVsCodeApi === 'function') {
    return globalScope.acquireVsCodeApi();
  }

  return {
    postMessage: () => undefined,
    setState: () => undefined,
    getState: () => undefined
  };
}

interface LayoutCommand {
  label: string;
  apply: (layout: LayoutDefinition) => LayoutDefinition;
}

interface FieldPalette { fields: string[]; metadata: StandardFieldMetadata[]; source: string }
type LayoutExecutedCommand = ExecutedCommand<LayoutDefinition> & { beforePalette?: FieldPalette; afterPalette?: FieldPalette };

interface DragInteraction {
  kind: 'drag';
  ids: string[];
  startPoint: Point;
  originById: Record<string, Rect>;
  before: LayoutDefinition;
  label: string;
}

interface ResizeInteraction {
  kind: 'resize';
  id: string;
  handle: ResizeHandle;
  startPoint: Point;
  before: LayoutDefinition;
  label: string;
}

interface MarqueeInteraction {
  kind: 'marquee';
  startPoint: Point;
  shift: boolean;
  baseSelection: string[];
}

type CanvasInteraction = DragInteraction | ResizeInteraction | MarqueeInteraction;

interface ToolDragPayload {
  type: LayoutObject['type'];
  fieldName?: string;
}

export function App(): React.JSX.Element {
  const [layout, setLayout] = React.useState<LayoutDefinition>(() => createBlankLayout('Untitled Layout'));
  const [fields, setFields] = React.useState<string[]>([]);
  const [fieldMetadata, setFieldMetadata] = React.useState<StandardFieldMetadata[]>([]);
  const [formColumns, setFormColumns] = React.useState<1 | 2>(1);
  const [template, setTemplate] = React.useState<StarterTemplate>('blank');
  const [templateLayoutNames, setTemplateLayoutNames] = React.useState<string[]>([]);
  const [templateSource, setTemplateSource] = React.useState('');
  const [templateLayouts, setTemplateLayouts] = React.useState<NonNullable<Extract<IncomingMessage, { type: 'init' }>['payload']['templateLayouts']>>([]);
  const [isNewLayout, setIsNewLayout] = React.useState(false);
  const [scripts, setScripts] = React.useState<string[]>([]);
  const [selectedIds, setSelectedIds] = React.useState<string[]>([]);
  const [groups, setGroups] = React.useState<Record<string, string[]>>({});
  const [consoleLines, setConsoleLines] = React.useState<string[]>([]);
  const [undoStack, setUndoStack] = React.useState<LayoutExecutedCommand[]>([]);
  const [redoStack, setRedoStack] = React.useState<LayoutExecutedCommand[]>([]);
  const [projectName, setProjectName] = React.useState('FM Web Project');
  const [isInitialized, setIsInitialized] = React.useState(false);
  const [guides, setGuides] = React.useState<GuideLine[]>([]);
  const [marqueeRect, setMarqueeRect] = React.useState<Rect | undefined>();

  const layoutRef = React.useRef(layout);
  const interactionRef = React.useRef<CanvasInteraction | undefined>(undefined);
  const interactionListenersRef = React.useRef<{
    onMove: (event: MouseEvent) => void;
    onUp: (event: MouseEvent) => void;
  } | undefined>(undefined);
  const viewportRef = React.useRef<HTMLDivElement | null>(null);
  const surfaceRef = React.useRef<HTMLDivElement | null>(null);

  const selectedObjects = React.useMemo(
    () => layout.objects.filter((item) => selectedIds.includes(item.id)),
    [layout.objects, selectedIds]
  );

  const singleSelectedObject = selectedObjects.length === 1 ? selectedObjects[0] : undefined;
  const singleSelectedField = singleSelectedObject?.type === 'field' ? singleSelectedObject : undefined;
  const singleSelectedPortal = singleSelectedObject?.type === 'portal' ? singleSelectedObject : undefined;
  const singleSelectedBehavior = singleSelectedObject?.behavior;

  const fieldChoices = React.useMemo(() => {
    if (!singleSelectedField) {
      return fields;
    }

    return uniqueIds([...fields, singleSelectedField.fmFieldName].filter((item) => item.trim().length > 0));
  }, [fields, singleSelectedField]);

  const portalFieldChoices = React.useMemo(() => {
    if (!singleSelectedPortal) {
      return fields;
    }

    const portalColumnFields = singleSelectedPortal.columns.map((column) => column.fmFieldName);
    return uniqueIds([...fields, ...portalColumnFields].filter((item) => item.trim().length > 0));
  }, [fields, singleSelectedPortal]);

  const scriptChoices = React.useMemo(() => {
    const currentScript = singleSelectedBehavior?.scriptName;
    return uniqueIds([...scripts, currentScript ?? ''].filter((item) => item.trim().length > 0));
  }, [scripts, singleSelectedBehavior]);

  const sortedObjects = React.useMemo(
    () => [...layout.objects].sort((left, right) => left.zIndex - right.zIndex),
    [layout.objects]
  );

  const log = React.useCallback((line: string) => {
    setConsoleLines((current) => [...current.slice(-80), `${new Date().toLocaleTimeString()} ${line}`]);
  }, []);

  const applyLayout = React.useCallback((next: LayoutDefinition, persistState = true): void => {
    layoutRef.current = next;
    setLayout(next);
    if (persistState) {
      vscode.setState({ layout: next });
    }
  }, []);

  const recordExecutedCommand = React.useCallback(
    (entry: LayoutExecutedCommand): void => {
      setUndoStack((current) => pushHistoryEntry(current, entry));
      setRedoStack([]);
      log(entry.label);
    },
    [log]
  );

  const executeLayoutCommand = React.useCallback(
    (command: LayoutCommand, palette?: FieldPalette): void => {
      const current = cloneLayout(layoutRef.current);
      const next = command.apply(cloneLayout(layoutRef.current));
      if (layoutsEqual(current, next)) {
        return;
      }

      const previousSource = layoutRef.current.fmLayoutName ?? templateLayouts[0]?.layoutName ?? '';
      applyLayout(next);
      recordExecutedCommand({
        label: command.label,
        before: current,
        after: next,
        beforePalette: palette ? { fields, metadata: fieldMetadata, source: previousSource } : undefined,
        afterPalette: palette
      });
      if (palette) { setFields(palette.fields); setFieldMetadata(palette.metadata); setTemplateSource(palette.source); }
    },
    [applyLayout, recordExecutedCommand, fields, fieldMetadata, templateLayouts]
  );

  const undo = React.useCallback(() => {
    setUndoStack((current) => {
      const popped = popHistoryEntry(current);
      const entry = popped.entry as LayoutExecutedCommand | undefined;
      if (!entry) {
        return current;
      }

      const restored = cloneLayout(entry.before);
      applyLayout(restored);
      if (entry.beforePalette) { setFields(entry.beforePalette.fields); setFieldMetadata(entry.beforePalette.metadata); setTemplateSource(entry.beforePalette.source); }
      setRedoStack((redoCurrent) => pushHistoryEntry(redoCurrent, entry));
      log(`Undo: ${entry.label}`);

      return popped.stack;
    });
  }, [applyLayout, log]);

  const redo = React.useCallback(() => {
    setRedoStack((current) => {
      const popped = popHistoryEntry(current);
      const entry = popped.entry as LayoutExecutedCommand | undefined;
      if (!entry) {
        return current;
      }

      const restored = cloneLayout(entry.after);
      applyLayout(restored);
      if (entry.afterPalette) { setFields(entry.afterPalette.fields); setFieldMetadata(entry.afterPalette.metadata); setTemplateSource(entry.afterPalette.source); }
      setUndoStack((undoCurrent) => pushHistoryEntry(undoCurrent, entry));
      log(`Redo: ${entry.label}`);

      return popped.stack;
    });
  }, [applyLayout, log]);

  const toCanvasPoint = React.useCallback((clientX: number, clientY: number): Point | undefined => {
    const surface = surfaceRef.current;
    const viewport = viewportRef.current;

    if (!surface || !viewport) {
      return undefined;
    }

    const rect = surface.getBoundingClientRect();

    return {
      x: clientX - rect.left + viewport.scrollLeft,
      y: clientY - rect.top + viewport.scrollTop
    };
  }, []);

  const detachInteractionListeners = React.useCallback((): void => {
    const listeners = interactionListenersRef.current;
    if (!listeners) {
      return;
    }

    window.removeEventListener('mousemove', listeners.onMove);
    window.removeEventListener('mouseup', listeners.onUp);
    interactionListenersRef.current = undefined;
  }, []);

  const attachInteractionListeners = React.useCallback((): void => {
    if (interactionListenersRef.current) {
      return;
    }

    const onMove = (event: MouseEvent): void => {
      const interaction = interactionRef.current;
      if (!interaction) {
        return;
      }

      const point = toCanvasPoint(event.clientX, event.clientY);
      if (!point) {
        return;
      }

      if (interaction.kind === 'drag') {
        const result = computeDragInteraction({
          before: interaction.before,
          ids: interaction.ids,
          originById: interaction.originById,
          startPoint: interaction.startPoint,
          nextPoint: point
        });

        applyLayout(result.layout, false);
        setGuides(result.guides);
        return;
      }

      if (interaction.kind === 'resize') {
        const result = computeResizeInteraction({
          before: interaction.before,
          id: interaction.id,
          handle: interaction.handle,
          startPoint: interaction.startPoint,
          nextPoint: point
        });

        applyLayout(result.layout, false);
        setGuides(result.guides);
        return;
      }

      if (interaction.kind === 'marquee') {
        const normalized = normalizeRect({
          x: interaction.startPoint.x,
          y: interaction.startPoint.y,
          width: point.x - interaction.startPoint.x,
          height: point.y - interaction.startPoint.y
        });

        setMarqueeRect(normalized);

        setSelectedIds(
          selectByMarquee({
            objects: layoutRef.current.objects,
            marquee: normalized,
            baseSelection: interaction.baseSelection,
            append: interaction.shift
          })
        );
      }
    };

    const onUp = (): void => {
      const interaction = interactionRef.current;
      if (!interaction) {
        detachInteractionListeners();
        return;
      }

      if (interaction.kind === 'drag' || interaction.kind === 'resize') {
        const before = interaction.before;
        const after = cloneLayout(layoutRef.current);

        if (!layoutsEqual(before, after)) {
          vscode.setState({ layout: after });
          recordExecutedCommand({
            label: interaction.label,
            before,
            after
          });
        } else {
          applyLayout(before, false);
        }
      }

      interactionRef.current = undefined;
      setGuides([]);
      setMarqueeRect(undefined);
      detachInteractionListeners();
    };

    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);

    interactionListenersRef.current = {
      onMove,
      onUp
    };
  }, [applyLayout, detachInteractionListeners, layoutRef, recordExecutedCommand, toCanvasPoint]);

  React.useEffect(() => {
    return () => {
      detachInteractionListeners();
    };
  }, [detachInteractionListeners]);

  const handleToolDragStart = React.useCallback(
    (event: React.DragEvent<HTMLElement>, payload: ToolDragPayload): void => {
      event.dataTransfer.setData('application/x-fmweb-tool', JSON.stringify(payload));
      event.dataTransfer.effectAllowed = 'copy';
    },
    []
  );

  const addToolObject = React.useCallback(
    (payload: ToolDragPayload, point?: Point): void => {
      executeLayoutCommand({
        label: `Add ${payload.type}`,
        apply: (current) => {
          const object = createObjectFromTool(
            payload,
            {
              ...(payload.type === 'field' ? nextStandardFieldPosition(current, fieldMetadata.find((field) => field.name === (payload.fieldName ?? fields[0])) ?? { name: payload.fieldName ?? fields[0] ?? 'Field' }, point) : {
                x: point ? snapToGrid(point.x, current.canvas.gridSize) : 40,
                y: point ? snapToGrid(point.y, current.canvas.gridSize) : 40
              })
            },
            current,
            fields,
            fieldMetadata
          );

          setSelectedIds([object.id]);

          return {
            ...current,
            objects: [...current.objects, object],
            canvas: { ...current.canvas, width: Math.max(current.canvas.width, object.x + object.width + FIELD_LAYOUT.pageMargin), height: Math.max(current.canvas.height, object.y + object.height + (object.type === 'field' ? FIELD_LAYOUT.labelSpace : 0) + FIELD_LAYOUT.pageMargin) }
          };
        }
      });
    },
    [executeLayoutCommand, fields, fieldMetadata]
  );

  const handleCanvasDrop = React.useCallback(
    (event: React.DragEvent<HTMLDivElement>): void => {
      event.preventDefault();
      const payloadRaw = event.dataTransfer.getData('application/x-fmweb-tool');
      if (!payloadRaw) {
        return;
      }

      const parsed = parseToolPayload(payloadRaw);
      if (!parsed) {
        return;
      }

      const point = toCanvasPoint(event.clientX, event.clientY);
      if (!point) {
        return;
      }

      addToolObject(parsed, point);
    },
    [addToolObject, toCanvasPoint]
  );

  const handleCanvasBackgroundMouseDown = React.useCallback(
    (event: React.MouseEvent<HTMLDivElement>): void => {
      if (event.button !== 0) {
        return;
      }

      const point = toCanvasPoint(event.clientX, event.clientY);
      if (!point) {
        return;
      }

      interactionRef.current = {
        kind: 'marquee',
        startPoint: point,
        shift: event.shiftKey,
        baseSelection: selectedIds
      };

      if (!event.shiftKey) {
        setSelectedIds([]);
      }

      setMarqueeRect({
        x: point.x,
        y: point.y,
        width: 0,
        height: 0
      });

      attachInteractionListeners();
    },
    [attachInteractionListeners, selectedIds, toCanvasPoint]
  );

  const handleObjectMouseDown = React.useCallback(
    (event: React.MouseEvent<HTMLDivElement>, objectId: string): void => {
      if (event.button !== 0) {
        return;
      }

      event.stopPropagation();

      const point = toCanvasPoint(event.clientX, event.clientY);
      if (!point) {
        return;
      }

      if (event.shiftKey) {
        setSelectedIds((current) =>
          current.includes(objectId)
            ? current.filter((item) => item !== objectId)
            : uniqueIds([...current, objectId])
        );
        return;
      }

      const grouped = getGroupMembersForObject(objectId, groups);
      const dragSelection = grouped.length > 0 ? grouped : [objectId];

      setSelectedIds(dragSelection);

      const originById: Record<string, Rect> = {};
      for (const id of dragSelection) {
        const item = layoutRef.current.objects.find((candidate) => candidate.id === id);
        if (!item) {
          continue;
        }

        originById[id] = toRect(item);
      }

      interactionRef.current = {
        kind: 'drag',
        ids: dragSelection,
        startPoint: point,
        originById,
        before: cloneLayout(layoutRef.current),
        label: dragSelection.length > 1 ? 'Move selected objects' : 'Move object'
      };

      attachInteractionListeners();
    },
    [attachInteractionListeners, groups, toCanvasPoint]
  );

  const handleResizeMouseDown = React.useCallback(
    (event: React.MouseEvent<HTMLButtonElement>, objectId: string, handle: ResizeHandle): void => {
      if (event.button !== 0) {
        return;
      }

      event.stopPropagation();

      const point = toCanvasPoint(event.clientX, event.clientY);
      if (!point) {
        return;
      }

      const hasObject = layoutRef.current.objects.some((candidate) => candidate.id === objectId);
      if (!hasObject) {
        return;
      }

      interactionRef.current = {
        kind: 'resize',
        id: objectId,
        handle,
        startPoint: point,
        before: cloneLayout(layoutRef.current),
        label: 'Resize object'
      };

      attachInteractionListeners();
    },
    [attachInteractionListeners, toCanvasPoint]
  );

  const removeSelected = React.useCallback((): void => {
    if (selectedIds.length === 0) {
      return;
    }

    executeLayoutCommand({
      label: selectedIds.length > 1 ? 'Delete selected objects' : 'Delete object',
      apply: (current) => ({
        ...current,
        objects: current.objects.filter((item) => !selectedIds.includes(item.id))
      })
    });

    setSelectedIds([]);
  }, [executeLayoutCommand, selectedIds]);

  const nudgeSelection = React.useCallback(
    (dx: number, dy: number): void => {
      if (selectedIds.length === 0) {
        return;
      }

      executeLayoutCommand({
        label: 'Nudge selection',
        apply: (current) => {
          const grid = current.canvas.gridSize;
          return {
            ...current,
            objects: current.objects.map((item) => {
              if (!selectedIds.includes(item.id)) {
                return item;
              }

              const moved = clampRect(
                {
                  x: snapToGrid(item.x + dx, grid),
                  y: snapToGrid(item.y + dy, grid),
                  width: item.width,
                  height: item.height
                },
                current.canvas.width,
                current.canvas.height
              );

              return {
                ...item,
                x: moved.x,
                y: moved.y
              };
            })
          };
        }
      });
    },
    [executeLayoutCommand, selectedIds]
  );

  const updateSingleSelectedName = React.useCallback(
    (name: string): void => {
      if (!singleSelectedObject) {
        return;
      }

      executeLayoutCommand({
        label: 'Rename object',
        apply: (current) => ({
          ...current,
          objects: current.objects.map((item) =>
            item.id === singleSelectedObject.id
              ? {
                  ...item,
                  name
                }
              : item
          )
        })
      });
    },
    [executeLayoutCommand, singleSelectedObject]
  );

  const updateSingleSelectedField = React.useCallback(
    (
      updates: Partial<
        Pick<FieldLayoutObject, 'fmFieldName' | 'displayType' | 'format' | 'labelPosition' | 'required' | 'label'>
      >
    ): void => {
      if (!singleSelectedField) {
        return;
      }

      executeLayoutCommand({
        label: 'Update field properties',
        apply: (current) => ({
          ...current,
          objects: current.objects.map((item) =>
            item.id === singleSelectedField.id && item.type === 'field'
              ? {
                  ...item,
                  ...updates
                }
              : item
          )
        })
      });
    },
    [executeLayoutCommand, singleSelectedField]
  );

  const updateSingleSelectedPortal = React.useCallback(
    (
      updates: Partial<Pick<PortalLayoutObject, 'relatedContext' | 'rowCount' | 'scroll' | 'selectableRows'>>
    ): void => {
      if (!singleSelectedPortal) {
        return;
      }

      executeLayoutCommand({
        label: 'Update portal properties',
        apply: (current) => ({
          ...current,
          objects: current.objects.map((item) =>
            item.id === singleSelectedPortal.id && item.type === 'portal'
              ? {
                  ...item,
                  ...updates
                }
              : item
          )
        })
      });
    },
    [executeLayoutCommand, singleSelectedPortal]
  );

  const setSingleSelectedBehavior = React.useCallback(
    (behavior: BehaviorBinding | undefined, label: string): void => {
      if (!singleSelectedObject) {
        return;
      }

      executeLayoutCommand({
        label,
        apply: (current) => ({
          ...current,
          objects: current.objects.map((item) =>
            item.id === singleSelectedObject.id
              ? {
                  ...item,
                  behavior
                }
              : item
          )
        })
      });
    },
    [executeLayoutCommand, singleSelectedObject]
  );

  const updateSingleSelectedBehavior = React.useCallback(
    (updates: Partial<BehaviorBinding>, label = 'Update behavior binding'): void => {
      if (!singleSelectedObject) {
        return;
      }

      const nextBehavior: BehaviorBinding = {
        ...(singleSelectedObject.behavior ?? {}),
        ...updates
      };

      if (!nextBehavior.type) {
        setSingleSelectedBehavior(undefined, label);
        return;
      }

      setSingleSelectedBehavior(nextBehavior, label);
    },
    [setSingleSelectedBehavior, singleSelectedObject]
  );

  const setSingleSelectedBehaviorType = React.useCallback(
    (value: string): void => {
      if (!singleSelectedObject) {
        return;
      }

      if (!value) {
        setSingleSelectedBehavior(undefined, 'Clear behavior binding');
        return;
      }

      const nextType = value as Exclude<BehaviorBinding['type'], undefined>;
      const nextBehavior = createBehaviorDefaults(nextType, singleSelectedObject.behavior, scripts);
      setSingleSelectedBehavior(nextBehavior, 'Set behavior binding');
    },
    [scripts, setSingleSelectedBehavior, singleSelectedObject]
  );

  const triggerBehaviorForObject = React.useCallback(
    (objectId: string): void => {
      const currentObject = layoutRef.current.objects.find((item) => item.id === objectId);
      if (!currentObject?.behavior?.type) {
        log(`No behavior binding configured for object ${currentObject?.name ?? objectId}.`);
        return;
      }

      vscode.postMessage({
        type: 'executeBehavior',
        payload: {
          layoutId: layoutRef.current.id,
          layoutName: layoutRef.current.name,
          fmLayoutName: layoutRef.current.fmLayoutName,
          objectId: currentObject.id,
          objectName: currentObject.name,
          behavior: currentObject.behavior
        }
      });
      log(`Previewed ${currentObject.behavior.type} on ${currentObject.name}.`);
    },
    [log]
  );

  const triggerBehaviorPreview = React.useCallback((): void => {
    if (!singleSelectedObject) {
      log('Select one object to preview behavior.');
      return;
    }

    triggerBehaviorForObject(singleSelectedObject.id);
  }, [log, singleSelectedObject, triggerBehaviorForObject]);

  const addPortalColumn = React.useCallback(
    (fieldName: string): void => {
      if (!singleSelectedPortal || !fieldName.trim()) {
        return;
      }

      executeLayoutCommand({
        label: 'Add portal column',
        apply: (current) => ({
          ...current,
          objects: current.objects.map((item) => {
            if (item.id !== singleSelectedPortal.id || item.type !== 'portal') {
              return item;
            }

            const nextColumns = [
              ...item.columns,
              {
                id: createObjectId(),
                fmFieldName: fieldName,
                label: toPortalColumnLabel(fieldName),
                width: 160
              }
            ];

            return {
              ...item,
              columns: nextColumns
            };
          })
        })
      });
    },
    [executeLayoutCommand, singleSelectedPortal]
  );

  const updatePortalColumn = React.useCallback(
    (
      columnId: string,
      updates: Partial<PortalLayoutObject['columns'][number]>,
      label = 'Update portal column'
    ): void => {
      if (!singleSelectedPortal) {
        return;
      }

      executeLayoutCommand({
        label,
        apply: (current) => ({
          ...current,
          objects: current.objects.map((item) => {
            if (item.id !== singleSelectedPortal.id || item.type !== 'portal') {
              return item;
            }

            return {
              ...item,
              columns: item.columns.map((column) =>
                column.id === columnId
                  ? {
                      ...column,
                      ...updates
                    }
                  : column
              )
            };
          })
        })
      });
    },
    [executeLayoutCommand, singleSelectedPortal]
  );

  const removePortalColumn = React.useCallback(
    (columnId: string): void => {
      if (!singleSelectedPortal) {
        return;
      }

      executeLayoutCommand({
        label: 'Remove portal column',
        apply: (current) => ({
          ...current,
          objects: current.objects.map((item) => {
            if (item.id !== singleSelectedPortal.id || item.type !== 'portal') {
              return item;
            }

            return {
              ...item,
              columns: item.columns.filter((column) => column.id !== columnId)
            };
          })
        })
      });
    },
    [executeLayoutCommand, singleSelectedPortal]
  );

  const movePortalColumn = React.useCallback(
    (columnId: string, direction: 'up' | 'down'): void => {
      if (!singleSelectedPortal) {
        return;
      }

      executeLayoutCommand({
        label: 'Reorder portal columns',
        apply: (current) => ({
          ...current,
          objects: current.objects.map((item) => {
            if (item.id !== singleSelectedPortal.id || item.type !== 'portal') {
              return item;
            }

            const index = item.columns.findIndex((column) => column.id === columnId);
            if (index < 0) {
              return item;
            }

            const targetIndex = direction === 'up' ? index - 1 : index + 1;
            if (targetIndex < 0 || targetIndex >= item.columns.length) {
              return item;
            }

            const nextColumns = [...item.columns];
            const temp = nextColumns[targetIndex];
            nextColumns[targetIndex] = nextColumns[index];
            nextColumns[index] = temp;

            return {
              ...item,
              columns: nextColumns
            };
          })
        })
      });
    },
    [executeLayoutCommand, singleSelectedPortal]
  );

  const reorderPortalColumn = React.useCallback(
    (sourceColumnId: string, targetColumnId: string): void => {
      if (!singleSelectedPortal || sourceColumnId === targetColumnId) {
        return;
      }

      executeLayoutCommand({
        label: 'Reorder portal columns',
        apply: (current) => ({
          ...current,
          objects: current.objects.map((item) => {
            if (item.id !== singleSelectedPortal.id || item.type !== 'portal') {
              return item;
            }

            const sourceIndex = item.columns.findIndex((column) => column.id === sourceColumnId);
            const targetIndex = item.columns.findIndex((column) => column.id === targetColumnId);
            if (sourceIndex < 0 || targetIndex < 0) {
              return item;
            }

            const nextColumns = [...item.columns];
            const [moved] = nextColumns.splice(sourceIndex, 1);
            if (!moved) {
              return item;
            }

            nextColumns.splice(targetIndex, 0, moved);

            return {
              ...item,
              columns: nextColumns
            };
          })
        })
      });
    },
    [executeLayoutCommand, singleSelectedPortal]
  );

  const handlePortalColumnDragStart = React.useCallback(
    (event: React.DragEvent<HTMLElement>, columnId: string): void => {
      event.dataTransfer.setData('application/x-fmweb-portal-column', columnId);
      event.dataTransfer.effectAllowed = 'move';
    },
    []
  );

  const handlePortalColumnDrop = React.useCallback(
    (event: React.DragEvent<HTMLElement>, targetColumnId?: string): void => {
      event.preventDefault();

      const sourceColumnId = event.dataTransfer.getData('application/x-fmweb-portal-column');
      if (sourceColumnId && targetColumnId) {
        reorderPortalColumn(sourceColumnId, targetColumnId);
        return;
      }

      const payloadRaw = event.dataTransfer.getData('application/x-fmweb-tool');
      if (!payloadRaw) {
        return;
      }

      const payload = parseToolPayload(payloadRaw);
      if (payload?.type !== 'field' || !payload.fieldName) {
        return;
      }

      addPortalColumn(payload.fieldName);
    },
    [addPortalColumn, reorderPortalColumn]
  );

  const alignSelection = React.useCallback(
    (mode: 'left' | 'center' | 'right' | 'top' | 'middle' | 'bottom'): void => {
      if (selectedIds.length < 2) {
        return;
      }

      executeLayoutCommand({
        label: `Align ${mode}`,
        apply: (current) => {
          const selected = current.objects.filter((item) => selectedIds.includes(item.id));
          if (selected.length < 2) {
            return current;
          }

          const left = Math.min(...selected.map((item) => item.x));
          const right = Math.max(...selected.map((item) => item.x + item.width));
          const top = Math.min(...selected.map((item) => item.y));
          const bottom = Math.max(...selected.map((item) => item.y + item.height));

          return {
            ...current,
            objects: current.objects.map((item) => {
              if (!selectedIds.includes(item.id)) {
                return item;
              }

              if (mode === 'left') {
                return { ...item, x: snapToGrid(left, current.canvas.gridSize) };
              }

              if (mode === 'center') {
                const center = left + (right - left) / 2 - item.width / 2;
                return { ...item, x: snapToGrid(center, current.canvas.gridSize) };
              }

              if (mode === 'right') {
                return { ...item, x: snapToGrid(right - item.width, current.canvas.gridSize) };
              }

              if (mode === 'top') {
                return { ...item, y: snapToGrid(top, current.canvas.gridSize) };
              }

              if (mode === 'middle') {
                const middle = top + (bottom - top) / 2 - item.height / 2;
                return { ...item, y: snapToGrid(middle, current.canvas.gridSize) };
              }

              return { ...item, y: snapToGrid(bottom - item.height, current.canvas.gridSize) };
            })
          };
        }
      });
    },
    [executeLayoutCommand, selectedIds]
  );

  const distributeSelection = React.useCallback(
    (axis: 'horizontal' | 'vertical'): void => {
      if (selectedIds.length < 3) {
        return;
      }

      executeLayoutCommand({
        label: `Distribute ${axis}`,
        apply: (current) => {
          const selected = current.objects
            .filter((item) => selectedIds.includes(item.id))
            .sort((left, right) =>
              axis === 'horizontal' ? left.x - right.x : left.y - right.y
            );

          if (selected.length < 3) {
            return current;
          }

          if (axis === 'horizontal') {
            const minLeft = selected[0].x;
            const maxRight = selected[selected.length - 1].x + selected[selected.length - 1].width;
            const totalWidth = selected.reduce((sum, item) => sum + item.width, 0);
            const gap = (maxRight - minLeft - totalWidth) / (selected.length - 1);

            let cursor = minLeft;
            const nextById = new Map<string, number>();
            for (const item of selected) {
              nextById.set(item.id, snapToGrid(cursor, current.canvas.gridSize));
              cursor += item.width + gap;
            }

            return {
              ...current,
              objects: current.objects.map((item) =>
                nextById.has(item.id)
                  ? {
                      ...item,
                      x: nextById.get(item.id) ?? item.x
                    }
                  : item
              )
            };
          }

          const minTop = selected[0].y;
          const maxBottom = selected[selected.length - 1].y + selected[selected.length - 1].height;
          const totalHeight = selected.reduce((sum, item) => sum + item.height, 0);
          const gap = (maxBottom - minTop - totalHeight) / (selected.length - 1);

          let cursor = minTop;
          const nextById = new Map<string, number>();
          for (const item of selected) {
            nextById.set(item.id, snapToGrid(cursor, current.canvas.gridSize));
            cursor += item.height + gap;
          }

          return {
            ...current,
            objects: current.objects.map((item) =>
              nextById.has(item.id)
                ? {
                    ...item,
                    y: nextById.get(item.id) ?? item.y
                  }
                : item
            )
          };
        }
      });
    },
    [executeLayoutCommand, selectedIds]
  );

  const changeZOrder = React.useCallback(
    (mode: 'front' | 'back' | 'forward' | 'backward'): void => {
      if (selectedIds.length === 0) {
        return;
      }

      executeLayoutCommand({
        label: `Z-order ${mode}`,
        apply: (current) => {
          const selected = new Set(selectedIds);
          const ordered = [...current.objects].sort((left, right) => left.zIndex - right.zIndex);

          if (mode === 'front') {
            const nextOrder = [...ordered.filter((item) => !selected.has(item.id)), ...ordered.filter((item) => selected.has(item.id))];
            return withNormalizedZIndex(current, nextOrder);
          }

          if (mode === 'back') {
            const nextOrder = [...ordered.filter((item) => selected.has(item.id)), ...ordered.filter((item) => !selected.has(item.id))];
            return withNormalizedZIndex(current, nextOrder);
          }

          if (mode === 'forward') {
            const nextOrder = [...ordered];
            for (let index = nextOrder.length - 2; index >= 0; index -= 1) {
              if (!selected.has(nextOrder[index].id)) {
                continue;
              }

              if (selected.has(nextOrder[index + 1].id)) {
                continue;
              }

              const temp = nextOrder[index + 1];
              nextOrder[index + 1] = nextOrder[index];
              nextOrder[index] = temp;
            }

            return withNormalizedZIndex(current, nextOrder);
          }

          const nextOrder = [...ordered];
          for (let index = 1; index < nextOrder.length; index += 1) {
            if (!selected.has(nextOrder[index].id)) {
              continue;
            }

            if (selected.has(nextOrder[index - 1].id)) {
              continue;
            }

            const temp = nextOrder[index - 1];
            nextOrder[index - 1] = nextOrder[index];
            nextOrder[index] = temp;
          }

          return withNormalizedZIndex(current, nextOrder);
        }
      });
    },
    [executeLayoutCommand, selectedIds]
  );

  const groupSelection = React.useCallback((): void => {
    if (selectedIds.length < 2) {
      return;
    }

    const groupId = createObjectId();
    setGroups((current) => ({
      ...current,
      [groupId]: selectedIds
    }));
    log(`Grouped ${selectedIds.length} objects.`);
  }, [log, selectedIds]);

  const ungroupSelection = React.useCallback((): void => {
    if (selectedIds.length === 0) {
      return;
    }

    setGroups((current) => {
      const next: Record<string, string[]> = {};
      for (const [groupId, members] of Object.entries(current)) {
        if (members.some((member) => selectedIds.includes(member))) {
          continue;
        }
        next[groupId] = members;
      }
      return next;
    });
    log('Ungrouped selection.');
  }, [log, selectedIds]);

  React.useEffect(() => {
    vscode.postMessage({ type: 'ready' });
  }, []);

  React.useEffect(() => {
    const handleMessage = (event: MessageEvent<IncomingMessage>): void => {
      if (event.origin !== window.location.origin) { return; }
      const message = event.data;
      if (!message || typeof message !== 'object') {
        return;
      }

      if (message.type === 'templateMetadata') {
        const source = message.payload;
        if (source) setTemplateLayouts((current) => [...current.filter((entry) => entry.layoutName !== source.layoutName), source]);
        return;
      }

      if (message.type === 'init') {
        const initialLayout = message.payload.layout;
        layoutRef.current = initialLayout;
        setLayout(initialLayout);
        setFields(message.payload.availableFields);
        setFieldMetadata(message.payload.availableFieldMetadata ?? message.payload.availableFields.map((name) => ({ name })));
        setIsNewLayout(message.payload.isNewLayout ?? false);
        setTemplateLayouts(message.payload.templateLayouts ?? []);
        setTemplateLayoutNames(message.payload.templateLayoutNames ?? message.payload.templateLayouts?.map((entry) => entry.layoutName) ?? []);
        setTemplateSource(message.payload.templateLayouts?.[0]?.layoutName ?? '');
        setScripts(message.payload.scripts);
        setProjectName(message.payload.projectName);
        setUndoStack([]);
        setRedoStack([]);
        setSelectedIds([]);
        setGroups({});
        setIsInitialized(true);
        log(`Loaded layout ${initialLayout.name}.`);
        return;
      }

      if (message.type === 'saveResult') {
        log(message.payload.message ?? (message.payload.ok ? 'Layout saved.' : 'Save failed.'));
        return;
      }

      if (message.type === 'behaviorResult') {
        const status = message.payload.ok ? 'OK' : 'ERROR';
        const stubText = message.payload.stub ? ' [stub]' : '';
        log(`${status}${stubText}: ${message.payload.message}`);
        return;
      }

      if (message.type === 'error') {
        log(message.payload.message);
      }
    };

    window.addEventListener('message', handleMessage as EventListener);
    return () => window.removeEventListener('message', handleMessage as EventListener);
  }, [log]);

  React.useEffect(() => {
    if (!isInitialized) {
      return;
    }

    const timeout = window.setTimeout(() => {
      vscode.postMessage({
        type: 'saveLayout',
        payload: {
          layout,
          autosave: true
        }
      });
    }, 850);

    return () => window.clearTimeout(timeout);
  }, [isInitialized, layout]);

  React.useEffect(() => {
    const handler = (event: KeyboardEvent): void => {
      const tagName = (event.target as HTMLElement | null)?.tagName;
      if (tagName === 'INPUT' || tagName === 'SELECT' || tagName === 'TEXTAREA') {
        return;
      }

      const cmdOrCtrl = event.metaKey || event.ctrlKey;

      if (cmdOrCtrl && event.key.toLowerCase() === 's') {
        event.preventDefault();
        vscode.postMessage({
          type: 'saveLayout',
          payload: {
            layout: layoutRef.current,
            autosave: false
          }
        });
        return;
      }

      if (cmdOrCtrl && !event.shiftKey && event.key.toLowerCase() === 'z') {
        event.preventDefault();
        undo();
        return;
      }

      if (cmdOrCtrl && event.shiftKey && event.key.toLowerCase() === 'z') {
        event.preventDefault();
        redo();
        return;
      }

      if (event.key === 'Delete' || event.key === 'Backspace') {
        event.preventDefault();
        removeSelected();
        return;
      }

      const nudgeAmount = event.shiftKey ? 10 : 1;

      if (event.key === 'ArrowUp') {
        event.preventDefault();
        nudgeSelection(0, -nudgeAmount);
        return;
      }

      if (event.key === 'ArrowDown') {
        event.preventDefault();
        nudgeSelection(0, nudgeAmount);
        return;
      }

      if (event.key === 'ArrowLeft') {
        event.preventDefault();
        nudgeSelection(-nudgeAmount, 0);
        return;
      }

      if (event.key === 'ArrowRight') {
        event.preventDefault();
        nudgeSelection(nudgeAmount, 0);
      }
    };

    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [nudgeSelection, redo, removeSelected, undo]);

  return (
    <div className="app-shell">
      <aside className="pane left-pane">
        <h2>Toolbox (Drag or Click)</h2>
        <div className="tool-grid">
          {TOOL_TYPES.map((type) => (
            <button
              key={type}
              type="button"
              draggable
              onClick={() => addToolObject({ type })}
              onDragStart={(event) => handleToolDragStart(event, { type })}
            >
              {type}
            </button>
          ))}
        </div>

        <h2>Field Picker</h2>
        <ul className="field-list">
          {fields.map((field) => (
            <li key={field}>
              <button
                type="button"
                className="field-chip"
                draggable
                onClick={() => addToolObject({ type: 'field', fieldName: field })}
                onDragStart={(event) => handleToolDragStart(event, { type: 'field', fieldName: field })}
              >
                {field}
              </button>
            </li>
          ))}
          {fields.length === 0 ? <li className="muted">Sync metadata to load fields.</li> : null}
        </ul>
      </aside>

      <main className="center-pane">
        <header className="canvas-header">
          <div>
            <h1>{projectName}</h1>
            <p>{layout.name}</p>
          </div>
          <div className="action-row">
            {isNewLayout && layout.objects.length === 0 ? <>
              <select aria-label="Starter template" value={template} onChange={(event) => setTemplate(event.target.value as StarterTemplate)}>
                <option value="blank">Blank</option><option value="form">Form</option>
                <option value="twoColumn">Two-column form</option><option value="formPortal">Form + first portal</option>
              </select>
              <select aria-label="Template FileMaker layout" value={templateSource} onChange={(event) => {
                const layoutName = event.target.value; setTemplateSource(layoutName);
                if (!templateLayouts.some((entry) => entry.layoutName === layoutName)) vscode.postMessage({ type: 'loadTemplateMetadata', payload: { layoutName } });
              }}>
                {templateLayoutNames.map((name) => <option key={name} value={name}>{name}</option>)}
              </select>
              <button type="button" disabled={template !== 'blank' && !templateLayouts.some((entry) => entry.layoutName === templateSource)} onClick={() => {
                const source = templateLayouts.find((entry) => entry.layoutName === templateSource);
                if (template === 'blank' || !source) return;
                const portal = source.portals[0];
                const ids = Array.from({ length: source.fields.length + 1 + (portal?.fields.length ?? 0) }, () => createObjectId());
                executeLayoutCommand({ label: 'Apply starter template', apply: (current) => createStarterTemplate(
                  { ...current, fmLayoutName: source.layoutName }, source.fields, template, ids, portal
                ) }, { fields: source.fields.map((field) => field.name), metadata: source.fields, source: source.layoutName });
              }}>Apply starter template</button>
            </> : null}
            <select aria-label="Form columns" value={formColumns} onChange={(event) => setFormColumns(Number(event.target.value) as 1 | 2)}>
              <option value={1}>One column</option><option value={2}>Two columns</option>
            </select>
            <button type="button" onClick={() => executeLayoutCommand({
              label: 'Arrange standard form', apply: (current) => arrangeStandardForm(current, fieldMetadata, formColumns, selectedIds.length ? selectedIds : undefined)
            })}>Arrange standard form</button>
            <button type="button" onClick={() => executeLayoutCommand({
              label: 'Standardize fields', apply: (current) => standardizeFields(current, fieldMetadata, selectedIds.length ? selectedIds : undefined)
            })}>{selectedIds.length ? 'Standardize selected' : 'Standardize all'}</button>
            <button type="button" onClick={undo} disabled={undoStack.length === 0}>
              Undo
            </button>
            <button type="button" onClick={redo} disabled={redoStack.length === 0}>
              Redo
            </button>
            <button type="button" onClick={groupSelection} disabled={selectedIds.length < 2}>
              Group
            </button>
            <button type="button" onClick={ungroupSelection} disabled={selectedIds.length === 0}>
              Ungroup
            </button>
            <button type="button" onClick={() => alignSelection('left')} disabled={selectedIds.length < 2}>
              Align Left
            </button>
            <button type="button" onClick={() => alignSelection('center')} disabled={selectedIds.length < 2}>
              Align Center
            </button>
            <button type="button" onClick={() => alignSelection('right')} disabled={selectedIds.length < 2}>
              Align Right
            </button>
            <button type="button" onClick={() => alignSelection('top')} disabled={selectedIds.length < 2}>
              Align Top
            </button>
            <button type="button" onClick={() => alignSelection('middle')} disabled={selectedIds.length < 2}>
              Align Middle
            </button>
            <button type="button" onClick={() => alignSelection('bottom')} disabled={selectedIds.length < 2}>
              Align Bottom
            </button>
            <button type="button" onClick={() => distributeSelection('horizontal')} disabled={selectedIds.length < 3}>
              Dist H
            </button>
            <button type="button" onClick={() => distributeSelection('vertical')} disabled={selectedIds.length < 3}>
              Dist V
            </button>
            <button type="button" onClick={() => changeZOrder('front')} disabled={selectedIds.length === 0}>
              Bring Front
            </button>
            <button type="button" onClick={() => changeZOrder('back')} disabled={selectedIds.length === 0}>
              Send Back
            </button>
            <button type="button" onClick={() => changeZOrder('forward')} disabled={selectedIds.length === 0}>
              Forward
            </button>
            <button type="button" onClick={() => changeZOrder('backward')} disabled={selectedIds.length === 0}>
              Backward
            </button>
          </div>
        </header>

        <div
          className="canvas-scroll"
          ref={viewportRef}
          onDragOver={(event) => event.preventDefault()}
          onDrop={handleCanvasDrop}
          onMouseDown={handleCanvasBackgroundMouseDown}
        >
          <div
            className="design-surface"
            ref={surfaceRef}
            style={{
              width: layout.canvas.width,
              height: layout.canvas.height,
              backgroundSize: `${layout.canvas.gridSize}px ${layout.canvas.gridSize}px`
            }}
          >
            <LayoutContainer
              layout={layout}
              mode="designer"
              onObjectAction={(object) => {
                setSelectedIds([object.id]);
                triggerBehaviorForObject(object.id);
              }}
            />

            <div className="interaction-layer">
              {sortedObjects.map((object) => {
                const selected = selectedIds.includes(object.id);
                const grouped = getGroupMembersForObject(object.id, groups).length > 0;
                return (
                  <div
                    key={object.id}
                    className={`object-hitbox ${selected ? 'selected' : ''} ${grouped ? 'grouped' : ''}`}
                    style={{
                      left: object.x,
                      top: object.y,
                      width: object.width,
                      height: object.height,
                      zIndex: object.zIndex + 1000
                    }}
                    onMouseDown={(event) => handleObjectMouseDown(event, object.id)}
                  >
                    <span className="object-name">{object.name}</span>
                    {selected && selectedIds.length === 1 ? (
                      <>
                        <button
                          type="button"
                          className="resize-handle handle-nw"
                          onMouseDown={(event) => handleResizeMouseDown(event, object.id, 'nw')}
                        />
                        <button
                          type="button"
                          className="resize-handle handle-ne"
                          onMouseDown={(event) => handleResizeMouseDown(event, object.id, 'ne')}
                        />
                        <button
                          type="button"
                          className="resize-handle handle-sw"
                          onMouseDown={(event) => handleResizeMouseDown(event, object.id, 'sw')}
                        />
                        <button
                          type="button"
                          className="resize-handle handle-se"
                          onMouseDown={(event) => handleResizeMouseDown(event, object.id, 'se')}
                        />
                      </>
                    ) : null}
                  </div>
                );
              })}

              {guides.map((guide, index) =>
                guide.orientation === 'vertical' ? (
                  <div key={`v-${guide.value}-${index}`} className="guide-line vertical" style={{ left: guide.value }} />
                ) : (
                  <div key={`h-${guide.value}-${index}`} className="guide-line horizontal" style={{ top: guide.value }} />
                )
              )}

              {marqueeRect ? (
                <div
                  className="marquee"
                  style={{
                    left: marqueeRect.x,
                    top: marqueeRect.y,
                    width: marqueeRect.width,
                    height: marqueeRect.height
                  }}
                />
              ) : null}
            </div>
          </div>
        </div>

        <div className="object-list">
          {sortedObjects.map((object) => (
            <button
              key={object.id}
              type="button"
              className={selectedIds.includes(object.id) ? 'selected' : ''}
              onClick={() => setSelectedIds([object.id])}
            >
              {object.name}
            </button>
          ))}
        </div>
      </main>

      <aside className="pane right-pane">
        <h2>Inspector</h2>
        {singleSelectedObject ? (
          <div className="inspector-field">
            <label>Name</label>
            <input
              type="text"
              aria-label="Object Name"
              value={singleSelectedObject.name}
              onChange={(event) => updateSingleSelectedName(event.target.value)}
            />
            <div className="inspector-grid">
              <span>X: {singleSelectedObject.x}</span>
              <span>Y: {singleSelectedObject.y}</span>
              <span>W: {singleSelectedObject.width}</span>
              <span>H: {singleSelectedObject.height}</span>
              <span>Z: {singleSelectedObject.zIndex}</span>
            </div>
            {singleSelectedField ? (
              <>
                <label>FM Field</label>
                <select
                  aria-label="FM Field Name"
                  value={singleSelectedField.fmFieldName}
                  onChange={(event) => updateSingleSelectedField({ fmFieldName: event.target.value })}
                >
                  {fieldChoices.map((field) => (
                    <option key={field} value={field}>
                      {field}
                    </option>
                  ))}
                </select>

                <label>Display Type</label>
                <select
                  aria-label="Display Type"
                  value={singleSelectedField.displayType}
                  onChange={(event) =>
                    updateSingleSelectedField({
                      displayType: event.target.value as FieldLayoutObject['displayType']
                    })
                  }
                >
                  <option value="editBox">edit box</option>
                  <option value="dropdown">dropdown</option>
                  <option value="checkbox">checkbox</option>
                  <option value="radio">radio</option>
                </select>

                <label>Format</label>
                <select
                  aria-label="Field Format"
                  value={singleSelectedField.format}
                  onChange={(event) =>
                    updateSingleSelectedField({
                      format: event.target.value as FieldLayoutObject['format']
                    })
                  }
                >
                  <option value="text">text</option>
                  <option value="number">number</option>
                  <option value="date">date</option>
                </select>

                <label>Label Position</label>
                <select
                  aria-label="Label Position"
                  value={singleSelectedField.labelPosition}
                  onChange={(event) =>
                    updateSingleSelectedField({
                      labelPosition: event.target.value as FieldLayoutObject['labelPosition']
                    })
                  }
                >
                  <option value="top">top</option>
                  <option value="left">left</option>
                  <option value="right">right</option>
                  <option value="none">none</option>
                </select>

                <label>Label</label>
                <input
                  type="text"
                  aria-label="Field Label"
                  value={singleSelectedField.label ?? ''}
                  onChange={(event) =>
                    updateSingleSelectedField({
                      label: event.target.value.trim().length > 0 ? event.target.value : undefined
                    })
                  }
                />

                <label className="inspector-check">
                  <input
                    type="checkbox"
                    aria-label="Required Indicator"
                    checked={singleSelectedField.required}
                    onChange={(event) => updateSingleSelectedField({ required: event.target.checked })}
                  />
                  Required indicator
                </label>
              </>
            ) : null}
            {singleSelectedPortal ? (
              <>
                <label>Related Context</label>
                <input
                  type="text"
                  aria-label="Portal Related Context"
                  value={singleSelectedPortal.relatedContext}
                  onChange={(event) => updateSingleSelectedPortal({ relatedContext: event.target.value })}
                />

                <label>Design Row Count</label>
                <input
                  type="number"
                  min={1}
                  max={500}
                  aria-label="Portal Row Count"
                  value={singleSelectedPortal.rowCount}
                  onChange={(event) =>
                    updateSingleSelectedPortal({
                      rowCount: clampInt(Number.parseInt(event.target.value, 10), 1, 500, singleSelectedPortal.rowCount)
                    })
                  }
                />

                <label className="inspector-check">
                  <input
                    type="checkbox"
                    aria-label="Portal Scroll"
                    checked={singleSelectedPortal.scroll}
                    onChange={(event) => updateSingleSelectedPortal({ scroll: event.target.checked })}
                  />
                  Scroll enabled
                </label>

                <label className="inspector-check">
                  <input
                    type="checkbox"
                    aria-label="Portal Selectable Rows"
                    checked={singleSelectedPortal.selectableRows}
                    onChange={(event) => updateSingleSelectedPortal({ selectableRows: event.target.checked })}
                  />
                  Selectable rows
                </label>

                <label>Portal Column Editor</label>
                <div className="portal-column-editor">
                  <div
                    className="portal-column-dropzone"
                    data-portal-dropzone="true"
                    onDragOver={(event) => event.preventDefault()}
                    onDrop={(event) => handlePortalColumnDrop(event)}
                  >
                    Drag field chips here to add columns
                  </div>

                  <div className="portal-field-bank">
                    {portalFieldChoices.map((field) => (
                      <button
                        key={field}
                        type="button"
                        className="portal-field-chip"
                        draggable
                        onClick={() => addPortalColumn(field)}
                        onDragStart={(event) => handleToolDragStart(event, { type: 'field', fieldName: field })}
                      >
                        {field}
                      </button>
                    ))}
                    {portalFieldChoices.length === 0 ? (
                      <p className="muted">Sync metadata to add portal columns from fields.</p>
                    ) : null}
                  </div>

                  <ul className="portal-column-list">
                    {singleSelectedPortal.columns.map((column, index) => (
                      <li
                        key={column.id}
                        className="portal-column-row"
                        draggable
                        onDragStart={(event) => handlePortalColumnDragStart(event, column.id)}
                        onDragOver={(event) => event.preventDefault()}
                        onDrop={(event) => handlePortalColumnDrop(event, column.id)}
                      >
                        <div className="portal-column-main">
                          <strong>{column.label}</strong>
                          <span>{column.fmFieldName}</span>
                        </div>
                        <input
                          type="number"
                          aria-label={`Portal Column Width ${column.fmFieldName}`}
                          min={60}
                          max={600}
                          value={column.width}
                          onChange={(event) =>
                            updatePortalColumn(column.id, {
                              width: clampInt(Number.parseInt(event.target.value, 10), 60, 600, column.width)
                            })
                          }
                        />
                        <div className="portal-column-actions">
                          <button
                            type="button"
                            aria-label={`Move ${column.fmFieldName} up`}
                            disabled={index === 0}
                            onClick={() => movePortalColumn(column.id, 'up')}
                          >
                            Up
                          </button>
                          <button
                            type="button"
                            aria-label={`Move ${column.fmFieldName} down`}
                            disabled={index === singleSelectedPortal.columns.length - 1}
                            onClick={() => movePortalColumn(column.id, 'down')}
                          >
                            Down
                          </button>
                          <button
                            type="button"
                            aria-label={`Remove ${column.fmFieldName}`}
                            onClick={() => removePortalColumn(column.id)}
                          >
                            Remove
                          </button>
                        </div>
                      </li>
                    ))}
                  </ul>
                </div>
              </>
            ) : null}

            <label>Behavior Action</label>
            <select
              aria-label="Behavior Type"
              value={singleSelectedBehavior?.type ?? ''}
              onChange={(event) => setSingleSelectedBehaviorType(event.target.value)}
            >
              <option value="">none</option>
              <option value="runScript">Run FileMaker Script</option>
              <option value="goToWebLayout">Go to Layout (web)</option>
              <option value="goToFmLayout">Go to FM Layout</option>
              <option value="openUrl">Open URL</option>
              <option value="showDialog">Show Dialog</option>
            </select>

            {singleSelectedBehavior?.type === 'runScript' ? (
              <>
                <label>Script Name</label>
                {scriptChoices.length > 0 ? (
                  <select
                    aria-label="Behavior Script Name"
                    value={singleSelectedBehavior.scriptName ?? scriptChoices[0]}
                    onChange={(event) =>
                      updateSingleSelectedBehavior({
                        scriptName: event.target.value
                      })
                    }
                  >
                    {scriptChoices.map((script) => (
                      <option key={script} value={script}>
                        {script}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input
                    type="text"
                    aria-label="Behavior Script Name"
                    value={singleSelectedBehavior.scriptName ?? ''}
                    onChange={(event) =>
                      updateSingleSelectedBehavior({
                        scriptName: event.target.value.trim().length > 0 ? event.target.value : undefined
                      })
                    }
                  />
                )}
                <label>Script Parameter</label>
                <input
                  type="text"
                  aria-label="Behavior Script Parameter"
                  value={singleSelectedBehavior.parameter ?? ''}
                  onChange={(event) =>
                    updateSingleSelectedBehavior({
                      parameter: event.target.value.length > 0 ? event.target.value : undefined
                    })
                  }
                />
              </>
            ) : null}

            {singleSelectedBehavior?.type === 'goToWebLayout' ? (
              <>
                <label>Target Web Layout ID</label>
                <input
                  type="text"
                  aria-label="Behavior Target Web Layout ID"
                  value={singleSelectedBehavior.targetLayoutId ?? ''}
                  onChange={(event) =>
                    updateSingleSelectedBehavior({
                      targetLayoutId: event.target.value.trim().length > 0 ? event.target.value : undefined
                    })
                  }
                />
                <label>Navigation Parameter</label>
                <input
                  type="text"
                  aria-label="Behavior Navigation Parameter"
                  value={singleSelectedBehavior.parameter ?? ''}
                  onChange={(event) =>
                    updateSingleSelectedBehavior({
                      parameter: event.target.value.length > 0 ? event.target.value : undefined
                    })
                  }
                />
              </>
            ) : null}

            {singleSelectedBehavior?.type === 'goToFmLayout' ? (
              <>
                <label>Target FM Layout Name</label>
                <input
                  type="text"
                  aria-label="Behavior Target FM Layout Name"
                  value={singleSelectedBehavior.targetFmLayoutName ?? ''}
                  onChange={(event) =>
                    updateSingleSelectedBehavior({
                      targetFmLayoutName:
                        event.target.value.trim().length > 0 ? event.target.value : undefined
                    })
                  }
                />
                <label>Navigation Parameter</label>
                <input
                  type="text"
                  aria-label="Behavior Navigation Parameter"
                  value={singleSelectedBehavior.parameter ?? ''}
                  onChange={(event) =>
                    updateSingleSelectedBehavior({
                      parameter: event.target.value.length > 0 ? event.target.value : undefined
                    })
                  }
                />
              </>
            ) : null}

            {singleSelectedBehavior?.type === 'openUrl' ? (
              <>
                <label>URL</label>
                <input
                  type="text"
                  aria-label="Behavior URL"
                  value={singleSelectedBehavior.url ?? ''}
                  onChange={(event) =>
                    updateSingleSelectedBehavior({
                      url: event.target.value.trim().length > 0 ? event.target.value : undefined
                    })
                  }
                />
              </>
            ) : null}

            {singleSelectedBehavior?.type === 'showDialog' ? (
              <>
                <label>Dialog ID</label>
                <input
                  type="text"
                  aria-label="Behavior Dialog ID"
                  value={singleSelectedBehavior.dialogId ?? ''}
                  onChange={(event) =>
                    updateSingleSelectedBehavior({
                      dialogId: event.target.value.trim().length > 0 ? event.target.value : undefined
                    })
                  }
                />
                <label>Dialog Parameter</label>
                <input
                  type="text"
                  aria-label="Behavior Dialog Parameter"
                  value={singleSelectedBehavior.parameter ?? ''}
                  onChange={(event) =>
                    updateSingleSelectedBehavior({
                      parameter: event.target.value.length > 0 ? event.target.value : undefined
                    })
                  }
                />
              </>
            ) : null}

            <button
              type="button"
              onClick={triggerBehaviorPreview}
              disabled={!singleSelectedBehavior?.type}
            >
              Preview Behavior
            </button>
          </div>
        ) : selectedIds.length > 1 ? (
          <p className="muted">{selectedIds.length} objects selected.</p>
        ) : (
          <p className="muted">Select an object to inspect.</p>
        )}

        <h2>Scripts</h2>
        <ul className="field-list">
          {scripts.map((script) => (
            <li key={script}>{script}</li>
          ))}
          {scripts.length === 0 ? <li className="muted">No script metadata.</li> : null}
        </ul>
      </aside>

      <footer className="console-pane">
        <strong>Console</strong>
        <div className="console-log fm-code">
          {consoleLines.map((line, index) => (
            <div key={`${line}-${index}`}>{line}</div>
          ))}
        </div>
      </footer>
    </div>
  );
}

const rootElement = document.getElementById('root');
if (rootElement) {
  createRoot(rootElement).render(<App />);
}

function createObjectFromTool(
  payload: ToolDragPayload,
  point: Point,
  layout: LayoutDefinition,
  fields: string[],
  metadata: StandardFieldMetadata[]
): LayoutObject {
  const zIndex = layout.objects.length === 0 ? 0 : Math.max(...layout.objects.map((item) => item.zIndex)) + 1;
  const base = {
    id: createObjectId(),
    name: `${payload.type}-${layout.objects.length + 1}`,
    x: point.x,
    y: point.y,
    width: 180,
    height: 34,
    zIndex,
    anchors: { top: true, right: false, bottom: false, left: true }
  };

  if (payload.type === 'field') {
    const name = payload.fieldName ?? fields[0] ?? 'Field';
    return createStandardField(metadata.find((field) => field.name === name) ?? { name }, base.id, point, zIndex);
  }

  if (payload.type === 'text') {
    return {
      ...base,
      type: 'text',
      text: 'Text'
    };
  }

  if (payload.type === 'button') {
    return {
      ...base,
      type: 'button',
      label: 'Button'
    };
  }

  if (payload.type === 'portal') {
    return {
      ...base,
      type: 'portal',
      width: 420,
      height: 220,
      relatedContext: '',
      rowCount: 5,
      columns: [],
      scroll: true,
      selectableRows: false
    };
  }

  if (payload.type === 'image') {
    return {
      ...base,
      type: 'image'
    };
  }

  if (payload.type === 'tabPanel') {
    return {
      ...base,
      type: 'tabPanel',
      tabs: []
    };
  }

  return {
    ...base,
    type: 'rectangle',
    width: 220,
    height: 120,
    cornerRadius: 0
  };
}

function parseToolPayload(raw: string): ToolDragPayload | undefined {
  try {
    const value = JSON.parse(raw) as Partial<ToolDragPayload>;
    if (!value || typeof value !== 'object') {
      return undefined;
    }

    if (!value.type || !TOOL_TYPES.includes(value.type)) {
      return undefined;
    }

    return {
      type: value.type,
      fieldName: typeof value.fieldName === 'string' ? value.fieldName : undefined
    };
  } catch {
    return undefined;
  }
}

function toPortalColumnLabel(fieldName: string): string {
  const simple = fieldName.split('::').pop() ?? fieldName;
  const normalized = simple.replace(/[_-]+/g, ' ').trim();
  return normalized.length > 0 ? normalized : fieldName;
}

function createBehaviorDefaults(
  type: Exclude<BehaviorBinding['type'], undefined>,
  current: BehaviorBinding | undefined,
  scripts: string[]
): BehaviorBinding {
  if (type === 'runScript') {
    return {
      type,
      scriptName: current?.scriptName?.trim() || scripts[0],
      parameter: current?.parameter
    };
  }

  if (type === 'goToWebLayout') {
    return {
      type,
      targetLayoutId: current?.targetLayoutId,
      parameter: current?.parameter
    };
  }

  if (type === 'goToFmLayout') {
    return {
      type,
      targetFmLayoutName: current?.targetFmLayoutName,
      parameter: current?.parameter
    };
  }

  if (type === 'openUrl') {
    return {
      type,
      url: current?.url
    };
  }

  return {
    type,
    dialogId: current?.dialogId,
    parameter: current?.parameter
  };
}

function clampInt(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) {
    return fallback;
  }

  const rounded = Math.round(value);
  return Math.max(min, Math.min(max, rounded));
}

function createObjectId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }

  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (token) => {
    const random = Math.floor(Math.random() * 16);
    const value = token === 'x' ? random : (random & 0x3) | 0x8;
    return value.toString(16);
  });
}

function getGroupMembersForObject(objectId: string, groups: Record<string, string[]>): string[] {
  for (const members of Object.values(groups)) {
    if (members.includes(objectId)) {
      return members;
    }
  }

  return [];
}
