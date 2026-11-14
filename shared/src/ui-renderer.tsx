import * as React from 'react';
import { fieldKindNote, recordFieldKey, runtimeFieldKind } from './record-edit';
import { checkboxValue, choiceDisplayType, FIELD_LAYOUT, preserveTextLineEndings, serverOrigin, standardControlFor } from './field-standards';
import { baseFieldName, orderFields } from './field-order';

import type { FieldLayoutObject, LayoutDefinition, LayoutObject, PortalLayoutObject } from './layout-schema';

export interface RuntimeLayoutData {
  /** The profile server origin only; never credentials or a session token. */
  serverOrigin?: string;
  fieldValues?: Record<string, unknown>;
  editing?: boolean;
  /** A new record has no values yet, so every field of the layout stays on the form. */
  creating?: boolean;
  onFieldChange?: (name: string, value: unknown) => void;
  portalRowsByObjectId?: Record<string, Array<Record<string, unknown>>>;
  viewport?: {
    width: number;
    height: number;
  };
}

export interface LayoutRendererProps {
  layout: LayoutDefinition;
  mode: 'designer' | 'runtime';
  onObjectAction?: (object: LayoutObject) => void;
  runtimeData?: RuntimeLayoutData;
}

export function LayoutContainer({
  layout,
  mode,
  onObjectAction,
  runtimeData
}: LayoutRendererProps): React.JSX.Element {
  layout = React.useMemo(() => mode === 'runtime' ? runtimeControlLayout(layout, runtimeData?.fieldValues, runtimeData?.creating) : layout,
    [layout, mode, runtimeData?.fieldValues, runtimeData?.creating]);
  const viewport = mode === 'runtime' ? runtimeData?.viewport : undefined;
  const containerWidth = viewport ? Math.max(1, Math.round(viewport.width)) : layout.canvas.width;
  const narrow = viewport !== undefined && viewport.width <= 640;
  const containerHeight = viewport ? Math.max(1, Math.round(viewport.height)) : layout.canvas.height;

  const renderedObjects = React.useMemo(
    () => {
      const objects = layout.objects
        .slice()
        .sort((a, b) => a.zIndex - b.zIndex)
        .map((object) => applyAnchoredRuntimeRect(object, layout, viewport));
      if (mode !== 'runtime') return objects;
      // The web layout shows the returned fields in the order of the FileMaker layout.
      const fields = objects.filter((object): object is FieldLayoutObject => object.type === 'field');
      const placed = new Set(fields.map((field) => field.fmFieldName));
      const returned = Object.keys(runtimeData?.fieldValues ?? {}).filter((name) => placed.has(name));
      const names = orderFields({ fields: layout.fieldOrder?.map((name) => ({ name })) },
        Object.fromEntries([...returned, ...placed].map((name) => [name, true])));
      const rank = new Map(names.map((name, index) => [name, index]));
      fields.sort((a, b) => rank.get(a.fmFieldName)! - rank.get(b.fmFieldName)!);
      let index = 0;
      return objects.map((object) => object.type === 'field' ? fields[index++] : object);
    },
    [layout, mode, viewport, runtimeData?.fieldValues]
  );

  // Stack controls in the designer's visual order, while retaining paint order and decorative geometry.
  let flowY = FIELD_LAYOUT.pageMargin;
  const positions = new Map<string, LayoutObject>();
  if (narrow) {
    layout.objects.filter((object) => ['field', 'portal', 'button'].includes(object.type))
      .sort((a, b) => a.y - b.y || a.x - b.x)
      .forEach((object) => {
        positions.set(object.id, { ...object, x: FIELD_LAYOUT.pageMargin, y: flowY,
          width: Math.min(object.width, Math.max(1, containerWidth - FIELD_LAYOUT.pageMargin * 2)) });
        flowY += object.height + (object.type === 'field' && object.labelPosition === 'top' ? FIELD_LAYOUT.labelSpace : 0) + runtimeFieldNoteSpace(positions.get(object.id) ?? object, runtimeData?.editing) + FIELD_LAYOUT.rowGap;
      });
  }
  const noteRows = mode === 'runtime' && !narrow ? layout.objects.reduce((rows, object) => {
    rows.set(object.y, Math.max(rows.get(object.y) ?? 0, runtimeFieldNoteSpace(object, runtimeData?.editing)));
    return rows;
  }, new Map<number, number>()) : new Map<number, number>();
  const visibleObjects = renderedObjects.map((object) => positions.get(object.id) ?? (noteRows.size
    ? { ...object, y: object.y + [...noteRows].reduce((shift, [row, space]) => shift + (row < object.y ? space : 0), 0) }
    : object));
  const contentHeight = Math.max(containerHeight, ...visibleObjects.map((object) => object.y + object.height +
    (object.type === 'field' && object.labelPosition === 'top' ? FIELD_LAYOUT.labelSpace : 0) + runtimeFieldNoteSpace(object, runtimeData?.editing) + FIELD_LAYOUT.pageMargin));

  return (
    <div
      data-mode={mode}
      style={{
        position: 'relative',
        width: containerWidth,
        height: mode === 'runtime' ? Math.max(contentHeight, narrow ? flowY + FIELD_LAYOUT.pageMargin : 0) : containerHeight,
        backgroundColor: layout.styles.colors.surface,
        color: layout.styles.colors.text,
        fontFamily: layout.styles.typography.fontFamily,
        fontSize: layout.styles.typography.fontSize,
        overflow: 'hidden',
        borderRadius: 10,
        boxShadow: '0 10px 25px rgba(18, 35, 56, 0.12)'
      }}
    >
      {visibleObjects.map((object) => (
        <LayoutObjectRenderer
          key={object.id}
          object={object}
          mode={mode}
          onObjectAction={onObjectAction}
          runtimeData={runtimeData}
        />
      ))}
    </div>
  );
}

function runtimeFieldNote(object: LayoutObject, editing = false): string | undefined {
  if (object.type !== 'field') return undefined;
  return [fieldKindNote(runtimeFieldKind(object)), editing && object.format === 'date' ? "Use the server's date format, keeping the same order and separators." : undefined].filter(Boolean).join(' ') || undefined;
}

function runtimeFieldNoteSpace(object: LayoutObject, editing = false): number {
  const note = runtimeFieldNote(object, editing);
  return note ? Math.ceil(note.length / Math.max(1, Math.floor(object.width / 7))) * 16 + 4 : 0;
}

interface LayoutObjectRendererProps {
  object: LayoutObject;
  mode: 'designer' | 'runtime';
  onObjectAction?: (object: LayoutObject) => void;
  runtimeData?: RuntimeLayoutData;
}

function LayoutObjectRenderer({
  object,
  mode,
  onObjectAction,
  runtimeData
}: LayoutObjectRendererProps): React.JSX.Element {
  const sharedStyle: React.CSSProperties = {
    position: 'absolute',
    left: object.x,
    top: object.y,
    width: object.width,
    height: object.height,
    boxSizing: 'border-box'
  };

  switch (object.type) {
    case 'field':
      return <FieldControl style={sharedStyle} object={object} mode={mode} runtimeData={runtimeData} />;
    case 'portal':
      return <PortalControl style={sharedStyle} object={object} mode={mode} runtimeData={runtimeData} />;
    case 'button':
      return <ButtonControl style={sharedStyle} object={object} onObjectAction={onObjectAction} />;
    case 'text':
      return <div style={sharedStyle}>{object.text}</div>;
    case 'image':
      return <div style={{ ...sharedStyle, border: '1px dashed #96a5b5', background: '#f2f6fa' }}>Image</div>;
    case 'tabPanel':
      return <div style={{ ...sharedStyle, border: '1px solid #ced8e3', background: '#fbfcfd' }}>Tab Panel</div>;
    case 'rectangle':
      return (
        <div
          style={{
            ...sharedStyle,
            border: '1px solid #b8c6d8',
            borderRadius: object.cornerRadius,
            background: '#f6f9fc'
          }}
        />
      );
    default:
      return <div style={sharedStyle} />;
  }
}

type ButtonLayoutObject = Extract<LayoutObject, { type: 'button' }>;

function ButtonControl(props: {
  style: React.CSSProperties;
  object: ButtonLayoutObject;
  onObjectAction?: (object: LayoutObject) => void;
}): React.JSX.Element {
  return (
    <button
      type="button"
      data-fm-button-id={props.object.id}
      data-fm-behavior-type={props.object.behavior?.type ?? ''}
      style={{
        ...props.style,
        border: '1px solid #2c6f98',
        borderRadius: 6,
        background: '#2274a5',
        color: '#ffffff',
        cursor: 'pointer'
      }}
      onClick={() => props.onObjectAction?.(props.object)}
    >
      {props.object.label}
    </button>
  );
}

/** Taller data needs room below its saved row; never alter the saved layout. */
function runtimeControlLayout(layout: LayoutDefinition, values?: Record<string, unknown>, creating = false): LayoutDefinition {
  const extraRows = new Map<number, number>();
  // A field that is not on the record stays hidden; a new record shows every field of the layout.
  const objects = layout.objects.filter((object) => object.type !== 'field' || values === undefined || creating
    || hasFieldValue(values, object.fmFieldName)).map((object) => {
    if (object.type !== 'field') return object;
    const height = Math.max(object.height, standardControlFor(controlMetadata(object, fieldValueOf(values, object.fmFieldName).value)).height);
    extraRows.set(object.y, Math.max(extraRows.get(object.y) ?? 0, height - object.height));
    return { ...object, height };
  });
  return { ...layout, objects: objects.map((object) => ({ ...object,
    y: object.y + [...extraRows].reduce((shift, [row, extra]) => shift + (row < object.y ? extra : 0), 0)
  })) };
}

/**
 * A field is on the record when the record holds a value for it. A repeated field stores its
 * value under `Name(1)`, so that value counts for the field `Name`.
 */
function hasFieldValue(values: Record<string, unknown>, name: string): boolean {
  if (Object.prototype.hasOwnProperty.call(values, name)) return true;
  if (baseFieldName(name) !== name) return false;
  return Object.keys(values).some((key) => baseFieldName(key) === name);
}

/**
 * The key a record holds the value of the layout field `name` under, and that value. A repeated
 * field keeps its value under `Name(1)`, so the layout name `Name` finds its value there, and an
 * edit is written back under the same key, which leaves the other repetitions alone.
 */
function fieldValueOf(values: Record<string, unknown> | undefined, name: string): { key: string; value: unknown } {
  if (!values) return { key: name, value: undefined };
  const key = recordFieldKey(values, name);
  return { key, value: values[key] };
}

function controlMetadata(object: FieldLayoutObject, value?: unknown) {
  return { name: object.fmFieldName, type: object.metadata?.result || object.result || object.metadata?.type || object.format,
    kind: runtimeFieldKind(object), displayType: object.displayType, multiline: object.multiline,
    options: object.options, value };
}

function FieldControl(props: {
  style: React.CSSProperties;
  object: FieldLayoutObject;
  mode: 'designer' | 'runtime';
  runtimeData?: RuntimeLayoutData;
}): React.JSX.Element {
  const { object, style } = props;
  const labelText = object.label?.length ? object.label : object.fmFieldName;
  // The value of a repeated field lives under `Name(1)`; the edit goes back under that same key.
  const { key: valueKey, value: runtimeValue } = fieldValueOf(props.runtimeData?.fieldValues, object.fmFieldName);
  const previewOptions = getPreviewOptions(object, runtimeValue, props.mode);
  const value = runtimeValue === undefined || runtimeValue === null ? '' : String(runtimeValue);
  const note = props.mode === 'runtime' ? runtimeFieldNote(object, props.runtimeData?.editing) : undefined;
  const readOnly = props.mode !== 'runtime' || !props.runtimeData?.editing || ['calculation', 'summary', 'container'].includes(runtimeFieldKind(object));
  // A container image that cannot be shown leaves its address behind.
  const [failedImage, setFailedImage] = React.useState<string | undefined>(undefined);
  // The value a choice group started with, so a selection that returns to it keeps the stored text.
  const choiceSession = React.useRef({ original: value, current: value, readOnly });
  if (choiceSession.current.current !== value || choiceSession.current.readOnly !== readOnly) {
    choiceSession.current = { original: value, current: value, readOnly };
  }
  const showLabel = object.labelPosition !== 'none';
  const horizontalLabel = object.labelPosition === 'left' || object.labelPosition === 'right';
  const inputId = `field-input-${object.id}`;
  const inlineControlStyle: React.CSSProperties = {
    flex: horizontalLabel ? 1 : '0 0 auto',
    minWidth: 0,
    minHeight: object.height,
    height: object.height,
    flexShrink: horizontalLabel ? 1 : 0,
    display: 'flex',
    alignItems: 'center'
  };

  const labelNode = showLabel ? (
    <label
      htmlFor={object.displayType === 'radio' ? undefined : inputId}
      style={{
        height: horizontalLabel ? undefined : FIELD_LAYOUT.labelSpace,
        flexShrink: 0,
        overflowWrap: 'anywhere',
        fontSize: 12,
        color: '#526980',
        fontWeight: 600,
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        minWidth: horizontalLabel ? 74 : undefined,
        maxWidth: horizontalLabel ? '45%' : undefined
      }}
    >
      <span>{labelText}</span>
      {object.required ? (
        <span data-required-indicator="true" style={{ color: '#b21e3b' }}>
          *
        </span>
      ) : null}
    </label>
  ) : null;

  const fieldControl = renderFieldDisplayControl({
    object,
    mode: props.mode,
    inputId,
    serverOrigin: props.runtimeData?.serverOrigin,
    options: previewOptions,
    value: props.mode === 'designer' ? previewOptions[0] : value,
    originalValue: choiceSession.current.original,
    readOnly,
    imageFailed: failedImage !== undefined && failedImage === value,
    onImageError: () => setFailedImage(value),
    onChange: (next) => {
      choiceSession.current.current = String(next);
      props.runtimeData?.onFieldChange?.(valueKey, next);
    }
  });

  return (
    <div
      style={{
        ...style,
        height: object.height + (object.labelPosition === 'top' ? FIELD_LAYOUT.labelSpace : 0),
        display: 'flex',
        flexDirection: horizontalLabel ? 'row' : 'column',
        justifyContent: horizontalLabel ? 'space-between' : undefined,
        alignItems: horizontalLabel ? 'center' : undefined,
        gap: horizontalLabel ? 6 : 0
      }}
      data-fm-width={object.width}
      data-fm-height={object.height}
      data-fm-field-id={object.id}
      data-fm-field-control={object.displayType}
      data-fm-field-format={object.format}
      data-fm-field-kind={runtimeFieldKind(object)}
      data-fm-label-position={object.labelPosition}
    >
      {note ? <span id={`${inputId}-note`} role="note">{note}</span> : null}
      {object.labelPosition === 'right' ? (
        <>
          <div style={inlineControlStyle}>{fieldControl}</div>
          {labelNode}
        </>
      ) : (
        <>
          {labelNode}
          <div style={inlineControlStyle}>{fieldControl}</div>
        </>
      )}
    </div>
  );
}

function renderFieldDisplayControl(props: {
  object: FieldLayoutObject;
  mode: 'designer' | 'runtime';
  inputId: string;
  serverOrigin?: string;
  options: string[];
  value: string;
  originalValue: string;
  readOnly: boolean;
  /** The container image could not be shown, so its address is shown instead. */
  imageFailed?: boolean;
  onImageError?: () => void;
  onChange: (value: unknown) => void;
}): React.JSX.Element {
  const metadata = controlMetadata(props.object, props.value);
  const standard = standardControlFor({ ...metadata, displayType: choiceDisplayType(metadata.displayType, props.options) });
  const disabled = props.readOnly || standard.readOnly;
  const baseControlStyle: React.CSSProperties = {
    border: '1px solid #90a3b8',
    borderRadius: 5,
    borderStyle: disabled ? 'dashed' : 'solid',
    resize: disabled ? 'none' : undefined,
    width: '100%',
    height: Math.max(props.object.height, standard.height),
    minHeight: standard.height,
    padding: '4px 8px',
    boxSizing: 'border-box',
    background: disabled ? '#f6fafc' : '#ffffff',
    color: '#20364f'
  };

  const description = props.mode === 'runtime' && runtimeFieldNote(props.object, !props.readOnly) ? `${props.inputId}-note` : undefined;
  const common = { id: props.inputId, 'aria-label': props.object.fmFieldName,
    'aria-describedby': description, className: disabled ? 'fm-field-control fm-readonly' : 'fm-field-control', style: baseControlStyle };

  if (standard.kind === 'container') {
    if (!props.value) return <div {...common} className="fm-field-control fm-container fm-readonly" />;
    // A record may only link to the profile server, never an arbitrary host.
    const origin = serverOrigin(props.serverOrigin);
    if (!origin || serverOrigin(props.value) !== origin) return <div {...common} className="fm-field-control fm-container fm-readonly">{props.value}</div>;
    const image = /\.(?:avif|bmp|gif|jpe?g|png|svg|webp)(?:[?#]|$)/i.test(props.value);
    // A container image that cannot be shown leaves its address behind, as a link.
    if (image && props.imageFailed) return <div {...common} className="fm-field-control fm-container fm-readonly">
      <a href={props.value} target="_blank" rel="noopener noreferrer">{props.value}</a></div>;
    return <div {...common} className="fm-field-control fm-container fm-readonly">{image
      ? <img src={props.value} alt={props.object.fmFieldName} style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }}
        onError={props.onImageError} />
      : <a href={props.value} target="_blank" rel="noopener noreferrer">Open container</a>}</div>;
  }

  if (standard.kind === 'select') {
    const options = Array.from(new Set(['', props.value, ...props.options]));
    return <select {...common} disabled={disabled} value={props.value} onChange={(event) => props.onChange(event.currentTarget.value)}>
      {options.map((option) => <option key={option} value={option}>{option === props.value && option !== '' && !props.options.includes(option) ? `${option} (current value)` : option}</option>)}
    </select>;
  }

  if (standard.kind === 'checkbox' || standard.kind === 'radio') {
    const checkbox = standard.kind === 'checkbox';
    // A radio keeps its current value as a choice; a checkbox holds one value per line.
    const selected = checkbox ? props.value.split(/\r\n|\r|\n/) : [props.value];
    const original = checkbox ? props.originalValue.split(/\r\n|\r|\n/).filter(Boolean) : [props.originalValue];
    const options = props.mode === 'designer' && !checkbox ? props.options.slice(0, 2)
      : Array.from(new Set([...props.options, ...original, ...(checkbox ? selected.filter(Boolean) : selected)]));
    return <div className={common.className} role={checkbox ? 'group' : 'radiogroup'} aria-label={props.object.fmFieldName} aria-describedby={description}
      style={{ ...baseControlStyle, display: 'flex', flexDirection: 'column', gap: 4 }}>
      {options.map((option, index) => <label key={option} style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
        <input id={index === 0 ? props.inputId : `${props.inputId}-${index}`} type={checkbox ? 'checkbox' : 'radio'}
          name={`choice-${props.object.id}`} value={option} checked={selected.includes(option)} disabled={disabled}
          onChange={(event) => props.onChange(checkbox
            ? checkboxValue(props.originalValue, event.currentTarget.checked ? [...selected, option] : selected.filter((value) => value !== option))
            : option)} />
        <span>{option === '' ? '(empty)' : option}</span>
      </label>)}
    </div>;
  }

  if (standard.kind === 'textarea') {
    // The text area shows line feeds only; the raw breaks of the stored value are kept.
    return <textarea {...common} value={props.value} readOnly={disabled}
      onChange={(event) => props.onChange(preserveTextLineEndings(props.value, event.currentTarget.value))} />;
  }

  // FileMaker returns dates in its server format. A browser date input would discard it.
  return <input {...common} type="text" inputMode={props.object.format === 'number' ? 'decimal' : undefined}
    value={props.value} readOnly={disabled} onChange={(event) => props.onChange(event.currentTarget.value)} />;
}

function getPreviewOptions(object: FieldLayoutObject, runtimeValue: unknown, mode: 'designer' | 'runtime'): string[] {
  if (mode === 'runtime') return object.options ?? [];
  if (object.options?.length) return object.options;
  if (runtimeValue !== undefined && runtimeValue !== null) return [String(runtimeValue)];
  if (object.format === 'number') return ['12,450.25', '98,000.00', '510.75'];
  if (object.format === 'date') return ['2026-03-03', '2026-03-10', '2026-03-17'];
  return [object.fmFieldName, `${object.fmFieldName} A`, `${object.fmFieldName} B`];
}

function PortalControl(props: {
  style: React.CSSProperties;
  object: PortalLayoutObject;
  mode: 'designer' | 'runtime';
  runtimeData?: RuntimeLayoutData;
}): React.JSX.Element {
  const { object, style } = props;
  const runtimeRows = props.runtimeData?.portalRowsByObjectId?.[object.id];
  const rows = React.useMemo(() => {
    if (props.mode === 'runtime') return runtimeRows ?? [];

    return Array.from({ length: Math.max(1, object.rowCount) }).map((_, rowIndex) => {
      const row: Record<string, unknown> = {};
      for (const column of object.columns) {
        row[column.fmFieldName] = buildPortalMockValue(column.fmFieldName, rowIndex);
      }
      return row;
    });
  }, [object.columns, object.rowCount, props.mode, runtimeRows]);

  const rowHeight = 32;
  const headerHeight = 34;
  const viewportHeight = Math.max(0, object.height - headerHeight);
  const shouldVirtualize = props.mode === 'runtime' && rows.length > 40;
  const [scrollTop, setScrollTop] = React.useState(0);

  const visibleRange = React.useMemo(() => {
    if (!shouldVirtualize) {
      return {
        start: 0,
        end: rows.length
      };
    }

    return computePortalVisibleRange(rows.length, viewportHeight, rowHeight, scrollTop);
  }, [rows.length, rowHeight, scrollTop, shouldVirtualize, viewportHeight]);

  const visibleRows = rows.slice(visibleRange.start, visibleRange.end);
  const topSpacerHeight = shouldVirtualize ? visibleRange.start * rowHeight : 0;
  const bottomSpacerHeight = shouldVirtualize ? Math.max(0, (rows.length - visibleRange.end) * rowHeight) : 0;

  return (
    <div
      style={{
        ...style,
        border: '1px solid #9fb0c3',
        borderRadius: 6,
        overflow: 'hidden',
        background: '#ffffff'
      }}
      data-fm-portal-id={object.id}
    >
      <div style={{ display: 'grid', gridTemplateColumns: buildColumnWidths(object), background: '#edf3f8' }}>
        {object.columns.map((column) => (
          <div key={column.id} style={{ padding: '6px 8px', borderRight: '1px solid #d2dce6', fontWeight: 600 }}>
            {column.label}
          </div>
        ))}
        {object.columns.length === 0 ? (
          <div style={{ padding: '6px 8px', fontWeight: 600, color: '#60788e' }}>Drop fields to create columns</div>
        ) : null}
      </div>
      <div
        style={{
          overflowY: shouldVirtualize ? 'auto' : 'hidden',
          maxHeight: viewportHeight > 0 ? viewportHeight : undefined
        }}
        onScroll={(event) => {
          if (!shouldVirtualize) {
            return;
          }

          const target = event.currentTarget;
          setScrollTop(target.scrollTop);
        }}
      >
        {topSpacerHeight > 0 ? <div style={{ height: topSpacerHeight }} /> : null}
        {visibleRows.map((row, index) => {
          const rowIndex = visibleRange.start + index;
          return (
            <div
              key={`${object.id}-${rowIndex}`}
              data-fm-portal-row={rowIndex}
              style={{
                display: 'grid',
                gridTemplateColumns: buildColumnWidths(object),
                borderTop: '1px solid #ecf1f6',
                minHeight: rowHeight
              }}
            >
              {object.columns.map((column) => {
                // A repeated field keeps its value under `Name(1)`, so the column finds it there.
                const value = row[recordFieldKey(row, column.fmFieldName)];
                return (
                  <div
                    key={`${column.id}-${rowIndex}`}
                    data-fm-portal-cell={`${column.fmFieldName}:${rowIndex}`}
                    style={{ padding: '6px 8px', borderRight: '1px solid #f0f4f8' }}
                  >
                    {props.mode === 'runtime' ? String(value ?? '') : formatPortalCellValue(value, column.fmFieldName, rowIndex)}
                  </div>
                );
              })}
              {object.columns.length === 0 ? (
                <div style={{ padding: '6px 8px', color: '#7a8e9f' }}>No columns configured</div>
              ) : null}
            </div>
          );
        })}
        {bottomSpacerHeight > 0 ? <div style={{ height: bottomSpacerHeight }} /> : null}
      </div>
    </div>
  );
}

function formatPortalCellValue(value: unknown, fieldName: string, rowIndex: number): string {
  if (value === undefined || value === null || value === '') {
    return buildPortalMockValue(fieldName, rowIndex);
  }

  return String(value);
}

function buildColumnWidths(object: PortalLayoutObject): string {
  if (object.columns.length === 0) {
    return '1fr';
  }

  return object.columns.map((column) => `${column.width}px`).join(' ');
}

function buildPortalMockValue(fieldName: string, rowIndex: number): string {
  const lower = fieldName.toLowerCase();
  const offset = rowIndex + 1;

  if (lower.includes('date')) {
    return `2026-03-${String(Math.min(28, offset)).padStart(2, '0')}`;
  }

  if (lower.includes('amount') || lower.includes('total') || lower.includes('price')) {
    return `${(offset * 1250.75).toFixed(2)}`;
  }

  return `${fieldName} ${offset}`;
}

export function computePortalVisibleRange(
  rowCount: number,
  viewportHeight: number,
  rowHeight: number,
  scrollTop: number,
  overscan = 3
): { start: number; end: number } {
  const visibleCount = Math.max(1, Math.ceil(viewportHeight / rowHeight) + overscan * 2);
  const start = Math.max(0, Math.floor(scrollTop / rowHeight) - overscan);
  const end = Math.min(rowCount, start + visibleCount);
  return {
    start,
    end
  };
}

export function applyAnchoredRuntimeRect(
  object: LayoutObject,
  layout: LayoutDefinition,
  viewport: RuntimeLayoutData['viewport']
): LayoutObject {
  if (!viewport) {
    return object;
  }

  const deltaWidth = viewport.width - layout.canvas.width;
  const deltaHeight = viewport.height - layout.canvas.height;
  if (deltaWidth === 0 && deltaHeight === 0) {
    return object;
  }

  const anchors = object.anchors;

  let x = object.x;
  let y = object.y;
  let width = object.width;
  let height = object.height;

  if (anchors.left && anchors.right) {
    width = Math.max(1, object.width + deltaWidth);
  } else if (anchors.right && !anchors.left) {
    x = object.x + deltaWidth;
  } else if (!anchors.left && !anchors.right) {
    x = object.x + deltaWidth / 2;
  }

  if (anchors.top && anchors.bottom) {
    height = Math.max(1, object.height + deltaHeight);
  } else if (anchors.bottom && !anchors.top) {
    y = object.y + deltaHeight;
  } else if (!anchors.top && !anchors.bottom) {
    y = object.y + deltaHeight / 2;
  }

  return {
    ...object,
    x: Math.round(x),
    y: Math.round(y),
    width: Math.max(1, Math.round(width)),
    height: Math.max(1, Math.round(height))
  };
}
