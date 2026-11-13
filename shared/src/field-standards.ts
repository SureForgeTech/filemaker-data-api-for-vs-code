export { orderFields } from './field-order';

/** Dependency-free presentation rules shared by the designer and value-entry webviews. */
export const FIELD_LAYOUT = Object.freeze({
  grid: 8,
  pageMargin: 24,
  rowGap: 16,
  columnGap: 24,
  labelPosition: 'top' as const,
  labelSpace: 24,
  optionHeight: 24,
  textWidth: 240,
  numberWidth: 120,
  temporalWidth: 160,
  inputHeight: 34,
  multilineHeight: 96,
  containerHeight: 160
});

export interface StandardFieldMetadata {
  name: string;
  type?: string;
  displayType?: string;
  multiline?: boolean;
  optionCount?: number;
  result?: string;
  kind?: 'normal' | 'calculation' | 'summary' | 'container' | 'global';
  maxLength?: number;
  height?: number;
  value?: unknown;
  options?: readonly string[];
  /** Forces a plain text control, so FileMaker's own find operators stay typeable. */
  freeText?: boolean;
}

export type StandardControlKind = 'input' | 'textarea' | 'select' | 'radio' | 'checkbox' | 'container';

/** Types whose values are plain text. FileMaker reports a text field as `normal` with a `text` result. */
const TEXT_TYPES = ['', 'text', 'normal', 'string'];

/** The most lines a text field can show; a larger height is a layout size, not a count of lines. */
const MAX_TEXT_LINES = 10;

/**
 * A text field needs more than one line when its height counts lines. FileMaker reports the
 * height of a layout object in points, so only a small number can be a count of lines.
 */
function isTextLineCount(height: number | undefined): boolean {
  return typeof height === 'number' && Number.isFinite(height) && height > 1 && height <= MAX_TEXT_LINES;
}

/**
 * A text field needs more than one line when its character limit is unlimited (FileMaker reports
 * `maxCharacters: 0`), when the limit is large, or when the value itself carries a line break.
 */
function isLongText(field: Partial<StandardFieldMetadata>, value: string): boolean {
  if (typeof field.maxLength === 'number' && (field.maxLength === 0 || field.maxLength > 100)) {
    return true;
  }
  return value.length > 100 || /[\r\n]/.test(value);
}

export function standardControlFor(field: Partial<StandardFieldMetadata> = {}): {
  kind: StandardControlKind; width: number; height: number; readOnly: boolean;
} {
  const normalize = (value?: string): string => (value ?? '').trim().toLowerCase().replace(/[ -]/g, '');
  const type = normalize(field.result || field.type);
  const display = normalize(field.displayType);
  const readOnly = ['calculation', 'summary', 'container'].includes(normalize(field.kind || field.type)) || type === 'container';
  const value = String(field.value ?? '');
  let kind: StandardControlKind = 'input';
  if (field.freeText) kind = 'input';
  else if (type === 'container' || normalize(field.kind) === 'container') kind = 'container';
  else if (['popup', 'popupmenu', 'dropdown', 'dropdownlist'].includes(display)) kind = 'select';
  else if (['checkbox', 'checkboxset'].includes(display)) kind = 'checkbox';
  else if (['radio', 'radiobuttongroup', 'radiobuttons'].includes(display)) kind = 'radio';
  else if (field.multiline || ['longtext', 'multilinetext', 'multiline'].includes(type)
    || ['textarea', 'multiline'].includes(display)
    || (TEXT_TYPES.includes(type) && isLongText(field, value))
    || (TEXT_TYPES.includes(type) && display === 'edittext' && isTextLineCount(field.height))) kind = 'textarea';
  const count = field.optionCount ?? field.options?.length;
  const height = kind === 'container' ? FIELD_LAYOUT.containerHeight : kind === 'textarea' ? FIELD_LAYOUT.multilineHeight
    : kind === 'checkbox' || kind === 'radio' ? Math.max(FIELD_LAYOUT.inputHeight,
      (Number.isFinite(count) ? Math.min(50, Math.max(1, Math.ceil(count!))) : 1) * FIELD_LAYOUT.optionHeight)
      : FIELD_LAYOUT.inputHeight;
  return { kind, readOnly, width: type === 'number' ? FIELD_LAYOUT.numberWidth
    : ['date', 'time', 'timestamp'].includes(type) ? FIELD_LAYOUT.temporalWidth : FIELD_LAYOUT.textWidth, height };
}

let nextChoiceGroup = 0;

/**
 * A checkbox or radio field whose options are not known cannot be shown as a group of choices.
 * Such a field stays editable text, so its stored value is never lost.
 */
export function choiceDisplayType(displayType: string | undefined, options: readonly string[] | undefined): string | undefined {
  const display = (displayType ?? '').toLowerCase().replace(/[ -]/g, '');
  const isChoice = display.includes('checkbox') || display.includes('radio');
  return isChoice && !options?.length ? 'editBox' : displayType;
}

/**
 * A text area shows line feeds only. A stored value that uses carriage returns would be rewritten
 * as soon as anything else in the field changed, so the raw breaks are kept around every edit.
 */
export function preserveTextLineEndings(previous: string, next: string): string {
  const tokens = previous.match(/\r\n|[\s\S]/g) ?? [];
  const displayed = previous.replace(/\r\n|\r/g, '\n');
  if (displayed === next) return previous;
  let suffix = 0;
  while (suffix < Math.min(displayed.length, next.length)
    && displayed[displayed.length - suffix - 1] === next[next.length - suffix - 1]) suffix++;
  let prefix = 0;
  while (prefix < Math.min(displayed.length, next.length) - suffix && displayed[prefix] === next[prefix]) prefix++;
  const removedBreaks = tokens.slice(prefix, tokens.length - suffix).filter((token) => /[\r\n]/.test(token));
  const separator = tokens.find((token) => /[\r\n]/.test(token)) ?? '\n';
  const inserted = next.slice(prefix, next.length - suffix).replace(/\n/g, () => removedBreaks.shift() ?? separator);
  return tokens.slice(0, prefix).join('') + inserted + tokens.slice(tokens.length - suffix).join('');
}

/**
 * A checkbox set keeps the order and the separators it was stored with. The stored value is
 * returned unchanged when the selection is the same set as it was, so an untouched field is
 * never rewritten and the order of the options on screen does not matter.
 */
export function checkboxValue(original: string, values: readonly string[]): string {
  const selected = new Set(values.filter((value) => value !== ''));
  const parts = original.split(/(\r\n|\r|\n)/);
  const before = new Set(parts.filter((value, index) => index % 2 === 0 && value !== ''));
  if (selected.size === before.size && [...selected].every((value) => before.has(value))) return original;
  if (!selected.size) return '';
  let result = '';
  for (let index = 0; index < parts.length; index += 2) {
    if (parts[index] === '' || selected.has(parts[index])) result += parts[index] + (parts[index + 1] ?? '');
  }
  const added = [...selected].filter((value) => !before.has(value));
  if (added.length) {
    const trailing = /(?:\r\n|\r|\n)$/.exec(result || original)?.[0] ?? '';
    const separator = trailing || /\r\n|\r|\n/.exec(original)?.[0] || '\r';
    result += (result && !trailing ? separator : '') + added.join(separator) + trailing;
  }
  return result;
}

/** The scheme and host of a server URL, without its path; nothing for a URL that is not http(s). */
export function serverOrigin(serverUrl: string | undefined): string | undefined {
  if (!serverUrl) return undefined;
  try {
    const url = new URL(serverUrl);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;
    return `${url.protocol}//${url.host}`;
  } catch {
    return undefined;
  }
}

/** DOM controls for the extension's CSP-restricted pages; values and names are never normalized. */
export function createStandardControl(document: Document, field: Partial<StandardFieldMetadata>, value: string,
  onChange: (value: string) => void, readOnly = false, serverUrl?: string): HTMLElement {
  const standard = standardControlFor({ ...field, value, displayType: choiceDisplayType(field.displayType, field.options) });
  const locked = readOnly || standard.readOnly;
  let control: HTMLElement;
  if (standard.kind === 'container') {
    control = document.createElement('div');
    control.className = 'fm-container fm-readonly';
    const origin = serverOrigin(serverUrl);
    if (origin && serverOrigin(value) === origin) {
      const link = document.createElement('a');
      link.href = value;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.textContent = 'Open container';
      if (/\.(?:avif|bmp|gif|jpe?g|png|svg|webp)(?:[?#]|$)/i.test(value)) {
        const image = document.createElement('img');
        image.src = value;
        image.alt = field.name ?? '';
        // A blocked or missing image must not hide where the container lives.
        image.addEventListener('error', () => {
          link.replaceChildren(document.createTextNode(value));
        });
        link.replaceChildren(image);
      }
      control.appendChild(link);
    } else control.textContent = value;
  } else if (standard.kind === 'checkbox' || standard.kind === 'radio') {
    control = document.createElement('div');
    control.setAttribute('role', standard.kind === 'radio' ? 'radiogroup' : 'group');
    const groupName = `fm-choice-${nextChoiceGroup++}`;
    // A radio keeps its current value as a choice; a checkbox holds one value per line.
    const selected = standard.kind === 'radio' ? [value] : value.split(/\r\n|\r|\n/);
    const options = Array.from(new Set([...(field.options ?? []), ...(standard.kind === 'radio' ? selected : selected.filter(Boolean))]));
    for (const option of options) {
      const label = document.createElement('label');
      const input = document.createElement('input');
      input.type = standard.kind;
      input.name = groupName;
      input.value = option;
      input.checked = selected.includes(option);
      input.disabled = locked;
      input.addEventListener('change', () => {
        if (locked) return;
        onChange(standard.kind === 'radio' ? option : checkboxValue(value,
          Array.from(control.querySelectorAll<HTMLInputElement>('input:checked')).map((item) => item.value)));
      });
      label.append(input, document.createTextNode(option === '' ? '(empty)' : option));
      control.appendChild(label);
    }
    if (locked) control.classList.add('fm-readonly');
  } else {
    const input = document.createElement(standard.kind === 'select' ? 'select' : standard.kind === 'textarea' ? 'textarea' : 'input');
    if (input instanceof document.defaultView!.HTMLSelectElement) {
      const options = Array.from(new Set(['', ...(field.options ?? []), value]));
      for (const option of options) {
        const item = document.createElement('option');
        item.value = option;
        item.textContent = option === value && option !== '' && !field.options?.includes(option) ? `${option} (current value)` : option;
        input.appendChild(item);
      }
      input.disabled = locked;
    } else {
      input.readOnly = locked;
      if (standard.kind === 'input' && (field.result || field.type)?.toLowerCase() === 'number') input.inputMode = 'decimal';
    }
    input.value = value;
    // The text area shows line feeds only; the raw breaks of the stored value are kept.
    let rawValue = value;
    input.addEventListener(standard.kind === 'select' ? 'change' : 'input', () => {
      if (locked) return;
      rawValue = standard.kind === 'textarea' ? preserveTextLineEndings(rawValue, input.value) : input.value;
      onChange(rawValue);
    });
    control = input;
  }
  control.classList.add('fm-field-control');
  return control;
}

export function standardFieldSize(field: Partial<StandardFieldMetadata> = {}): { width: number; height: number } {
  const { width, height } = standardControlFor(field);
  return { width, height };
}

/** Data attributes select build-generated CSS; webviews never need inline styles or relaxed CSP. */
export function applyStandardField(element: { setAttribute(name: string, value: string): void }, field: Partial<StandardFieldMetadata> = {}): void {
  const size = standardFieldSize(field);
  element.setAttribute('data-fm-width', String(size.width));
  element.setAttribute('data-fm-height', String(size.height));
  element.setAttribute('data-fm-label-position', FIELD_LAYOUT.labelPosition);
}

/** Field geometry for all clients. Opt into extension page chrome when building a webview. */
export function standardFieldsCss(webview = false): string {
  const widths = new Set([FIELD_LAYOUT.textWidth, FIELD_LAYOUT.numberWidth, FIELD_LAYOUT.temporalWidth]);
  const heights = new Set([FIELD_LAYOUT.inputHeight, FIELD_LAYOUT.multilineHeight, FIELD_LAYOUT.containerHeight,
    ...Array.from({ length: 50 }, (_, i) => Math.max(FIELD_LAYOUT.inputHeight, (i + 1) * FIELD_LAYOUT.optionHeight))]);
  return (webview ? webviewBaseCss() : '') + `
:root { --fm-row-gap: ${FIELD_LAYOUT.rowGap}px; --fm-column-gap: ${FIELD_LAYOUT.columnGap}px; }
.fm-fields { display: flex; flex-wrap: wrap; align-items: flex-start; gap: ${FIELD_LAYOUT.rowGap}px ${FIELD_LAYOUT.columnGap}px; min-width: 0; }
.fm-field { display: flex; flex-direction: column; width: var(--fm-field-width); max-width: 100%; min-width: 0; box-sizing: border-box; }
.fm-field-label { display: block; min-height: ${FIELD_LAYOUT.labelSpace}px; overflow-wrap: anywhere; }
.fm-field > .fm-field-control { flex: none; }
.fm-field-control[type="text"], input.fm-field-control { white-space: nowrap; overflow-wrap: normal; }
textarea.fm-field-control { resize: vertical; }
textarea.fm-field-control[readonly] { resize: none; }
.fm-container { overflow: auto; }
.fm-container img { max-width: 100%; max-height: 100%; object-fit: contain; }
.fm-field-control[role="group"], .fm-field-control[role="radiogroup"] { overflow: auto; }
.fm-field-control[role="group"] > label, .fm-field-control[role="radiogroup"] > label { display: flex; align-items: center; min-height: 24px; gap: 6px; }
.fm-field-control { display: block; width: 100%; max-width: 100%; min-width: 0; height: var(--fm-field-height); min-height: var(--fm-field-height); box-sizing: border-box; }
.fm-field-table { display: block; width: 100%; min-width: 0; }
.fm-field-table > thead { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); }
.fm-field-table > tbody > tr > td { display: block; border: 0; padding: 0; max-width: 100%; min-width: 0; }
.fm-field-table > tbody > tr > td.fm-field-control { padding: 8px; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; }
${[...widths].map((width) => `[data-fm-width="${width}"] { --fm-field-width: ${width}px; }`).join('\n')}
${[...heights].map((height) => `[data-fm-height="${height}"] { --fm-field-height: ${webview && height === FIELD_LAYOUT.inputHeight ? 'var(--fm-control-height)' : `${height}px`}; }`).join('\n')}
@media (max-width: 640px) {
  .fm-fields { flex-direction: column; }
}
`;
}

/** Extension chrome only: generated FM Web pages keep their own page styling. */
function webviewBaseCss(): string {
  return `
:root {
  --fm-control-height: ${FIELD_LAYOUT.inputHeight}px;
  --fm-input-background: var(--vscode-input-background, #ffffff);
  --fm-input-foreground: var(--vscode-input-foreground, #333333);
  --fm-page-width: 1200px;
  --fm-control-radius: 4px;
  --fm-panel-radius: 8px;
  --fm-panel-padding: 16px;
  --bg: var(--vscode-editor-background, #ffffff);
  --panel: var(--vscode-editorWidget-background, #f3f3f3);
  --text: var(--vscode-foreground, #333333);
  --muted: color-mix(in srgb, var(--vscode-descriptionForeground, var(--vscode-foreground, #333333)) 75%, var(--vscode-foreground, #333333));
  --border: var(--vscode-contrastBorder, var(--vscode-panel-border, #cccccc));
  --accent: var(--vscode-button-background, #007acc);
  --accent-text: var(--vscode-button-foreground, #ffffff);
  --accent-strong: var(--vscode-button-hoverBackground, #0062a3);
  --secondary: var(--vscode-button-secondaryBackground, var(--bg));
  --secondary-text: var(--vscode-button-secondaryForeground, var(--text));
  --secondary-hover: var(--vscode-button-secondaryHoverBackground, var(--vscode-list-hoverBackground, var(--bg)));
  --success: var(--vscode-testing-iconPassed, var(--vscode-charts-green, var(--vscode-terminal-ansiGreen, var(--vscode-foreground, #333333))));
  --error: var(--vscode-errorForeground, #a1260d);
}
.vscode-dark, .vscode-high-contrast {
  --fm-input-background: var(--vscode-input-background, #3c3c3c);
  --fm-input-foreground: var(--vscode-input-foreground, #cccccc);
}
* { box-sizing: border-box; }
body { margin: 0; font-family: var(--vscode-font-family, sans-serif); font-size: var(--vscode-font-size, 13px); color: var(--text); background: var(--bg); line-height: 1.4; }
.container, .wrap, .fm-page, .app-shell { width: 100%; max-width: var(--fm-page-width); margin: 0; padding: 16px; min-width: 0; }
h1 { margin: 0 0 8px; font-size: 1.6em; font-weight: 600; }
h2 { margin: 0 0 12px; font-size: 1.2em; font-weight: 600; }
h3 { font-size: 1.05em; }
.panel, .card, .form-section, .pane, .center-pane, .console-pane, .builder-panel, .fm-panel { background: var(--panel); border: 1px solid var(--border); border-radius: var(--fm-panel-radius); padding: var(--fm-panel-padding); min-width: 0; }
input, select, textarea { font: inherit; border: 1px solid var(--border); border-color: var(--vscode-contrastBorder, var(--vscode-input-border, var(--border))); border-radius: var(--fm-control-radius); padding: 6px 10px; min-width: 0; background: var(--fm-input-background); color: var(--fm-input-foreground); accent-color: var(--vscode-focusBorder, #007acc); }
input:not([type="checkbox"]):not([type="radio"]), select { height: var(--fm-control-height); }
code, pre, .fm-code { font-family: var(--vscode-editor-font-family, monospace); }
[readonly], .fm-readonly { background: var(--fm-input-background); color: var(--fm-input-foreground); border-style: dashed; border-color: var(--vscode-contrastBorder, var(--vscode-input-border, var(--border))); cursor: default; resize: none; }
input:disabled, select:disabled, textarea:disabled { background: var(--fm-input-background); color: var(--vscode-disabledForeground, var(--muted)); cursor: default; resize: none; }
@media (forced-colors: active) {
  [readonly], .fm-readonly { background: Canvas; color: CanvasText; border-color: CanvasText; forced-color-adjust: auto; }
}
button, summary.secondary, details.menu > summary { font: inherit; font-weight: 500; border: 1px solid var(--vscode-contrastBorder, transparent); border-radius: var(--fm-control-radius); background: var(--accent); color: var(--accent-text); padding: 5px 12px; min-height: 32px; align-self: center; cursor: pointer; }
button:hover:not(:disabled), button:active:not(:disabled), button:focus-visible:not(:disabled) { background: var(--accent-strong); color: var(--accent-text); }
button.secondary, summary.secondary, details.menu > summary, .mode-switch button, .mode-toggle button, .tool-grid button, .object-list button, .action-row button, .field-chip, .inspector-field button, .portal-column-actions button, .portal-field-chip { background: var(--secondary); color: var(--secondary-text); }
button.secondary:is(:hover, :active, :focus-visible):not(:disabled),
summary.secondary:is(:hover, :active, :focus-visible):not(:disabled),
details.menu > summary:is(:hover, :active, :focus-visible):not(:disabled),
.mode-switch button:is(:hover, :active, :focus-visible):not(:disabled),
.mode-toggle button:is(:hover, :active, :focus-visible):not(:disabled),
.tool-grid button:is(:hover, :active, :focus-visible):not(:disabled),
.object-list button:is(:hover, :active, :focus-visible):not(:disabled),
.action-row button:is(:hover, :active, :focus-visible):not(:disabled),
.field-chip:is(:hover, :active, :focus-visible):not(:disabled),
.inspector-field button:is(:hover, :active, :focus-visible):not(:disabled),
.portal-column-actions button:is(:hover, :active, :focus-visible):not(:disabled),
.portal-field-chip:is(:hover, :active, :focus-visible):not(:disabled) { background: var(--secondary-hover); color: var(--secondary-text); }
.mode-switch button.active, .mode-toggle button.active { border-color: var(--vscode-focusBorder, #007acc); font-weight: 600; }
button.small { padding: 2px 8px; min-height: 0; }
button.link, button.icon { background: none; color: var(--vscode-textLink-foreground, #005fb8); padding: 0 4px; min-height: 0; }
button.link:is(:hover, :active, :focus-visible):not(:disabled), button.icon:is(:hover, :active, :focus-visible):not(:disabled) { background: var(--vscode-list-hoverBackground, var(--panel)); color: var(--vscode-textLink-foreground, #005fb8); }
button.link.danger, button.link.danger:is(:hover, :active, :focus-visible):not(:disabled) { color: var(--error); }
button:disabled { opacity: 0.5; cursor: default; }
summary { font: inherit; min-height: 32px; border-radius: var(--fm-control-radius); padding: 5px 12px; cursor: pointer; }
button, summary { outline: 1px solid var(--vscode-contrastBorder, transparent); }
input:focus-visible, select:focus-visible, textarea:focus-visible, button:focus-visible, summary:focus-visible, a:focus-visible { outline: 2px solid var(--vscode-contrastActiveBorder, var(--vscode-focusBorder, #007acc)); outline-offset: 1px; }
input::placeholder, textarea::placeholder { color: color-mix(in srgb, var(--vscode-input-placeholderForeground, color-mix(in srgb, var(--vscode-input-foreground, var(--text)) 75%, var(--vscode-input-background, var(--bg)))) 20%, var(--vscode-input-foreground, var(--text))); opacity: 1; }
.fm-banner, .status.success, .status.error, .status.warning, .status.info, .summary.error, .template-banner, .restricted-notice, .legacy-tls-warning, .conflict { border: 1px solid var(--vscode-contrastBorder, var(--vscode-inputValidation-infoBorder, var(--border))); border-radius: var(--fm-panel-radius); padding: 10px; margin: 12px 0; background: var(--vscode-inputValidation-infoBackground, var(--panel)); color: var(--vscode-inputValidation-infoForeground, var(--text)); overflow-wrap: anywhere; }
.fm-banner.error, .status.error, .summary.error, .conflict { background: var(--vscode-inputValidation-errorBackground, var(--panel)); color: var(--vscode-inputValidation-errorForeground, var(--text)); border-color: var(--vscode-contrastBorder, var(--vscode-inputValidation-errorBorder, var(--error))); }
.fm-banner.warning, .status.warning, .restricted-notice, .legacy-tls-warning { background: var(--vscode-inputValidation-warningBackground, var(--panel)); color: var(--vscode-inputValidation-warningForeground, var(--text)); border-color: var(--vscode-contrastBorder, var(--vscode-inputValidation-warningBorder, var(--border))); }
.fm-banner.success, .status.success { background: color-mix(in srgb, var(--success) 12%, var(--bg)); color: var(--text); border-color: var(--vscode-contrastBorder, var(--success)); }
.fm-banner:empty, .status:empty, .summary:empty { min-height: 0; padding: 0; margin: 0; border: 0; }
table { width: 100%; border-collapse: collapse; font: inherit; }
th, td { border: 1px solid var(--border); padding: 8px; text-align: left; vertical-align: top; }
th { font-weight: 600; background: var(--panel); }
a:any-link { color: var(--vscode-textLink-foreground, #005fb8); }
a:hover { text-decoration: underline; }
`;
}
