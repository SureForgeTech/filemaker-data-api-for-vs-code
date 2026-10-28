const vscode = acquireVsCodeApi();

const state = {
  running: false,
  profiles: [],
  activeProfileId: undefined,
  defaults: undefined,
  layoutsByProfile: new Map(),
  scriptRunnerEnabled: true,
  includeAuthByDefault: false,
  parameterBuilderEnabled: true
};

const PARAMETER_VALUE_TYPES = ['string', 'number', 'bool', 'json'];

const profileSelect = document.getElementById('profileSelect');
const layoutSelect = document.getElementById('layoutSelect');
const recordIdInput = document.getElementById('recordIdInput');
const scriptNameInput = document.getElementById('scriptNameInput');
const scriptParamInput = document.getElementById('scriptParamInput');
const buildParameterButton = document.getElementById('buildParameterButton');
const parameterBuilderPanel = document.getElementById('parameterBuilderPanel');
const parameterRows = document.getElementById('parameterRows');
const addParameterRowButton = document.getElementById('addParameterRowButton');
const parameterPreview = document.getElementById('parameterPreview');
const parameterBuilderStatus = document.getElementById('parameterBuilderStatus');
const applyParameterButton = document.getElementById('applyParameterButton');
const closeParameterBuilderButton = document.getElementById('closeParameterBuilderButton');
const includeAuthCheckbox = document.getElementById('includeAuthCheckbox');
const runButton = document.getElementById('runButton');
const status = document.getElementById('status');
const summary = document.getElementById('summary');
const rawResult = document.getElementById('rawResult');
const scriptRunnerPanels = Array.from(document.querySelectorAll('.panel'));
const scriptRunnerSkeleton = createLoadingSkeleton(['short', 'long', 'medium', 'long']);
let scriptRunnerReady = false;
let parameterRowCounter = 0;

const scriptRunnerHeader = document.querySelector('.header');
if (scriptRunnerHeader && scriptRunnerPanels.length > 0) {
  scriptRunnerHeader.insertAdjacentElement('afterend', scriptRunnerSkeleton);
  setElementsVisible(scriptRunnerPanels, false);
}

window.addEventListener('message', (event) => {
  if (event.origin !== window.location.origin) { return; }
  const message = event.data;
  if (!message || typeof message.type !== 'string') {
    return;
  }

  switch (message.type) {
    case 'init':
      applyInit(message.payload);
      revealScriptRunner();
      break;
    case 'layoutsLoaded':
      applyLayouts(message.payload);
      break;
    case 'scriptResult':
      setRunning(false);
      renderResult(message.payload);
      break;
    case 'unsupported':
      setStatus(message.message || 'Script runner unsupported.', true);
      runButton.disabled = true;
      break;
    case 'error':
      setRunning(false);
      summary.textContent = '';
      rawResult.textContent = '';
      setStatus(message.message || 'Unknown error.', true);
      break;
    default:
      break;
  }
});

profileSelect.addEventListener('change', () => {
  requestLayouts(profileSelect.value);
});

buildParameterButton.addEventListener('click', () => {
  openParameterBuilder();
});

addParameterRowButton.addEventListener('click', () => {
  appendParameterRow();
  renderParameterPreview();
});

applyParameterButton.addEventListener('click', () => {
  applyParameterBuilder();
});

closeParameterBuilderButton.addEventListener('click', () => {
  closeParameterBuilder();
});

runButton.addEventListener('click', () => {
  if (state.running) return;
  const payload = collectPayload();
  if (!payload) {
    return;
  }

  setRunning(true);
  summary.textContent = '';
  rawResult.textContent = '';
  setStatus('Running script...');
  vscode.postMessage({
    type: 'runScript',
    payload
  });
});

// Every format button under "Copy request" names its format (and, for Save as .http, an editor destination).
document.querySelectorAll('[data-copy-format]').forEach((button) => {
  button.addEventListener('click', () => {
    const payload = collectPayload();
    if (!payload) {
      return;
    }

    vscode.postMessage({
      type: 'copyRequest',
      payload: {
        ...payload,
        format: button.dataset.copyFormat,
        destination: button.dataset.copyDestination === 'editor' ? 'editor' : 'clipboard',
        includeAuthHeader: includeAuthCheckbox.checked
      }
    });
  });
});

// The menu closes after a choice, on outside click, and on Escape.
const copyRequestMenu = document.getElementById('copyRequestMenu');
if (copyRequestMenu) {
  copyRequestMenu.addEventListener('click', (event) => {
    if (event.target instanceof HTMLButtonElement && event.target.closest('.menu-items')) {
      copyRequestMenu.open = false;
    }
  });
  window.addEventListener('click', (event) => {
    if (!(event.target instanceof Element) || !event.target.closest('details.menu')) {
      copyRequestMenu.open = false;
    }
  });
  window.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && copyRequestMenu.open) {
      copyRequestMenu.open = false;
      copyRequestMenu.querySelector('summary')?.focus();
    }
  });
}

function applyInit(payload) {
  state.profiles = Array.isArray(payload.profiles) ? payload.profiles : [];
  state.activeProfileId = payload.activeProfileId;
  state.defaults = payload.defaults;
  state.scriptRunnerEnabled = payload.scriptRunnerEnabled !== false;
  state.includeAuthByDefault = payload.includeAuthByDefault === true;
  state.parameterBuilderEnabled = payload.parameterBuilderEnabled !== false;

  includeAuthCheckbox.checked = state.includeAuthByDefault;
  runButton.disabled = !state.scriptRunnerEnabled;
  buildParameterButton.disabled = !state.scriptRunnerEnabled || !state.parameterBuilderEnabled;
  buildParameterButton.classList.toggle('hidden', !state.parameterBuilderEnabled);

  if (!state.scriptRunnerEnabled) {
    setStatus('Script runner is disabled by setting.', true);
  }

  if (!state.parameterBuilderEnabled) {
    closeParameterBuilder();
  }

  renderProfiles();

  if (state.defaults && typeof state.defaults.recordId === 'string') {
    recordIdInput.value = state.defaults.recordId;
  }

  setStatus('Ready.');
}

function renderProfiles() {
  if (
    !syncSelectOptions(
      profileSelect,
      state.profiles,
      (profile) => profile.id,
      (profile) => `${profile.name} (${profile.database})`,
      'No profiles configured'
    )
  ) {
    return;
  }

  let selectedProfileId = state.defaults && state.defaults.profileId;
  if (!selectedProfileId) {
    selectedProfileId = state.activeProfileId || state.profiles[0].id;
  }

  if (!state.profiles.some((profile) => profile.id === selectedProfileId)) {
    selectedProfileId = state.profiles[0].id;
  }

  profileSelect.value = selectedProfileId;
  requestLayouts(selectedProfileId, state.defaults && state.defaults.layout);
}

function requestLayouts(profileId, preferredLayout) {
  if (!profileId) {
    return;
  }

  const cached = state.layoutsByProfile.get(profileId);
  if (cached) {
    renderLayouts(cached, preferredLayout);
    return;
  }

  setStatus('Loading layouts...');
  vscode.postMessage({
    type: 'loadLayouts',
    profileId
  });
}

function applyLayouts(payload) {
  if (!payload || typeof payload.profileId !== 'string' || !Array.isArray(payload.layouts)) {
    return;
  }

  state.layoutsByProfile.set(payload.profileId, payload.layouts);

  if (profileSelect.value === payload.profileId) {
    renderLayouts(payload.layouts, state.defaults && state.defaults.layout);
    state.defaults = undefined;
  }
}

function renderLayouts(layouts, preferredLayout) {
  if (
    !syncSelectOptions(
      layoutSelect,
      Array.isArray(layouts) ? layouts : [],
      (layout) => layout,
      (layout) => layout,
      'No layouts available'
    )
  ) {
    return;
  }

  if (preferredLayout && layouts.includes(preferredLayout)) {
    layoutSelect.value = preferredLayout;
    return;
  }

  if (!layouts.includes(layoutSelect.value)) {
    layoutSelect.value = layouts[0];
  }
}

function collectPayload() {
  const profileId = profileSelect.value;
  const layout = layoutSelect.value;
  const scriptName = scriptNameInput.value; // exactly as typed: a space can be part of a script name

  if (!profileId) {
    setStatus('Select a profile.', true);
    return undefined;
  }

  if (!layout) {
    setStatus('Select a layout.', true);
    return undefined;
  }

  if (!scriptName) {
    setStatus('Enter a script name.', true);
    return undefined;
  }

  if (scriptName === '.' || scriptName === '..' || layout === '.' || layout === '..') {
    // A web address treats these as folder references, so the request would be a different one.
    setStatus('A script or layout named "." or ".." cannot be used in a request. Rename it in FileMaker.', true);
    return undefined;
  }

  return {
    profileId,
    layout,
    recordId: recordIdInput.value.trim(),
    scriptName,
    scriptParam: scriptParamInput.value
  };
}

function openParameterBuilder() {
  if (!state.parameterBuilderEnabled) {
    return;
  }

  parameterRows.replaceChildren();
  createRowsFromExistingParameter(scriptParamInput.value).forEach((row) => {
    appendParameterRow(row);
  });

  parameterBuilderPanel.classList.remove('hidden');
  buildParameterButton.setAttribute('aria-expanded', 'true');
  renderParameterPreview();

  const firstKeyInput = parameterRows.querySelector('[data-field="key"]');
  if (firstKeyInput) {
    firstKeyInput.focus();
  }
}

function closeParameterBuilder() {
  parameterBuilderPanel.classList.add('hidden');
  buildParameterButton.setAttribute('aria-expanded', 'false');
}

function appendParameterRow(row = createEmptyParameterRow()) {
  const rowId = `parameterBuilderRow${parameterRowCounter}`;
  parameterRowCounter += 1;

  const rowElement = document.createElement('div');
  rowElement.className = 'builder-row';

  const keyInput = document.createElement('input');
  keyInput.id = `${rowId}Key`;
  keyInput.type = 'text';
  keyInput.placeholder = 'key';
  keyInput.value = row.key;
  keyInput.dataset.field = 'key';
  keyInput.addEventListener('input', renderParameterPreview);

  const typeSelect = document.createElement('select');
  typeSelect.id = `${rowId}Type`;
  typeSelect.dataset.field = 'type';
  PARAMETER_VALUE_TYPES.forEach((type) => {
    const option = document.createElement('option');
    option.value = type;
    option.textContent = getParameterTypeLabel(type);
    typeSelect.appendChild(option);
  });
  typeSelect.value = normalizeParameterType(row.type);

  const keyField = createBuilderField('Key', keyInput);
  const typeField = createBuilderField('Type', typeSelect);
  const valueField = document.createElement('div');
  valueField.className = 'builder-field builder-value-field';

  renderBuilderValueControl(valueField, rowId, typeSelect.value, row.value);

  typeSelect.addEventListener('change', () => {
    const existingValue = rowElement.querySelector('[data-field="value"]');
    renderBuilderValueControl(
      valueField,
      rowId,
      typeSelect.value,
      existingValue ? existingValue.value : ''
    );
    renderParameterPreview();
  });

  const removeButton = document.createElement('button');
  removeButton.type = 'button';
  removeButton.textContent = 'Remove';
  removeButton.className = 'secondary builder-remove-button';
  removeButton.addEventListener('click', () => {
    rowElement.remove();

    if (!parameterRows.querySelector('.builder-row')) {
      appendParameterRow();
    }

    renderParameterPreview();
  });

  rowElement.append(keyField, typeField, valueField, removeButton);
  parameterRows.appendChild(rowElement);
}

function createBuilderField(labelText, control) {
  const field = document.createElement('div');
  field.className = 'builder-field';

  const label = document.createElement('label');
  label.textContent = labelText;
  label.htmlFor = control.id;

  field.append(label, control);
  return field;
}

function renderBuilderValueControl(field, rowId, type, value) {
  const label = document.createElement('label');
  label.textContent = 'Value';
  label.htmlFor = `${rowId}Value`;

  const normalizedType = normalizeParameterType(type);
  let control;

  if (normalizedType === 'bool') {
    control = document.createElement('select');
    const trueOption = document.createElement('option');
    trueOption.value = 'true';
    trueOption.textContent = 'true';
    const falseOption = document.createElement('option');
    falseOption.value = 'false';
    falseOption.textContent = 'false';
    control.append(trueOption, falseOption);
    control.value = value === 'false' ? 'false' : 'true';
    control.addEventListener('change', renderParameterPreview);
  } else if (normalizedType === 'number') {
    control = document.createElement('input');
    control.type = 'number';
    control.step = 'any';
    control.inputMode = 'decimal';
    control.value = value;
    control.addEventListener('input', renderParameterPreview);
  } else {
    control = document.createElement('textarea');
    control.rows = normalizedType === 'json' ? 4 : 1;
    control.value = value;
    control.addEventListener('input', renderParameterPreview);
  }

  control.id = `${rowId}Value`;
  control.dataset.field = 'value';
  control.className = normalizedType === 'json' ? 'builder-json-value fm-code' : '';
  field.replaceChildren(label, control);
}

function renderParameterPreview() {
  const result = buildParameterJson(collectParameterBuilderRows());
  parameterPreview.textContent = result.json || '';
  parameterBuilderStatus.textContent = result.error || '';
  parameterBuilderStatus.classList.toggle('error', Boolean(result.error));
  applyParameterButton.disabled = Boolean(result.error);
}

function applyParameterBuilder() {
  const result = buildParameterJson(collectParameterBuilderRows());

  if (result.error) {
    renderParameterPreview();
    return;
  }

  scriptParamInput.value = result.json;
  closeParameterBuilder();
  setStatus('Parameter JSON generated.');
}

function collectParameterBuilderRows() {
  return Array.from(parameterRows.querySelectorAll('.builder-row')).map((row) => {
    const keyInput = row.querySelector('[data-field="key"]');
    const typeSelect = row.querySelector('[data-field="type"]');
    const valueInput = row.querySelector('[data-field="value"]');

    return {
      key: keyInput ? keyInput.value : '',
      type: typeSelect ? typeSelect.value : 'string',
      value: valueInput ? valueInput.value : ''
    };
  });
}

function createRowsFromExistingParameter(parameter) {
  const trimmed = typeof parameter === 'string' ? parameter.trim() : '';
  if (!trimmed) {
    return [createEmptyParameterRow()];
  }

  try {
    const parsed = JSON.parse(trimmed);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return [createEmptyParameterRow()];
    }

    const rows = Object.entries(parsed).map(([key, value]) => ({
      key,
      ...inferParameterRowValue(value)
    }));

    return rows.length > 0 ? rows : [createEmptyParameterRow()];
  } catch {
    return [createEmptyParameterRow()];
  }
}

function createEmptyParameterRow() {
  return {
    key: '',
    type: 'string',
    value: ''
  };
}

function inferParameterRowValue(value) {
  if (typeof value === 'string') {
    return {
      type: 'string',
      value
    };
  }

  if (typeof value === 'number' && Number.isFinite(value)) {
    return {
      type: 'number',
      value: String(value)
    };
  }

  if (typeof value === 'boolean') {
    return {
      type: 'bool',
      value: value ? 'true' : 'false'
    };
  }

  return {
    type: 'json',
    value: JSON.stringify(value, null, 2)
  };
}

function buildParameterJson(rows) {
  const output = Object.create(null);
  const seenKeys = new Set();

  for (const [index, row] of rows.entries()) {
    const key = typeof row.key === 'string' ? row.key.trim() : '';
    const type = normalizeParameterType(row.type);
    const value = typeof row.value === 'string' ? row.value : '';
    const isEmptyRow = key === '' && type === 'string' && value === '';

    if (isEmptyRow) {
      continue;
    }

    if (!key) {
      return {
        json: '',
        error: `Row ${index + 1}: key is required.`
      };
    }

    if (seenKeys.has(key)) {
      return {
        json: '',
        error: `Row ${index + 1}: key "${key}" is duplicated.`
      };
    }

    const parsed = parseParameterValue(type, value, index);
    if (parsed.error) {
      return {
        json: '',
        error: parsed.error
      };
    }

    seenKeys.add(key);
    output[key] = parsed.value;
  }

  return {
    json: JSON.stringify(output, null, 2),
    error: ''
  };
}

function parseParameterValue(type, value, index) {
  if (type === 'string') {
    return {
      value,
      error: ''
    };
  }

  if (type === 'number') {
    const trimmed = value.trim();
    const parsed = Number(trimmed);

    if (!trimmed || !Number.isFinite(parsed)) {
      return {
        value: undefined,
        error: `Row ${index + 1}: enter a valid number.`
      };
    }

    return {
      value: parsed,
      error: ''
    };
  }

  if (type === 'bool') {
    return {
      value: value === 'true',
      error: ''
    };
  }

  try {
    return {
      value: JSON.parse(value.trim()),
      error: ''
    };
  } catch {
    return {
      value: undefined,
      error: `Row ${index + 1}: enter valid JSON.`
    };
  }
}

function normalizeParameterType(type) {
  return PARAMETER_VALUE_TYPES.includes(type) ? type : 'string';
}

function getParameterTypeLabel(type) {
  switch (type) {
    case 'number':
      return 'Number';
    case 'bool':
      return 'Boolean';
    case 'json':
      return 'JSON';
    case 'string':
    default:
      return 'String';
  }
}

function createLoadingSkeleton(widths) {
  const skeleton = document.createElement('div');
  skeleton.className = 'loading-skeleton';

  widths.forEach((width) => {
    const line = document.createElement('div');
    line.className = `skeleton-line ${width}`;
    skeleton.appendChild(line);
  });

  return skeleton;
}

function syncSelectOptions(select, items, getValue, getLabel, emptyLabel) {
  if (!Array.isArray(items) || items.length === 0) {
    const option = document.createElement('option');
    option.value = '';
    option.textContent = emptyLabel;
    select.replaceChildren(option);
    return false;
  }

  const existingOptions = new Map(
    Array.from(select.options).map((option) => [option.value, option])
  );

  items.forEach((item, index) => {
    const value = getValue(item);
    const label = getLabel(item);
    let option = existingOptions.get(value);

    if (!option) {
      option = document.createElement('option');
      option.value = value;
    }

    option.textContent = label;
    option.title = label; // the full text, since a long name is clipped in the list

    if (select.children[index] !== option) {
      select.insertBefore(option, select.children[index] || null);
    }

    existingOptions.delete(value);
  });

  existingOptions.forEach((option) => option.remove());
  return true;
}

function setElementsVisible(elements, isVisible) {
  elements.forEach((element) => {
    element.style.display = isVisible ? '' : 'none';
  });

  scriptRunnerSkeleton.classList.toggle('hidden', isVisible);
}

function revealScriptRunner() {
  if (scriptRunnerReady) {
    return;
  }

  scriptRunnerReady = true;
  setElementsVisible(scriptRunnerPanels, true);
}

function renderResult(payload) {
  const result = payload && payload.result ? payload.result : {};
  const messages = Array.isArray(result.messages) ? result.messages : [];

  const scriptErrors = payload && Array.isArray(payload.scriptErrors) ? payload.scriptErrors : [];
  const failed = scriptErrors.length > 0;

  if (failed) {
    // The request worked, the script did not: say so in the headline, with the error code and its meaning.
    summary.textContent = `Script reported an error: ${payload.scriptErrorText || scriptErrors.map((item) => item.code).join(', ')}`;
  } else {
    summary.textContent = messages.length
      ? `Messages: ${messages.map((item) => `${item.code}:${item.message}`).join(' | ')}`
      : 'Script executed.';
  }
  summary.classList.toggle('error', failed);

  rawResult.textContent = JSON.stringify(payload, null, 2);
  setStatus(failed ? 'Script ran, but it reported an error.' : 'Script execution completed.', failed);
}

function setStatus(message, isError = false) {
  status.textContent = message;
  status.classList.toggle('error', isError);
}

vscode.postMessage({ type: 'ready' });

function setRunning(running) {
  state.running = running;
  runButton.disabled = running || !state.scriptRunnerEnabled;
}
