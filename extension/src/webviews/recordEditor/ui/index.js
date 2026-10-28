const vscode = acquireVsCodeApi();

function debounce(fn, ms) {
  let timer;
  function wrapped(...args) {
    clearTimeout(timer);
    timer = setTimeout(() => fn.apply(this, args), ms);
  }

  wrapped.cancel = () => {
    clearTimeout(timer);
    timer = undefined;
  };

  return wrapped;
}

const state = {
  // 'edit' loads and saves one record; 'create' lists a layout's fields and creates a new record.
  busy: false,
  mode: 'edit',
  profiles: [],
  activeProfileId: undefined,
  defaults: undefined,
  layoutsByProfile: new Map(),
  loaded: undefined,
  originalFieldData: Object.create(null),
  draftFieldData: Object.create(null),
  fields: [],
  presentationFields: []
};

const profileSelect = document.getElementById('profileSelect');
const layoutSelect = document.getElementById('layoutSelect');
const recordIdInput = document.getElementById('recordIdInput');
const loadButton = document.getElementById('loadButton');
const validateButton = document.getElementById('validateButton');
const previewButton = document.getElementById('previewButton');
const saveButton = document.getElementById('saveButton');
const createButton = document.getElementById('createButton');
const recordIdRow = document.getElementById('recordIdRow');
const discardButton = document.getElementById('discardButton');
const exportButton = document.getElementById('exportButton');
const statusEl = document.getElementById('status');
const hiddenNote = document.getElementById('hiddenNote');
const conflictBanner = document.getElementById('conflictBanner');
const conflictText = document.getElementById('conflictText');
const reloadAfterConflictButton = document.getElementById('reloadAfterConflictButton');
const fieldEditor = document.getElementById('fieldEditor');
const patchPreview = document.getElementById('patchPreview');
const rawRecord = document.getElementById('rawRecord');
const fieldInputs = new Map();
const recordEditorPanel = fieldEditor.closest('.panel');
const recordEditorHeading = recordEditorPanel ? recordEditorPanel.querySelector('h2') : null;
const recordEditorContent = recordEditorPanel
  ? Array.from(recordEditorPanel.children).filter((element) => element.tagName !== 'H2')
  : [fieldEditor, patchPreview, rawRecord];
const recordEditorSkeleton = createLoadingSkeleton(['short', 'long', 'medium', 'long']);
const debouncedMarkDirtyState = debounce(markDirtyState, 200);
let recordEditorReady = false;

if (recordEditorPanel) {
  if (recordEditorHeading) {
    recordEditorHeading.insertAdjacentElement('afterend', recordEditorSkeleton);
  } else {
    recordEditorPanel.prepend(recordEditorSkeleton);
  }

  setElementsVisible(recordEditorContent, false);
}

window.addEventListener('message', (event) => {
  if (event.origin !== window.location.origin) { return; }
  const message = event.data;
  if (!message || typeof message.type !== 'string') {
    return;
  }

  if (['recordLoaded', 'recordSaved', 'recordCreated', 'saveCancelled', 'saveConflict', 'error'].includes(message.type)) setBusy(false);
  switch (message.type) {
    case 'init':
      applyInit(message.payload);
      break;
    case 'layoutsLoaded':
      applyLayouts(message.payload);
      break;
    case 'recordLoaded':
      applyRecord(message.payload);
      revealRecordEditor();
      break;
    case 'draftValidated':
      applyValidation(message.payload);
      break;
    case 'patchPreview':
      applyPatchPreview(message.payload);
      break;
    case 'recordSaved':
      applySaved(message.payload);
      break;
    case 'layoutFields':
      applyLayoutFields(message.payload);
      break;
    case 'recordCreated':
      applyCreated(message.payload);
      break;
    case 'saveCancelled':
      setStatus('Save cancelled.');
      break;
    case 'saveConflict':
      showConflict(message.payload);
      break;
    case 'error':
      setStatus(message.message || 'Unknown error.', true);
      break;
    default:
      break;
  }
});

layoutSelect.addEventListener('change', () => {
  hideConflict();
  requestCreateFields();
});

profileSelect.addEventListener('change', () => {
  hideConflict();
  loadLayouts(profileSelect.value);
});

loadButton.addEventListener('click', () => {
  if (state.busy) return;
  const payload = collectBasePayload();
  if (!payload) {
    return;
  }

  setBusy(true);
  vscode.postMessage({ type: 'loadRecord', payload });
  setStatus('Loading record...');
});

validateButton.addEventListener('click', () => {
  const payload = collectDraftPayload();
  if (!payload) {
    return;
  }

  vscode.postMessage({ type: 'validateDraft', payload });
});

previewButton.addEventListener('click', () => {
  const payload = collectDraftPayload();
  if (!payload) {
    return;
  }

  vscode.postMessage({ type: 'previewPatch', payload });
});

saveButton.addEventListener('click', () => {
  if (state.busy) return;
  const payload = collectDraftPayload();
  if (!payload) {
    return;
  }

  debouncedMarkDirtyState.cancel();
  setBusy(true);
  vscode.postMessage({ type: 'saveRecord', payload });
  setStatus('Saving...');
});

discardButton.addEventListener('click', () => {
  if (!state.loaded) {
    return;
  }

  debouncedMarkDirtyState.cancel();
  state.draftFieldData = { ...state.originalFieldData };
  renderFieldEditor();
  setStatus('Draft changes discarded.');
});

exportButton.addEventListener('click', () => {
  vscode.postMessage({ type: 'exportRecord' });
});

createButton.addEventListener('click', () => {
  if (state.busy) return;
  const profileId = profileSelect.value;
  const layout = layoutSelect.value;
  if (!profileId || !layout) {
    setStatus('Profile and layout are required.', true);
    return;
  }

  const fieldData = Object.create(null);
  for (const [name, value] of Object.entries(state.draftFieldData)) {
    if (!readOnlyNote(name) && value !== '' && value !== undefined && value !== null) {
      fieldData[name] = value;
    }
  }
  if (Object.keys(fieldData).length === 0) {
    setStatus('Enter a value in at least one field to create a record.', true);
    return;
  }

  debouncedMarkDirtyState.cancel();
  setBusy(true);
  vscode.postMessage({ type: 'createRecord', payload: { profileId, layout, fieldData } });
  setStatus('Creating record...');
});


// "Copy request for this record": the two selects pick the request and the format, the host builds it.
const copyRecordMenu = document.getElementById('copyRecordMenu');
const copyOperationSelect = document.getElementById('copyOperationSelect');
const copyFormatSelect = document.getElementById('copyFormatSelect');

function postRecordRequest(destination) {
  const payload = collectDraftPayload();
  if (!payload) {
    return;
  }

  vscode.postMessage({
    type: 'copyRecordRequest',
    payload: {
      profileId: payload.profileId,
      layout: payload.layout,
      recordId: payload.recordId,
      draftFieldData: payload.draftFieldData,
      operation: copyOperationSelect.value,
      format: destination === 'editor' ? 'http' : copyFormatSelect.value,
      destination
    }
  });
}

document.getElementById('copyRecordButton').addEventListener('click', () => postRecordRequest('clipboard'));
document.getElementById('saveRecordHttpButton').addEventListener('click', () => postRecordRequest('editor'));

// The menu closes after a choice, on outside click, and on Escape.
copyRecordMenu.addEventListener('click', (event) => {
  if (event.target instanceof HTMLButtonElement && event.target.closest('.menu-items')) {
    copyRecordMenu.open = false;
  }
});
window.addEventListener('click', (event) => {
  if (!(event.target instanceof Element) || !event.target.closest('details.menu')) {
    copyRecordMenu.open = false;
  }
});
window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && copyRecordMenu.open) {
    copyRecordMenu.open = false;
    copyRecordMenu.querySelector('summary').focus();
  }
});

function applyMode() {
  const creating = state.mode === 'create';
  recordIdRow.classList.toggle('hidden', creating);
  createButton.classList.toggle('hidden', !creating);
  for (const button of [loadButton, previewButton, saveButton, discardButton, exportButton, copyRecordMenu]) {
    button.classList.toggle('hidden', creating);
  }
  if (recordEditorHeading) {
    recordEditorHeading.textContent = creating ? 'New Record' : 'Field Data';
  }
  // The patch preview and raw JSON belong to editing an existing record.
  patchPreview.parentElement.querySelectorAll('h3, pre').forEach((element) => element.classList.toggle('hidden', creating));
  if (creating) {
    // Nothing to load: show the (empty) form straight away.
    revealRecordEditor();
  }
}

function requestCreateFields() {
  if (state.mode !== 'create' || !profileSelect.value || !layoutSelect.value) {
    return;
  }

  vscode.postMessage({
    type: 'loadLayoutFields',
    payload: { profileId: profileSelect.value, layout: layoutSelect.value }
  });
  setStatus('Loading fields...');
}

function applyLayoutFields(payload) {
  if (state.mode !== 'create' || !payload || !Array.isArray(payload.fields)) {
    return;
  }
  if (payload.profileId !== profileSelect.value || payload.layout !== layoutSelect.value) {
    return;
  }

  showDuplicateFieldNote(payload.fields);
  state.fields = payload.fields || [];
  fieldInputs.clear();
  state.presentationFields = payload.presentationFields || payload.fields || [];
  state.originalFieldData = Object.create(null);
  state.draftFieldData = Object.create(null);
  for (const field of payload.fields) {
    if (field && typeof field.name === 'string') {
      state.draftFieldData[field.name] = '';
    }
  }
  fieldInputs.clear();
  renderFieldEditor();
  setStatus(
    payload.metadataSupported
      ? `Enter values for the new record, then click Create Record (${payload.fields.length} fields).`
      : (payload.message || 'Field list is unavailable for this layout.'),
    !payload.metadataSupported
  );
}

function showDuplicateFieldNote(fields) {
  const note = document.getElementById('duplicateFieldNote');
  const seen = new Set();
  const duplicates = new Set();
  for (const field of Array.isArray(fields) ? fields : []) {
    if (!field || typeof field.name !== 'string') continue;
    if (seen.has(field.name)) duplicates.add(field.name);
    seen.add(field.name);
  }
  note.textContent = duplicates.size ? `Repeated fields are shown once: ${Array.from(duplicates).join(', ')}. Each name has one value in a record.` : '';
  note.classList.toggle('hidden', duplicates.size === 0);
}

function applyCreated(payload) {
  if (!payload) {
    return;
  }

  // Start the next record from an empty form and show the id of the one just created.
  for (const name of Object.keys(state.draftFieldData)) {
    state.draftFieldData[name] = '';
  }
  renderFieldEditor();
  setStatus(`Record created on ${payload.layout}: record ID ${payload.recordId}${payload.modId ? ` (modId ${payload.modId})` : ''}.`);
}

function applyInit(payload) {
  state.profiles = Array.isArray(payload.profiles) ? payload.profiles : [];
  state.activeProfileId = payload.activeProfileId;
  state.defaults = payload.defaults;
  state.mode = payload.defaults && payload.defaults.mode === 'create' ? 'create' : 'edit';
  applyMode();

  renderProfiles();
  setStatus('Ready.');
}

function applyLayouts(payload) {
  if (!payload || typeof payload.profileId !== 'string' || !Array.isArray(payload.layouts)) {
    return;
  }

  state.layoutsByProfile.set(payload.profileId, payload.layouts);
  if (profileSelect.value === payload.profileId) {
    const wanted = state.defaults && state.defaults.layout;
    const autoLoad = state.mode === 'edit' && state.defaults && state.defaults.recordId;
    renderLayouts(payload.layouts, wanted);
    state.defaults = undefined;
    if (autoLoad && wanted && layoutSelect.value === wanted) loadButton.click();
  }
}

function applyRecord(payload) {
  if (!payload || !payload.record || !payload.record.fieldData) {
    return;
  }

  debouncedMarkDirtyState.cancel();
  hideConflict();
  state.loaded = payload;
  showDuplicateFieldNote(payload.fields);
  state.fields = payload.fields || [];
  fieldInputs.clear();
  state.presentationFields = payload.presentationFields || payload.fields || [];
  state.originalFieldData = clone(payload.record.fieldData);
  state.draftFieldData = clone(payload.record.fieldData);

  rawRecord.textContent = JSON.stringify(payload.record, null, 2);
  patchPreview.textContent = '';
  renderFieldEditor();
  showHiddenFieldNote(payload);
  setStatus(`Loaded record ${payload.record.recordId}.${payload.metadataSupported === false || !state.fields.length ? ' Read-only fields cannot be identified because the field list is unavailable. Check the field types before saving.' : ''}`);
}

/**
 * Fields the account cannot see are simply not in the answer. Say so, and name the fields the layout
 * lists that this record has no value for (the only ones the page can know about).
 */
function showHiddenFieldNote(payload) {
  if (!hiddenNote) {
    return;
  }
  const present = new Set(Object.keys(payload.record.fieldData));
  const listed = Array.isArray(payload.fields) ? payload.fields.map((field) => field && field.name).filter((name) => typeof name === 'string') : [];
  const missing = listed.filter((name) => !present.has(name));
  if (missing.length === 0) {
    // Nothing is missing, so there is nothing to explain.
    hiddenNote.textContent = '';
    hiddenNote.classList.add('hidden');
    return;
  }
  const names = missing.slice(0, 5).join(', ') + (missing.length > 5 ? `, and ${missing.length - 5} more` : '');
  // textContent, never innerHTML: a field name is text from the database.
  hiddenNote.textContent = `${missing.length} field${missing.length === 1 ? '' : 's'} on this layout ${missing.length === 1 ? 'is' : 'are'} not shown (hidden by your account or its privileges): ${names}. Fields your account has no access to are not shown here.`;
  hiddenNote.classList.remove('hidden');
}

function applyValidation(payload) {
  if (!payload) {
    return;
  }

  if (payload.valid) {
    setStatus('Draft is valid.');
    return;
  }

  const details = Array.isArray(payload.errors)
    ? payload.errors.map((item) => `${item.field}: ${item.message}`).join(' | ')
    : 'Validation failed.';
  setStatus(details, true);
}

function applyPatchPreview(payload) {
  patchPreview.textContent = JSON.stringify(payload, null, 2);
  const count = payload && Array.isArray(payload.changedFields) ? payload.changedFields.length : 0;
  setStatus(`Patch preview ready (${count} changed field${count === 1 ? '' : 's'}).`);
}

function applySaved(payload) {
  if (!payload || !payload.record || !payload.record.fieldData) {
    return;
  }

  hideConflict();
  debouncedMarkDirtyState.cancel();
  state.originalFieldData = clone(payload.record.fieldData);
  state.draftFieldData = clone(payload.record.fieldData);
  rawRecord.textContent = JSON.stringify(payload.record, null, 2);
  patchPreview.textContent = '';
  renderFieldEditor();
  revealRecordEditor();
  setStatus('Record saved.');
}

function showConflict(payload) {
  const recordId = payload && payload.recordId ? payload.recordId : recordIdInput.value.trim();
  const others = payload && Array.isArray(payload.changedByOthers) ? payload.changedByOthers : [];
  const overlap = payload && Array.isArray(payload.overlap) ? payload.overlap : [];

  let text = `Not saved: record ${recordId} was changed by someone else after you opened it.`;
  if (others.length > 0) {
    text += ` Fields changed since: ${others.join(', ')}.`;
  }
  if (overlap.length > 0) {
    text += ` You both edited: ${overlap.join(', ')}.`;
  }
  text += ' Your edits are still in the form. Reload to see the current values, then redo your changes.';

  conflictText.textContent = text;
  conflictBanner.classList.remove('hidden');
  setStatus('Save blocked: the record changed since you loaded it.', true);
  reloadAfterConflictButton.focus();
}

function hideConflict() {
  conflictBanner.classList.add('hidden');
  conflictText.textContent = '';
}

reloadAfterConflictButton.addEventListener('click', () => {
  hideConflict();
  loadButton.click();
});

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

function setElementsVisible(elements, isVisible) {
  elements.forEach((element) => {
    element.style.display = isVisible ? '' : 'none';
  });

  recordEditorSkeleton.classList.toggle('hidden', isVisible);
}

function revealRecordEditor() {
  if (recordEditorReady) {
    return;
  }

  recordEditorReady = true;
  setElementsVisible(recordEditorContent, true);
}

function renderProfiles() {
  profileSelect.innerHTML = '';

  if (!state.profiles.length) {
    const option = document.createElement('option');
    option.value = '';
    option.textContent = 'No profiles';
    profileSelect.appendChild(option);
    return;
  }

  for (const profile of state.profiles) {
    const option = document.createElement('option');
    option.value = profile.id;
    option.textContent = `${profile.name} (${profile.database})`;
    profileSelect.appendChild(option);
  }

  const selected =
    (state.defaults && state.defaults.profileId) || state.activeProfileId || state.profiles[0].id;
  profileSelect.value = selected;
  if (state.defaults && state.defaults.recordId) {
    recordIdInput.value = state.defaults.recordId;
  }
  loadLayouts(selected);
}

function renderLayouts(layouts, preferredLayout) {
  layoutSelect.innerHTML = '';

  if (!Array.isArray(layouts) || !layouts.length) {
    const option = document.createElement('option');
    option.value = '';
    option.textContent = 'No layouts';
    layoutSelect.appendChild(option);
    return;
  }

  for (const layout of layouts) {
    const option = document.createElement('option');
    option.value = layout;
    option.textContent = layout;
    option.title = layout; // the full name, since a long one is clipped in the list
    layoutSelect.appendChild(option);
  }

  if (preferredLayout && layouts.includes(preferredLayout)) {
    layoutSelect.value = preferredLayout;
  } else {
    layoutSelect.value = layouts[0];
  }
  requestCreateFields();
}

function loadLayouts(profileId) {
  const cached = state.layoutsByProfile.get(profileId);
  if (cached) {
    applyLayouts({ profileId, layouts: cached });
    return;
  }

  vscode.postMessage({
    type: 'loadLayouts',
    profileId
  });
}

function renderFieldEditor() {
  const keys = typeof FieldStandards !== 'undefined'
    ? FieldStandards.orderFields({ fields: state.presentationFields }, state.draftFieldData) : Object.keys(state.draftFieldData);
  if (!keys.length) {
    showEmptyFieldEditor();
    return;
  }

  buildFieldEditor(keys);
}

function showEmptyFieldEditor() {
  fieldInputs.clear();
  const empty = document.createElement('p');
  empty.className = 'empty';
  empty.textContent = 'No fieldData available.';
  fieldEditor.replaceChildren(empty);
}

function buildFieldEditor(keys) {
  fieldInputs.clear();

  const wrapper = document.createElement('div');
  wrapper.className = 'table-scroll-wrapper';

  const table = document.createElement('table');
  if (typeof FieldStandards !== 'undefined') table.className = 'fm-field-table';
  const thead = document.createElement('thead');
  thead.className = 'visually-hidden';
  const headerRow = document.createElement('tr');
  const fieldHeader = document.createElement('th');
  fieldHeader.textContent = 'Field';
  headerRow.appendChild(fieldHeader);

  const valueHeader = document.createElement('th');
  valueHeader.textContent = 'Value';
  headerRow.appendChild(valueHeader);
  thead.appendChild(headerRow);
  table.appendChild(thead);

  const tbody = document.createElement('tbody');
  if (typeof FieldStandards !== 'undefined') tbody.className = 'fm-fields';
  for (const key of keys) {
    const tr = document.createElement('tr');
    if (typeof FieldStandards !== 'undefined') tr.className = 'fm-field';
    if (typeof FieldStandards !== 'undefined') FieldStandards.applyStandardField(tr, fieldPresentation(key));

    const labelCell = document.createElement('td');
    if (typeof FieldStandards !== 'undefined') labelCell.className = 'fm-field-label';
    labelCell.id = `record-field-label-${fieldInputs.size}`;
    labelCell.textContent = key;
    tr.appendChild(labelCell);

    const inputCell = document.createElement('td');
    const note = readOnlyNote(key);
    const change = (value) => {
      if (readOnlyNote(key)) return;
      state.draftFieldData[key] = parseEditableValue(value, key);
      debouncedMarkDirtyState();
    };
    const input = typeof FieldStandards !== 'undefined'
      ? FieldStandards.createStandardControl(document, fieldPresentation(key), toEditableValue(state.draftFieldData[key]), change, Boolean(note))
      : document.createElement('textarea');
    input.id = `record-field-${fieldInputs.size}`;
    input.classList.add('fm-field-control');
    input.setAttribute('aria-label', key);
    input.setAttribute('aria-labelledby', labelCell.id);
    if (typeof FieldStandards === 'undefined') {
      input.value = toEditableValue(state.draftFieldData[key]);
      input.readOnly = Boolean(note);
      input.addEventListener('input', () => change(input.value));
    }
    fieldInputs.set(key, input);
    inputCell.appendChild(input);
    const noteText = note || (isGlobalField(metadataForField(state.fields, key)) ? 'Session-wide: changes apply throughout this session.' : '');
    if (noteText) {
      const help = document.createElement('p');
      help.id = `${input.id}-note`;
      help.textContent = noteText;
      input.setAttribute('aria-describedby', help.id);
      inputCell.appendChild(help);
    }
    tr.appendChild(inputCell);
    tbody.appendChild(tr);
  }

  table.appendChild(tbody);
  wrapper.appendChild(table);
  fieldEditor.replaceChildren(wrapper);
}

function metadataForField(fields, name) {
  return fields.find((field) => field.name === name) || fields.find((field) => field.name === name.replace(/\(\d+\)$/, '')) || {};
}

function normalizedType(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function isGlobalField(metadata) {
  return metadata.global === true || normalizedType(metadata.global) === 'true' || normalizedType(metadata.type) === 'global';
}

function readOnlyNote(name) {
  const metadata = metadataForField(state.fields, name);
  if (normalizedType(metadata.type) === 'calculation') return 'Calculated by FileMaker; cannot be edited';
  if (normalizedType(metadata.type) === 'summary') return 'Summary field; cannot be edited';
  if (normalizedType(metadata.result) === 'container' || normalizedType(metadata.type) === 'container') return 'Use Upload to container';
  return '';
}

function editableFields(values) {
  return Object.fromEntries(Object.entries(values).filter(([name]) => !readOnlyNote(name)));
}

function fieldPresentation(name) {
  const metadata = metadataForField(state.presentationFields, name);
  return { ...metadata, name, type: metadata.result || metadata.type, value: toEditableValue(state.draftFieldData[name]) };
}


function markDirtyState() {
  const changed = JSON.stringify(state.originalFieldData) !== JSON.stringify(state.draftFieldData);
  if (changed) {
    setStatus('Draft has unsaved changes.');
  }
}

function collectBasePayload() {
  const profileId = profileSelect.value;
  const layout = layoutSelect.value;
  // A new record has no id yet; the host ignores it when validating a draft.
  const recordId = state.mode === 'create' ? '(new)' : recordIdInput.value.trim();

  if (!profileId || !layout || !recordId) {
    setStatus('Profile, layout, and record ID are required.', true);
    return undefined;
  }

  return { profileId, layout, recordId };
}

function collectDraftPayload() {
  const base = collectBasePayload();
  if (!base) {
    return undefined;
  }

  return {
    ...base,
    originalFieldData: editableFields(state.originalFieldData),
    draftFieldData: editableFields(state.draftFieldData)
  };
}

function toEditableValue(value) {
  if (typeof value === 'string') {
    return value;
  }

  return JSON.stringify(value);
}

function parseEditableValue(value, name) {
  const metadata = metadataForField(state.presentationFields, name);
  if (normalizedType(metadata.result || metadata.type) !== 'number') return value;
  // Keep this decimal check in step with utils/numericText.ts (covered by parity tests).
  const match = /^[-+]?(\d+\.?\d*|\.\d+)(?:[eE]([-+]?\d+))?$/.exec(value);
  if (!match) return value;
  const number = Number(value);
  if (!Number.isFinite(number)) return value;
  const mantissa = match[1];
  const digits = mantissa.replace('.', '').replace(/^0+/, '');
  if (!digits) return number;
  if (number === 0) return value;
  const places = digits.length + Number(match[2] || 0) - (mantissa.split('.')[1]?.length || 0);
  if (places < 16) return number;
  if (places > 16) return value;
  const integer = digits.slice(0, places).padEnd(places, '0');
  if (integer < '9007199254740991') return number;
  if (integer === '9007199254740991' && /^0*$/.test(digits.slice(places))) return number;
  return value;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function setStatus(message, isError = false) {
  statusEl.textContent = message;
  statusEl.classList.toggle('error', isError);
}

vscode.postMessage({ type: 'ready' });

function setBusy(busy) {
  state.busy = busy;
  for (const button of [loadButton, saveButton, createButton, discardButton, profileSelect, layoutSelect]) button.disabled = busy;
}
