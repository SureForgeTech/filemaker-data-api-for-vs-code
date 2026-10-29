const vscode = acquireVsCodeApi();
const FindForm = window.FindForm;

const DEFAULT_LIMIT = 100;
const VIRTUALIZE_THRESHOLD = 50;
const MAX_COLUMNS = 60;
const MAX_CLIPBOARD_TEXT_LENGTH = 5_000_000;
const STATE_VERSION = 1;
const US_DATE_PATTERN = /^\d{1,2}\/\d{1,2}\/\d{4}(?: \d{1,2}:\d{2}(?::\d{2})?)?$/;

const state = {
  profiles: [],
  activeProfileId: undefined,
  layoutsByProfile: new Map(),
  pendingLayoutByProfile: new Map(),
  savedQueries: [],
  currentPayload: undefined,
  currentQueryId: undefined,
  currentQueryName: '',
  lastResult: undefined,
  defaults: undefined,
  history: [],
  editorMode: 'form',
  model: FindForm.createEmptyModel(),
  restoredProfileId: undefined,
  restoredLayout: undefined,
  restoredCriteriaLayout: undefined,
  fieldNames: [],
  fieldMetadata: [],
  resultSort: undefined,
  resultView: 'table',
  running: false,
  latestRunId: 0,
  recordEditEnabled: true
};

const profileSelect = document.getElementById('profileSelect');
const layoutSelect = document.getElementById('layoutSelect');
const formTab = document.getElementById('formTab');
const jsonTab = document.getElementById('jsonTab');
const formEditor = document.getElementById('formEditor');
const jsonEditor = document.getElementById('jsonEditor');
const fieldNameOptions = document.getElementById('fieldNameOptions');
const fieldNamesHint = document.getElementById('fieldNamesHint');
const requestList = document.getElementById('requestList');
const addRequestButton = document.getElementById('addRequestButton');
const sortList = document.getElementById('sortList');
const addSortButton = document.getElementById('addSortButton');
const findJson = document.getElementById('findJson');
const sortJson = document.getElementById('sortJson');
const limitInput = document.getElementById('limitInput');
const offsetInput = document.getElementById('offsetInput');
const includeAuthCheckbox = document.getElementById('includeAuthCheckbox');
const runButton = document.getElementById('runButton');
const cancelButton = document.getElementById('cancelButton');
const listRecordsButton = document.getElementById('listRecordsButton');
const saveButton = document.getElementById('saveButton');
const exportEditorButton = document.getElementById('exportEditorButton');
const exportJsonButton = document.getElementById('exportJsonButton');
const exportCsvButton = document.getElementById('exportCsvButton');
const copyTableButton = document.getElementById('copyTableButton');
const uploadContainerButton = document.getElementById('uploadContainerButton');
const savedQueriesSelect = document.getElementById('savedQueriesSelect');
const loadSavedButton = document.getElementById('loadSavedButton');
const prevButton = document.getElementById('prevButton');
const nextButton = document.getElementById('nextButton');
const tableViewTab = document.getElementById('tableViewTab');
const rawViewTab = document.getElementById('rawViewTab');
const status = document.getElementById('status');
const resultSummary = document.getElementById('resultSummary');
const tableContainer = document.getElementById('tableContainer');
const rawContainer = document.getElementById('rawContainer');
const historyContainer = document.getElementById('historyContainer');
const menus = Array.from(document.querySelectorAll('details.menu'));
const queryBuilderPanels = Array.from(document.querySelectorAll('.panel'));
const queryBuilderSkeleton = createLoadingSkeleton(['short', 'long', 'medium', 'long', 'medium']);
let queryBuilderReady = false;
// True while the panel is putting back a stored snapshot, so it does not write one back half-restored.
let restoringState = false;
// True between a profile switch (or saved-query load) and the moment its layouts are on
// screen; persistState stays quiet through that gap so no mixed snapshot is stored.
let profileSwitchPending = false;

const queryBuilderHeader = document.querySelector('.header');
if (queryBuilderHeader && queryBuilderPanels.length > 0) {
  queryBuilderHeader.insertAdjacentElement('afterend', queryBuilderSkeleton);
  setElementsVisible(queryBuilderPanels, false);
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
      revealQueryBuilder();
      break;
    case 'layoutsLoaded':
      applyLayouts(message.payload);
      requestFieldNamesForCurrentLayout();
      break;
    case 'fieldNamesLoaded':
      applyFieldNames(message.payload);
      break;
    case 'queryResult':
      if (isCurrentRun(message.payload && message.payload.query ? message.payload.query.runId : undefined)) {
        renderQueryResult(message.payload);
      }
      break;
    case 'runCancelled':
      if (isCurrentRun(message.runId)) {
        // The results already on screen stay: the run was stopped, not undone.
        setRunning(false);
        setStatus('Query cancelled.');
      }
      break;
    case 'savedQueries':
      state.savedQueries = Array.isArray(message.payload) ? message.payload : [];
      renderSavedQueries();
      break;
    case 'querySaveFinished':
      setQuerySaving(false);
      break;
    case 'querySaved':
      setQuerySaving(false);
      if (message.payload && typeof message.payload.id === 'string') {
        state.currentQueryId = message.payload.id;
        state.currentQueryName = String(message.payload.name || '');
        savedQueriesSelect.value = message.payload.id;
        setStatus(`Saved query "${state.currentQueryName}".`);
      }
      break;
    case 'history':
      state.history = Array.isArray(message.payload) ? message.payload : [];
      renderHistory();
      break;
    case 'saveCurrentQuery':
      saveButton.click();
      break;
    case 'containerUploadResult':
      setStatus(
        message.payload && message.payload.completed
          ? 'Container upload completed.'
          : 'Container upload cancelled.'
      );
      break;
    case 'error':
      if (typeof message.runId === 'number') {
        if (message.runId !== state.latestRunId) {
          break; // a superseded run failed; the current one is still going
        }
        state.lastResult = undefined;
        renderResultView();
        setRunning(false);
      }
      setQuerySaving(false);
      setStatus(message.message || 'Unknown error.', true, /Find criteria are empty\./i.test(message.message || ''));
      break;
    default:
      break;
  }
});

// ---------------------------------------------------------------------------
// Source selection
// ---------------------------------------------------------------------------

profileSelect.addEventListener('change', () => {
  // The new profile's layouts arrive asynchronously: mark the gap so nothing typed in
  // between stores a snapshot pairing the new profile with the old profile's layout.
  // renderLayouts clears the flag and stores the settled pair once the layouts are on screen.
  profileSwitchPending = true;
  requestLayouts(profileSelect.value);
});

layoutSelect.addEventListener('change', () => {
  requestFieldNamesForCurrentLayout();
  persistState();
});

loadSavedButton.addEventListener('click', () => {
  const selected = state.savedQueries.find((item) => item.id === savedQueriesSelect.value);
  if (!selected) {
    setStatus('Choose a saved query to load.', true);
    return;
  }

  applySavedQuery(selected);
  setStatus(`Loaded saved query "${selected.name}".`);
});

// ---------------------------------------------------------------------------
// Editor tabs
// ---------------------------------------------------------------------------

formTab.addEventListener('click', () => switchEditorMode('form'));
jsonTab.addEventListener('click', () => switchEditorMode('json'));
[formTab, jsonTab].forEach((tab) => tab.addEventListener('keydown', handleTabArrowKeys));

function switchEditorMode(mode) {
  if (mode === state.editorMode) {
    return;
  }

  if (mode === 'json') {
    writeModelToJson();
  } else {
    const parsed = FindForm.jsonToModel(findJson.value, sortJson.value);
    if (!parsed.ok) {
      setStatus(`${parsed.reason} Keep editing it as JSON, or fix it to use the form.`, true);
      return;
    }
    state.model = parsed.model;
    renderForm();
  }

  setEditorMode(mode);
}

function setEditorMode(mode) {
  state.editorMode = mode;
  const isForm = mode === 'form';
  formTab.setAttribute('aria-selected', String(isForm));
  jsonTab.setAttribute('aria-selected', String(!isForm));
  formTab.tabIndex = isForm ? 0 : -1;
  jsonTab.tabIndex = isForm ? -1 : 0;
  formEditor.classList.toggle('hidden', !isForm);
  jsonEditor.classList.toggle('hidden', isForm);
  persistState();
}

function handleTabArrowKeys(event) {
  if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') {
    return;
  }
  const tabs = Array.from(event.currentTarget.parentElement.querySelectorAll('[role="tab"]'));
  const index = tabs.indexOf(event.currentTarget);
  const next = tabs[(index + (event.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
  next.click();
  // A refused switch (JSON the form can't show) leaves focus on the selected tab.
  const selected = tabs.find((tab) => tab.getAttribute('aria-selected') === 'true');
  if (selected) {
    selected.focus();
  }
}

function writeModelToJson() {
  findJson.value = JSON.stringify(FindForm.modelToFindQuery(state.model), null, 2);
  const sort = FindForm.modelToSort(state.model);
  sortJson.value = sort.length > 0 ? JSON.stringify(sort, null, 2) : '';
}

// ---------------------------------------------------------------------------
// Form editor
// ---------------------------------------------------------------------------

addRequestButton.addEventListener('click', () => {
  state.model.requests.push(FindForm.createEmptyRequest());
  renderForm();
  focusLast(requestList, '.criterion-field');
});

addSortButton.addEventListener('click', () => {
  state.model.sort.push({ fieldName: '', sortOrder: 'ascend' });
  renderForm();
  focusLast(sortList, '.sort-field');
});

function renderForm() {
  requestList.replaceChildren(
    ...state.model.requests.map((request, requestIndex) => renderRequest(request, requestIndex))
  );
  sortList.replaceChildren(...state.model.sort.map((item, sortIndex) => renderSortRow(item, sortIndex)));
}

function renderRequest(request, requestIndex) {
  const card = document.createElement('fieldset');
  card.className = 'request-card';

  const legend = document.createElement('legend');
  legend.textContent =
    state.model.requests.length > 1
      ? `${requestIndex === 0 ? 'Find' : 'Or find'} records where`
      : 'Find records where';
  card.appendChild(legend);

  request.criteria.forEach((criterion, criterionIndex) => {
    card.appendChild(renderCriterion(request, criterion, requestIndex, criterionIndex));
  });

  const footer = document.createElement('div');
  footer.className = 'request-footer';

  footer.appendChild(
    makeButton('Add criterion', 'secondary small', () => {
      request.criteria.push({ field: '', operator: 'match', value: '', value2: '' });
      renderForm();
      focusLast(requestList.children[requestIndex], '.criterion-field');
    })
  );

  const omitLabel = document.createElement('label');
  omitLabel.className = 'toggle';
  const omit = document.createElement('input');
  omit.type = 'checkbox';
  omit.checked = request.omit === true;
  omit.addEventListener('change', () => {
    request.omit = omit.checked;
  });
  omitLabel.append(omit, document.createTextNode(' Omit these records'));
  footer.appendChild(omitLabel);

  if (state.model.requests.length > 1) {
    footer.appendChild(
      makeButton('Remove request', 'link danger', () => {
        state.model.requests.splice(requestIndex, 1);
        renderForm();
        const neighbour = requestList.children[Math.min(requestIndex, requestList.children.length - 1)];
        focusFirst(neighbour, '.criterion-field');
      })
    );
  }

  card.appendChild(footer);
  return card;
}

function renderCriterion(request, criterion, requestIndex, criterionIndex) {
  const row = document.createElement('div');
  row.className = typeof FieldStandards !== 'undefined' ? 'criterion-row fm-fields' : 'criterion-row';
  const idPrefix = `req${requestIndex}-crit${criterionIndex}`;

  const field = document.createElement('input');
  field.className = 'criterion-field';
  field.setAttribute('list', 'fieldNameOptions');
  field.placeholder = 'Field name';
  field.value = criterion.field;
  field.setAttribute('aria-label', 'Field');
  field.id = `${idPrefix}-field`;
  field.addEventListener('input', () => {
    criterion.field = field.value;
    sizeValues();
  });

  const operator = document.createElement('select');
  operator.className = 'criterion-operator';
  operator.setAttribute('aria-label', 'Condition');
  FindForm.OPERATORS.forEach((option) => {
    const element = document.createElement('option');
    element.value = option.id;
    element.textContent = option.label;
    operator.appendChild(element);
  });
  operator.value = criterion.operator;
  operator.addEventListener('change', () => {
    criterion.operator = operator.value;
    renderForm();
    const refreshed = requestList.children[requestIndex];
    const select = refreshed && refreshed.querySelectorAll('.criterion-operator')[criterionIndex];
    if (select) {
      select.focus();
    }
  });

  row.append(labelControl(field, 'Field'), labelControl(operator, 'Condition'));
  function sizeValues() {
    row.querySelectorAll('.criterion-value').forEach((input) => replaceValueControl(input, criterion.field));
  }

  const definition = FindForm.getOperator(criterion.operator);
  if (definition.needsValue) {
    row.appendChild(
      makeValueInput(criterion.value, definition.needsSecondValue ? 'From' : 'Value', (value) => {
        criterion.value = value;
      })
    );
  }
  if (definition.needsSecondValue) {
    row.appendChild(
      makeValueInput(criterion.value2, 'To', (value) => {
        criterion.value2 = value;
      })
    );
  }

  const removeButton = makeButton('Remove', 'icon', () => {
    request.criteria.splice(criterionIndex, 1);
    if (request.criteria.length === 0) {
      request.criteria.push({ field: '', operator: 'match', value: '', value2: '' });
    }
    renderForm();
    const fields = requestList.children[requestIndex]
      ? requestList.children[requestIndex].querySelectorAll('.criterion-field')
      : [];
    const target = fields[Math.min(criterionIndex, fields.length - 1)];
    if (target) {
      target.focus();
    }
  });
  removeButton.textContent = '×';
  removeButton.setAttribute('aria-label', 'Remove criterion');
  removeButton.title = 'Remove criterion';
  row.appendChild(removeButton);
  sizeValues();

  return row;
}

function makeValueInput(value, label, onInput) {
  const input = document.createElement('input');
  input.className = 'criterion-value';
  input.placeholder = label;
  input.setAttribute('aria-label', label);
  input.value = value || '';
  input.valueChanged = onInput;
  input.addEventListener('input', () => onInput(input.value));
  return labelControl(input, label);
}

// Find values use the same boxes, but remain searchable even for calculated fields.
function replaceValueControl(input, fieldName) {
  if (typeof FieldStandards === 'undefined') return;
  const metadata = state.fieldMetadata.find((entry) => entry.name === fieldName)
    || state.fieldMetadata.find((entry) => entry.name === fieldName.replace(/\(\d+\)$/, '')) || {};
  const value = input.value || '';
  // A find value is plain text, so FileMaker's own syntax (=x, >5, *) can be typed into it.
  const field = { ...metadata, kind: 'normal', type: metadata.type === 'container' ? 'text' : metadata.type, value, freeText: true };
  const control = FieldStandards.createStandardControl(document, field, value, (next) => {
    control.value = next;
    input.valueChanged(next);
  });
  control.classList.add('criterion-value');
  control.value = value;
  control.valueChanged = input.valueChanged;
  control.setAttribute('aria-label', input.getAttribute('aria-label'));
  FieldStandards.applyStandardField(input.parentElement, field);
  input.replaceWith(control);
}

function labelControl(control, text) {
  if (typeof FieldStandards === 'undefined') return control;
  const wrapper = document.createElement('div');
  wrapper.className = 'fm-field';
  const label = document.createElement('span');
  label.className = 'fm-field-label';
  label.textContent = text;
  control.classList.add('fm-field-control');
  wrapper.append(label, control);
  if (typeof FieldStandards !== 'undefined') FieldStandards.applyStandardField(wrapper);
  return wrapper;
}

function renderSortRow(item, sortIndex) {
  const row = document.createElement('div');
  row.className = 'criterion-row';

  const field = document.createElement('input');
  field.className = 'sort-field';
  field.setAttribute('list', 'fieldNameOptions');
  field.placeholder = 'Field name';
  field.setAttribute('aria-label', 'Sort field');
  field.value = item.fieldName;
  field.addEventListener('input', () => {
    item.fieldName = field.value;
  });

  const order = document.createElement('select');
  order.setAttribute('aria-label', 'Sort order');
  [
    ['ascend', 'Ascending'],
    ['descend', 'Descending']
  ].forEach(([value, label]) => {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = label;
    order.appendChild(option);
  });
  order.value = item.sortOrder;
  order.addEventListener('change', () => {
    item.sortOrder = order.value;
  });

  const removeButton = makeButton('×', 'icon', () => {
    state.model.sort.splice(sortIndex, 1);
    renderForm();
    const fields = sortList.querySelectorAll('.sort-field');
    const target = fields[Math.min(sortIndex, fields.length - 1)] || addSortButton;
    target.focus();
  });
  removeButton.setAttribute('aria-label', 'Remove sort field');
  removeButton.title = 'Remove sort field';

  row.append(field, order, removeButton);
  return row;
}

function makeButton(label, className, onClick) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = className;
  button.textContent = label;
  button.addEventListener('click', onClick);
  return button;
}

function focusFirst(container, selector) {
  const match = container ? container.querySelector(selector) : null;
  if (match) {
    match.focus();
  }
}

function focusLast(container, selector) {
  if (!container) {
    return;
  }
  const matches = container.querySelectorAll(selector);
  const last = matches[matches.length - 1];
  if (last) {
    last.focus();
  }
}

function applyFieldNames(payload) {
  const currentProfile = profileSelect.value;
  const currentLayout = layoutSelect.value;
  if (payload && (payload.profileId !== currentProfile || payload.layout !== currentLayout) && payload.layout) {
    return;
  }

  state.fieldMetadata = Array.isArray(payload && payload.fieldMetadata) ? payload.fieldMetadata : [];
  const names = Array.isArray(payload && payload.fieldNames) ? payload.fieldNames : [];
  state.fieldNames = typeof FieldStandards !== 'undefined' ? FieldStandards.orderFields({ fields: state.fieldMetadata }, Object.fromEntries(names.map((name) => [name, true]))) : names;
  fieldNameOptions.replaceChildren(
    ...state.fieldNames.map((name) => {
      const option = document.createElement('option');
      option.value = name;
      return option;
    })
  );

  requestList.querySelectorAll('.criterion-row').forEach((row) => {
    const field = row.querySelector('.criterion-field');
    row.querySelectorAll('.criterion-value').forEach((input) => replaceValueControl(input, field.value));
  });
  fieldNamesHint.classList.remove('error');
  if (payload && payload.error) {
    fieldNamesHint.textContent = `Couldn't load this layout's fields (${payload.error}). You can still type field names.`;
    fieldNamesHint.classList.add('error');
  } else if (state.fieldNames.length > 0) {
    fieldNamesHint.textContent = `${state.fieldNames.length} fields on this layout. Start typing a field name to pick one.`;
  } else {
    fieldNamesHint.textContent = '';
  }
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

runButton.addEventListener('click', () => {
  runQuery();
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
    event.preventDefault();
    if (!state.running) {
      runQuery();
    }
  } else if (event.key === 'Escape') {
    closeMenus();
  }
});

listRecordsButton.addEventListener('click', () => runQuery(true));

cancelButton.addEventListener('click', () => {
  if (!state.running) {
    return;
  }

  // The button is disabled right away, so one click aborts the request once.
  cancelButton.disabled = true;
  vscode.postMessage({
    type: 'cancelRun',
    runId: state.latestRunId
  });
});

function runQuery(listRecords = false) {
  if (state.running || state.savingQuery) {
    return;
  }
  const payload = collectPayload(listRecords);
  if (!payload) {
    return;
  }

  state.latestRunId += 1;
  payload.runId = state.latestRunId;
  state.currentPayload = payload;
  setRunning(true);
  setStatus('Running query…');
  vscode.postMessage({
    type: 'runQuery',
    payload
  });
}

saveButton.addEventListener('click', () => {
  if (state.running || state.savingQuery) return;
  const payload = collectPayload();
  if (!payload) {
    return;
  }

  setQuerySaving(true);
  vscode.postMessage({
    type: 'saveQuery',
    payload: {
      ...payload,
      name: state.currentQueryName
    }
  });
});

exportEditorButton.addEventListener('click', () => {
  vscode.postMessage({ type: 'exportResultsToEditor' });
});

exportJsonButton.addEventListener('click', () => {
  vscode.postMessage({ type: 'exportResultsJsonFile' });
});

exportCsvButton.addEventListener('click', () => {
  vscode.postMessage({ type: 'exportResultsCsvFile' });
});

copyTableButton.addEventListener('click', () => {
  const text = buildResultsTsv();
  if (!text) {
    setStatus('Run a query first. There are no results to copy.', true);
    return;
  }
  if (text.length > MAX_CLIPBOARD_TEXT_LENGTH) {
    setStatus('The results are too large to copy. Use Export → Save results as CSV instead.', true);
    return;
  }
  vscode.postMessage({ type: 'copyText', text, label: 'results table' });
});

// Every format button under "Copy request" names its format (and, for Save as .http, an editor destination).
document.querySelectorAll('[data-copy-format]').forEach((button) => {
  button.addEventListener('click', () => {
    postSnippetRequest(button.dataset.copyFormat, button.dataset.copyDestination === 'editor' ? 'editor' : 'clipboard');
  });
});

function postSnippetRequest(format, destination) {
  const payload = collectPayload();
  if (!payload) {
    return;
  }

  vscode.postMessage({
    type: 'copyRequest',
    payload: {
      ...payload,
      format,
      destination,
      includeAuthHeader: includeAuthCheckbox.checked
    }
  });
}

uploadContainerButton.addEventListener('click', () => {
  const payload = collectProfileLayoutPayload();
  if (!payload) {
    return;
  }

  setStatus('Opening container upload…');
  vscode.postMessage({
    type: 'uploadContainer',
    payload
  });
});

// Menus close after a choice, on outside click, and on Escape.
menus.forEach((menu) => {
  menu.addEventListener('click', (event) => {
    if (event.target instanceof HTMLButtonElement && event.target.closest('.menu-items')) {
      menu.open = false;
    }
  });
  menu.addEventListener('toggle', () => {
    if (menu.open) {
      menus.filter((other) => other !== menu).forEach((other) => {
        other.open = false;
      });
    }
  });
});

document.addEventListener('click', (event) => {
  if (!(event.target instanceof Element) || !event.target.closest('details.menu')) {
    closeMenus();
  }
});

function closeMenus() {
  menus.forEach((menu) => {
    menu.open = false;
  });
}

// ---------------------------------------------------------------------------
// Paging
// ---------------------------------------------------------------------------

prevButton.addEventListener('click', () => {
  const { start, limit } = shownPage();
  runShownQueryAt(Math.max(1, start - limit), limit);
});

nextButton.addEventListener('click', () => {
  const { start, limit } = shownPage();
  runShownQueryAt(start + limit, limit);
});

/** Pages through the query whose results are on screen, even if the form has been edited since. */
function runShownQueryAt(offset, limit) {
  const query = state.lastResult && state.lastResult.query;
  if (!query || state.running) {
    return;
  }
  offsetInput.value = String(offset);
  limitInput.value = String(limit);
  state.latestRunId += 1;
  const payload = { ...query, offset, limit, runId: state.latestRunId };
  state.currentPayload = payload;
  setRunning(true);
  setStatus('Loading page…');
  vscode.postMessage({ type: 'runQuery', payload });
}

/**
 * Start and page size of the results on screen, taken from the request that
 * produced them rather than the (possibly edited) inputs. FileMaker offsets are
 * 1-based: offset 1 is the first record.
 */
function shownPage() {
  const query = (state.lastResult && state.lastResult.query) || {};
  const limit = parseNumber(query.limit) || DEFAULT_LIMIT;
  const start = Math.max(1, parseNumber(query.offset) || 1);
  return { start, limit };
}

function updatePager(returned, foundCount) {
  if (!state.lastResult) {
    prevButton.disabled = true;
    nextButton.disabled = true;
    return;
  }
  const { start, limit } = shownPage();
  prevButton.disabled = start <= 1;
  nextButton.disabled =
    typeof foundCount === 'number' ? start + returned - 1 >= foundCount : returned < limit;
}

// ---------------------------------------------------------------------------
// Payload helpers
// ---------------------------------------------------------------------------

function collectPayload(listRecords = false) {
  const base = collectProfileLayoutPayload();
  if (!base) {
    return undefined;
  }

  if (state.editorMode === 'form') {
    const query = FindForm.modelToFindQuery(state.model);
    if (!listRecords && query.length === 1 && Object.keys(query[0]).length === 0) {
      setStatus('Add at least one field to search on, or choose List records instead.', true, true);
      focusLast(requestList, '.criterion-field');
      return undefined;
    }
    const duplicate = FindForm.findDuplicateField(state.model);
    if (duplicate) {
      setStatus(
        `"${duplicate}" appears twice in one request, and FileMaker keeps only one. Use "between" for a range, or put the second condition in another request.`,
        true
      );
      return undefined;
    }
    writeModelToJson();
  } else if (!listRecords && !findJson.value.trim()) {
    setStatus('Enter a find request, for example [{"Status": "Open"}].', true);
    findJson.focus();
    return undefined;
  }

  if (!listRecords && state.editorMode === 'json') {
    try {
      const query = JSON.parse(findJson.value);
      if (Array.isArray(query) && query.every((request) => request && typeof request === 'object' && !Array.isArray(request)) &&
          !query.some((request) => Object.entries(request).some(([name, value]) => name !== 'omit' && value !== '' && value !== null && value !== undefined))) {
        setStatus('Find criteria are empty. Enter at least one field value to search, or choose List records instead.', true, true);
        return undefined;
      }
    } catch { /* The host reports invalid JSON. */ }
  }

  return {
    ...base,
    ...(listRecords ? { listRecords: true } : {}),
    findJson: findJson.value || '[{}]',
    sortJson: sortJson.value,
    limit: parseNumber(limitInput.value),
    offset: parseNumber(offsetInput.value),
    queryId: state.currentQueryId
  };
}

function collectProfileLayoutPayload() {
  const profileId = profileSelect.value;
  const layout = layoutSelect.value;

  if (!profileId) {
    setStatus('Select a profile.', true);
    return undefined;
  }

  if (!layout) {
    setStatus('Select a layout.', true);
    return undefined;
  }

  return {
    profileId,
    layout
  };
}

function parseNumber(value) {
  if (value === '' || value === undefined || value === null) {
    return undefined;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

// ---------------------------------------------------------------------------
// Persisted panel state
// ---------------------------------------------------------------------------

// The rows are re-rendered on every edit, so one delegated listener keeps up with them.
formEditor.addEventListener('input', () => {
  persistState();
});
formEditor.addEventListener('change', () => {
  persistState();
});
// Adding or removing a request or a sort field is a click, not an input.
formEditor.addEventListener('click', () => {
  persistState();
});

findJson.addEventListener('input', () => {
  persistState();
});

sortJson.addEventListener('input', () => {
  persistState();
});

/**
 * Keeps the work in progress in VS Code's per-webview store, so a window reload
 * brings it back. Only what the user typed is stored; profiles, saved queries,
 * history and results stay with the host.
 */
function persistState() {
  // Nothing is stored while a restore, profile switch or saved-query load is still in
  // flight: what is on screen is not the settled state yet.
  if (restoringState || profileSwitchPending) {
    return;
  }

  vscode.setState({
    v: STATE_VERSION,
    profileId: profileSelect.value,
    layout: layoutSelect.value,
    editorMode: state.editorMode,
    model: copyModel(state.model),
    findJson: findJson.value,
    sortJson: sortJson.value,
    resultView: state.resultView
  });
}

/** The stored snapshot, or undefined when there is none (or it is from another version). */
function readPersistedState() {
  let stored;
  try {
    stored = vscode.getState();
  } catch {
    return undefined;
  }

  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) {
    return undefined;
  }
  if (stored.v !== undefined && stored.v !== STATE_VERSION) {
    return undefined;
  }

  return stored;
}

/** A plain copy of the form model, so the stored snapshot never shares state with the panel. */
function copyModel(model) {
  try {
    return JSON.parse(JSON.stringify(model));
  } catch {
    return FindForm.createEmptyModel();
  }
}

/**
 * The stored form model when it is complete enough to show; undefined when it is
 * not, so a damaged snapshot leaves the empty form rather than a broken one.
 */
function restoreModel(model) {
  if (!model || typeof model !== 'object' || Array.isArray(model)) {
    return undefined;
  }
  if (!Array.isArray(model.requests) || !Array.isArray(model.sort)) {
    return undefined;
  }

  const requests = model.requests.map((request) => {
    const source = asObject(request);
    const criteria = Array.isArray(source.criteria) ? source.criteria : [];
    return {
      omit: source.omit === true,
      criteria: criteria.length > 0
        ? criteria.map((criterion) => restoreCriterion(criterion))
        : FindForm.createEmptyRequest().criteria
    };
  });

  const sort = model.sort.map((item) => {
    const source = asObject(item);
    return {
      fieldName: asText(source.fieldName),
      sortOrder: source.sortOrder === 'descend' ? 'descend' : 'ascend'
    };
  });

  return {
    requests: requests.length > 0 ? requests : [FindForm.createEmptyRequest()],
    sort
  };
}

function restoreCriterion(criterion) {
  const source = asObject(criterion);
  return {
    field: asText(source.field),
    operator: FindForm.OPERATOR_IDS.has(source.operator) ? source.operator : 'match',
    value: asText(source.value),
    value2: asText(source.value2)
  };
}

function asObject(value) {
  return value && typeof value === 'object' ? value : {};
}

function asText(value) {
  return value === undefined || value === null ? '' : String(value);
}

/**
 * Puts back what the panel held before a window reload. A profile or layout the
 * host asked for wins; a stored id that no longer exists falls back to the usual
 * default. The criteria and sort rows are only put back when nothing conflicts:
 * a host that asks for another profile or layout, or a stored profile that is
 * gone, leaves the panel with its empty form — nothing on screen is removed, the
 * find was simply never applied. When they are put back they stay provisional
 * until the layouts arrive: renderLayouts clears them if the stored layout has
 * disappeared from the profile's layouts, so a find is never shown or run
 * against another field list. Every part is restored on its own, so one bad
 * value cannot blank the panel.
 */
function applyPersistedState(saved, payload) {
  state.restoredProfileId = undefined;
  state.restoredLayout = undefined;
  state.restoredCriteriaLayout = undefined;

  if (!saved) {
    return;
  }

  const defaults = payload.defaults;
  const defaultProfileId = defaults && typeof defaults.profileId === 'string' ? defaults.profileId : '';
  const defaultLayout = defaults && typeof defaults.layout === 'string' ? defaults.layout : '';
  const savedProfileId = typeof saved.profileId === 'string' && state.profiles.some((profile) => profile.id === saved.profileId)
    ? saved.profileId
    : '';
  const savedLayout = typeof saved.layout === 'string' ? saved.layout : '';

  if (!defaultProfileId && savedProfileId) {
    state.restoredProfileId = savedProfileId;
  }
  // The stored layout belongs to the stored profile, so it is only used for that profile.
  if (!defaultLayout && savedProfileId && savedLayout && (!defaultProfileId || defaultProfileId === savedProfileId)) {
    state.restoredLayout = savedLayout;
  }

  // The criteria belong to the profile and layout they were written for: they are only
  // put back when the host does not ask for a different one, the stored profile still
  // exists, and a layout was stored at all — without one there is no field list to
  // verify the criteria against, so they are skipped rather than shown and cleared later.
  const criteriaFit = savedProfileId !== ''
    && savedLayout !== ''
    && (!defaultProfileId || defaultProfileId === savedProfileId)
    && (!defaultLayout || defaultLayout === savedLayout);

  // The criteria come back unless the host asked for a saved query, which brings its own.
  let modelRestored = false;
  if (criteriaFit && (!defaults || !defaults.savedQuery)) {
    const model = restoreModel(saved.model);
    if (model) {
      state.model = model;
      // Provisional: the layout list has not arrived yet, so the stored layout cannot be
      // verified here. renderLayouts anchors them once that layout is selected for real,
      // or clears them when the layout has disappeared.
      state.restoredCriteriaLayout = savedLayout;
      modelRestored = true;
    }
  }

  if (saved.editorMode === 'json' || saved.editorMode === 'form') {
    state.editorMode = saved.editorMode;
  }

  if (state.editorMode === 'json' && criteriaFit) {
    const findText = typeof saved.findJson === 'string' ? saved.findJson : undefined;
    const sortText = typeof saved.sortJson === 'string' ? saved.sortJson : undefined;
    if (findText !== undefined || sortText !== undefined) {
      if (findText !== undefined) {
        findJson.value = findText;
      }
      if (sortText !== undefined) {
        sortJson.value = sortText;
      }
    } else if (modelRestored) {
      writeModelToJson();
    }
  }

  if (saved.resultView === 'raw') {
    setResultView('raw');
  }
}

// ---------------------------------------------------------------------------
// Init, profiles, layouts, saved queries
// ---------------------------------------------------------------------------

function applyInit(payload) {
  state.profiles = Array.isArray(payload.profiles) ? payload.profiles : [];
  state.activeProfileId = payload.activeProfileId;
  state.savedQueries = Array.isArray(payload.savedQueries) ? payload.savedQueries : [];
  state.defaults = payload.defaults;

  includeAuthCheckbox.checked = payload.includeAuthByDefault === true;
  state.neutralizeFormulas = payload.neutralizeFormulas !== false;
  state.recordEditEnabled = payload.recordEditEnabled !== false;

  const saved = readPersistedState();

  restoringState = true;
  try {
    applyPersistedState(saved, payload);
    renderProfiles();
    renderSavedQueries();
    renderForm();
    setEditorMode(state.editorMode);

    if (payload.defaults && payload.defaults.savedQuery) {
      applySavedQuery(payload.defaults.savedQuery);
    }
  } finally {
    restoringState = false;
  }

  setStatus('Ready. Press Ctrl/Cmd+Enter to run.');

  // Land keyboard and screen-reader users on the primary control.
  if (profileSelect && typeof profileSelect.focus === 'function') {
    profileSelect.focus();
  }
}

function applyLayouts(payload) {
  if (!payload || typeof payload.profileId !== 'string' || !Array.isArray(payload.layouts)) {
    return;
  }

  state.layoutsByProfile.set(payload.profileId, payload.layouts);
  // A saved query loaded before this profile's layouts arrived names the layout to select.
  const pendingLayout = state.pendingLayoutByProfile.get(payload.profileId);
  state.pendingLayoutByProfile.delete(payload.profileId);

  if (profileSelect.value === payload.profileId) {
    renderLayouts(payload.layouts, pendingLayout || (state.defaults && state.defaults.layout));
    state.defaults = undefined;
    if (status.textContent === 'Loading layouts…') {
      setStatus('Ready. Press Ctrl/Cmd+Enter to run.');
    }
  }
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
    selectedProfileId = state.restoredProfileId || state.activeProfileId || state.profiles[0].id;
  }

  if (!state.profiles.some((profile) => profile.id === selectedProfileId)) {
    selectedProfileId = state.profiles[0].id;
  }

  profileSelect.value = selectedProfileId;
  requestLayouts(selectedProfileId, (state.defaults && state.defaults.layout) || state.restoredLayout);
}

/**
 * Throws away criteria and sort rows that came from the snapshot but lost their field
 * list: the layout they were written for is no longer among the profile's layouts. The
 * JSON editors follow the empty model, so a stale query never survives behind the form,
 * and the marker clears so a later explicit layout choice by the user is never mistaken
 * for an unconfirmed restore.
 */
function clearRestoredCriteria() {
  state.model = FindForm.createEmptyModel();
  renderForm();
  writeModelToJson();
  state.restoredCriteriaLayout = undefined;
}

function renderLayouts(layouts, preferredLayout) {
  // The layout list on screen is settled now, whatever gap it came out of.
  profileSwitchPending = false;
  const list = Array.isArray(layouts) ? layouts : [];
  if (!syncSelectOptions(layoutSelect, list, (layout) => layout, (layout) => layout, 'No layouts available')) {
    // No layouts at all: the select is empty, so restored criteria lost their field list too.
    if (state.restoredCriteriaLayout !== undefined) {
      clearRestoredCriteria();
    }
    // The settled truth is an empty list; storing it stops an older snapshot from
    // bringing the cleared criteria back on the next reload.
    persistState();
    return;
  }

  // The snapshot's layout is the fallback preference when the caller did not name one: a
  // profile switch can race the layout load and drop the pending request, and the user's
  // own choice should come back whenever it still exists.
  const want = preferredLayout
    || ((state.restoredCriteriaLayout !== undefined && list.includes(state.restoredCriteriaLayout))
      ? state.restoredCriteriaLayout
      : undefined);

  if (want && list.includes(want)) {
    layoutSelect.value = want;
  } else if (!list.includes(layoutSelect.value)) {
    layoutSelect.value = list[0];
  }

  if (state.restoredCriteriaLayout !== undefined) {
    if (layoutSelect.value === state.restoredCriteriaLayout) {
      // Their layout really exists: the criteria are anchored to it.
      state.restoredCriteriaLayout = undefined;
    } else {
      // Silent fallback: the layout the criteria were written for is gone (renamed or
      // removed in FileMaker) — clear rather than show a find against another field list.
      clearRestoredCriteria();
    }
  }
  persistState();
}

function requestLayouts(profileId, preferredLayout) {
  if (!profileId) {
    return;
  }

  const cachedLayouts = state.layoutsByProfile.get(profileId);
  if (cachedLayouts) {
    renderLayouts(cachedLayouts, preferredLayout);
    requestFieldNamesForCurrentLayout();
    return;
  }

  if (preferredLayout) {
    state.pendingLayoutByProfile.set(profileId, preferredLayout);
  } else {
    // A manual profile pick replaces any layout left over from an earlier, failed load.
    state.pendingLayoutByProfile.delete(profileId);
  }
  setStatus('Loading layouts…');
  vscode.postMessage({
    type: 'loadLayouts',
    profileId
  });
}

function requestFieldNamesForCurrentLayout() {
  const profileId = profileSelect.value;
  const layout = layoutSelect.value;
  if (!profileId || !layout) {
    applyFieldNames({ profileId: '', layout: '', fieldNames: [] });
    return;
  }
  // Do not temporarily size a new layout using the previous layout's types.
  applyFieldNames({ profileId, layout, fieldNames: [] });
  vscode.postMessage({ type: 'loadFieldNames', profileId, layout });
}

function renderSavedQueries() {
  if (!Array.isArray(state.savedQueries) || state.savedQueries.length === 0) {
    const option = document.createElement('option');
    option.value = '';
    option.textContent = 'No saved queries';
    savedQueriesSelect.replaceChildren(option);
    loadSavedButton.disabled = true;
    return;
  }

  loadSavedButton.disabled = false;
  savedQueriesSelect.replaceChildren(
    ...state.savedQueries.map((query) => {
      const option = document.createElement('option');
      option.value = query.id;
      option.textContent = `${query.name} (${query.layout})`;
      return option;
    })
  );
  if (state.currentQueryId) {
    savedQueriesSelect.value = state.currentQueryId;
  }
}

function applySavedQuery(query) {
  state.currentQueryId = query.id;
  state.currentQueryName = query.name || '';
  // The loaded query replaces whatever the snapshot had: its own layout comes with the
  // request below, so the provisional marker must not outlive it and wipe the load.
  state.restoredCriteriaLayout = undefined;
  // Same in-flight gap as a profile switch: store nothing until the layouts settle.
  profileSwitchPending = true;

  profileSelect.value = query.profileId;
  requestLayouts(query.profileId, query.layout);

  findJson.value = JSON.stringify(query.findJson || [], null, 2);
  sortJson.value = query.sortJson ? JSON.stringify(query.sortJson, null, 2) : '';
  limitInput.value = query.limit !== undefined ? String(query.limit) : '';
  offsetInput.value = query.offset !== undefined ? String(query.offset) : '';

  const parsed = FindForm.jsonToModel(findJson.value, sortJson.value);
  if (parsed.ok) {
    state.model = parsed.model;
    renderForm();
    setEditorMode('form');
  } else {
    setEditorMode('json');
  }
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

tableViewTab.addEventListener('click', () => setResultView('table'));
rawViewTab.addEventListener('click', () => setResultView('raw'));
[tableViewTab, rawViewTab].forEach((tab) => tab.addEventListener('keydown', handleTabArrowKeys));

function setResultView(view) {
  state.resultView = view;
  tableViewTab.setAttribute('aria-selected', String(view === 'table'));
  rawViewTab.setAttribute('aria-selected', String(view === 'raw'));
  tableViewTab.tabIndex = view === 'table' ? 0 : -1;
  rawViewTab.tabIndex = view === 'raw' ? 0 : -1;
  renderResultView();
  persistState();
}

function renderQueryResult(payload) {
  setRunning(false);
  state.lastResult = payload;
  state.resultSort = undefined;
  renderResultView();

  const records = getResultRecords();
  setStatus(`Query completed. ${formatCount(records.length)} record${records.length === 1 ? '' : 's'} returned.`);
}

function getResultRecords() {
  const result = (state.lastResult && state.lastResult.result) || {};
  return Array.isArray(result.data) ? result.data : [];
}

function getDataInfo() {
  const result = (state.lastResult && state.lastResult.result) || {};
  return result.dataInfo && typeof result.dataInfo === 'object' ? result.dataInfo : {};
}

function renderResultView() {
  if (!state.lastResult) {
    resultSummary.textContent = 'No results yet. Run a query to see records here.';
    tableContainer.replaceChildren();
    rawContainer.textContent = '';
    updatePager(0, 0);
    return;
  }

  const records = getResultRecords();
  const dataInfo = getDataInfo();
  const foundCount = typeof dataInfo.foundCount === 'number' ? dataInfo.foundCount : undefined;
  resultSummary.textContent = describeResults(records.length, dataInfo);
  updatePager(records.length, foundCount);

  rawContainer.textContent = JSON.stringify(state.lastResult, null, 2);

  if (state.resultView === 'raw') {
    rawContainer.classList.remove('hidden');
    tableContainer.replaceChildren();
    return;
  }

  rawContainer.classList.add('hidden');

  if (records.length === 0) {
    tableContainer.replaceChildren(createEmptyMessage('No records match this find.'));
    return;
  }

  const columns = collectColumns(records);
  const totalColumns = collectColumns(records, Infinity).length;
  if (totalColumns > columns.length) {
    resultSummary.textContent += ` · first ${columns.length} of ${totalColumns} fields shown (Export includes all)`;
  }
  const sorted = sortRecords(records);

  if (sorted.length >= VIRTUALIZE_THRESHOLD) {
    renderVirtualizedTable(sorted, columns);
    return;
  }

  renderStandardTable(sorted, columns);
}

function describeResults(returned, dataInfo) {
  const layout = state.lastResult && state.lastResult.query ? state.lastResult.query.layout : '';
  if (returned === 0) {
    return layout ? `No records found on ${layout}.` : 'No records found.';
  }

  const { start } = shownPage();
  const end = start + returned - 1;
  const parts = [`Showing ${formatCount(start)}–${formatCount(end)}`];
  if (typeof dataInfo.foundCount === 'number') {
    parts[0] += ` of ${formatCount(dataInfo.foundCount)} found`;
  }
  if (typeof dataInfo.totalRecordCount === 'number') {
    parts.push(`${formatCount(dataInfo.totalRecordCount)} in table`);
  }
  if (layout) {
    parts.push(layout);
  }
  return parts.join(' · ');
}

function formatCount(value) {
  return Number(value).toLocaleString();
}

function collectColumns(records, maxColumns = MAX_COLUMNS) {
  const seen = new Set();

  for (const record of records) {
    const fieldData = record.fieldData && typeof record.fieldData === 'object' ? record.fieldData : {};
    Object.keys(fieldData).forEach((key) => seen.add(key));
  }

  const columns = typeof FieldStandards !== 'undefined'
    ? FieldStandards.orderFields({ fields: state.fieldMetadata }, Object.fromEntries([...seen].map((name) => [name, true]))) : Array.from(seen);
  return columns.slice(0, maxColumns);
}

function getCellRaw(record, column) {
  if (column === 'recordId') {
    return record.recordId;
  }
  const fieldData = record.fieldData && typeof record.fieldData === 'object' ? record.fieldData : {};
  return fieldData[column];
}

function sortRecords(records) {
  if (!state.resultSort) {
    return records;
  }

  const { column, direction } = state.resultSort;
  const factor = direction === 'descending' ? -1 : 1;
  const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

  return records
    .map((record, index) => ({ record, index }))
    .sort((a, b) => {
      const left = getCellRaw(a.record, column);
      const right = getCellRaw(b.record, column);
      const leftEmpty = left === undefined || left === null || left === '';
      const rightEmpty = right === undefined || right === null || right === '';
      if (leftEmpty !== rightEmpty) {
        return leftEmpty ? 1 : -1;
      }
      const compared = compareCells(left, right, collator);
      return compared === 0 ? a.index - b.index : compared * factor;
    })
    .map((item) => item.record);
}

function compareCells(left, right, collator) {
  if (typeof left === 'number' && typeof right === 'number') {
    return left - right;
  }
  // FileMaker returns dates and timestamps as MM/DD/YYYY [HH:MM[:SS]] strings.
  if (typeof left === 'string' && typeof right === 'string' && US_DATE_PATTERN.test(left) && US_DATE_PATTERN.test(right)) {
    const leftTime = Date.parse(left);
    const rightTime = Date.parse(right);
    if (Number.isFinite(leftTime) && Number.isFinite(rightTime)) {
      return leftTime - rightTime;
    }
  }
  return collator.compare(toCellValue(left), toCellValue(right));
}

function toggleResultSort(column) {
  if (!state.resultSort || state.resultSort.column !== column) {
    state.resultSort = { column, direction: 'ascending' };
  } else if (state.resultSort.direction === 'ascending') {
    state.resultSort = { column, direction: 'descending' };
  } else {
    state.resultSort = undefined;
  }
  renderResultView();
  const header = tableContainer.querySelector(`th button[data-column="${CSS.escape(column)}"]`);
  if (header) {
    header.focus();
  }
}

function toCellValue(value) {
  if (value === null || value === undefined) {
    return '';
  }

  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }

  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function buildHeaderRow(columns) {
  const headerRow = document.createElement('tr');

  const actionsHeader = document.createElement('th');
  actionsHeader.className = 'actions-col';
  actionsHeader.textContent = 'Open';
  headerRow.appendChild(actionsHeader);

  ['recordId', ...columns].forEach((column) => {
    const th = document.createElement('th');
    const sortState = state.resultSort && state.resultSort.column === column ? state.resultSort.direction : 'none';
    th.setAttribute('aria-sort', sortState);

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'sort-header';
    button.dataset.column = column;
    button.title = 'Sort this page by this column';
    button.textContent = column;
    if (sortState !== 'none') {
      const indicator = document.createElement('span');
      indicator.className = 'sort-indicator';
      indicator.setAttribute('aria-hidden', 'true');
      indicator.textContent = sortState === 'ascending' ? ' ▲' : ' ▼';
      button.appendChild(indicator);
    }
    th.appendChild(button);
    headerRow.appendChild(th);
  });

  return headerRow;
}

function buildRow(record, columns) {
  const row = document.createElement('tr');
  const recordId = record && record.recordId !== undefined && record.recordId !== null ? String(record.recordId) : '';
  row.dataset.recordId = recordId;
  if (recordId) {
    row.title = 'Double-click to open this record';
  }

  const actionsCell = document.createElement('td');
  actionsCell.className = 'actions-col';
  if (recordId) {
    const view = makeButton('View', 'link', () => openRecord(recordId, 'view'));
    view.setAttribute('aria-label', `View record ${recordId}`);
    view.dataset.action = 'view';
    actionsCell.appendChild(view);
    if (state.recordEditEnabled) {
      const edit = makeButton('Edit', 'link', () => openRecord(recordId, 'edit'));
      edit.setAttribute('aria-label', `Edit record ${recordId}`);
      edit.dataset.action = 'edit';
      actionsCell.appendChild(edit);
    }
  }
  row.appendChild(actionsCell);

  ['recordId', ...columns].forEach((column) => {
    const td = document.createElement('td');
    const text = toCellValue(getCellRaw(record, column));
    td.textContent = text;
    if (text.length > 40) {
      td.title = text;
    }
    row.appendChild(td);
  });

  return row;
}

function openRecord(recordId, mode) {
  const query = state.lastResult && state.lastResult.query;
  if (!query || !recordId) {
    return;
  }
  vscode.postMessage({
    type: 'openRecord',
    payload: { profileId: query.profileId, layout: query.layout, recordId, mode }
  });
}

tableContainer.addEventListener('click', (event) => {
  const header = event.target instanceof Element ? event.target.closest('button.sort-header') : null;
  if (header && header.dataset.column) {
    toggleResultSort(header.dataset.column);
  }
});

tableContainer.addEventListener('dblclick', (event) => {
  if (!(event.target instanceof Element) || event.target.closest('button')) {
    return;
  }
  const row = event.target.closest('tbody tr');
  if (row && row.dataset.recordId) {
    openRecord(row.dataset.recordId, 'view');
  }
});

function createTable(columns) {
  const table = document.createElement('table');
  table.className = 'results-table';
  const thead = document.createElement('thead');
  thead.appendChild(buildHeaderRow(columns));
  const tbody = document.createElement('tbody');
  table.append(thead, tbody);
  return { table, tbody };
}

function renderStandardTable(records, columns) {
  const wrapper = document.createElement('div');
  wrapper.className = 'table-scroll-wrapper';
  const { table, tbody } = createTable(columns);
  records.forEach((record) => tbody.appendChild(buildRow(record, columns)));
  wrapper.appendChild(table);
  tableContainer.replaceChildren(wrapper);
}

function renderVirtualizedTable(records, columns) {
  const container = document.createElement('div');
  container.className = 'virtual-wrap';

  const { table, tbody } = createTable(columns);
  container.appendChild(table);
  tableContainer.replaceChildren(container);

  const rowHeight = 30;
  const buffer = 18;
  const colSpan = columns.length + 2;

  const spacer = (height) => {
    const row = document.createElement('tr');
    row.className = 'spacer';
    row.style.height = `${height}px`;
    const cell = document.createElement('td');
    cell.colSpan = colSpan;
    row.appendChild(cell);
    return row;
  };

  const renderSlice = () => {
    const visibleCount = Math.ceil(container.clientHeight / rowHeight) + buffer;
    const start = Math.max(0, Math.floor(container.scrollTop / rowHeight) - Math.floor(buffer / 2));
    const end = Math.min(records.length, start + visibleCount);

    const sliceRows = [spacer(start * rowHeight)];
    for (let index = start; index < end; index += 1) {
      sliceRows.push(buildRow(records[index], columns));
    }
    sliceRows.push(spacer(Math.max(0, (records.length - end) * rowHeight)));

    // Rebuilding rows would drop keyboard focus; put it back on the same record's button.
    const focused = document.activeElement;
    const focusedRow = focused && tbody.contains(focused) ? focused.closest('tr') : null;
    const focusKey = focusedRow ? { recordId: focusedRow.dataset.recordId, action: focused.dataset.action } : null;

    tbody.replaceChildren(...sliceRows);

    if (focusKey && focusKey.recordId && focusKey.action) {
      const row = Array.from(tbody.rows).find((candidate) => candidate.dataset.recordId === focusKey.recordId);
      const button = row ? row.querySelector(`button[data-action="${focusKey.action}"]`) : null;
      if (button) {
        button.focus({ preventScroll: true });
      }
    }
  };

  let rafPending = false;
  container.addEventListener('scroll', () => {
    if (rafPending) {
      return;
    }
    rafPending = true;
    requestAnimationFrame(() => {
      rafPending = false;
      renderSlice();
    });
  });
  renderSlice();
}

/** Tab-separated text of the visible page, in the on-screen sort order. Pastes into spreadsheets. */
function buildResultsTsv() {
  const records = getResultRecords();
  if (!state.lastResult || records.length === 0) {
    return '';
  }

  const columns = ['recordId', ...collectColumns(records, Infinity)];
  // A cell that a spreadsheet would run as a formula (=HYPERLINK(...), +cmd|...) gets a leading
  // apostrophe, as in the CSV export. Tabs and line breaks are flattened first.
  const clean = (value) => {
    const flat = toCellValue(value).replace(/[\t\r\n]+/g, ' ');
    return state.neutralizeFormulas === false ? flat : window.CellText.neutralizeFormula(flat);
  };
  const lines = [columns.map(clean).join('\t')];
  sortRecords(records).forEach((record) => {
    lines.push(columns.map((column) => clean(getCellRaw(record, column))).join('\t'));
  });
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

function renderHistory() {
  if (!Array.isArray(state.history) || state.history.length === 0) {
    historyContainer.replaceChildren(createEmptyMessage('No requests yet.'));
    return;
  }

  const wrapper = document.createElement('div');
  wrapper.className = 'table-scroll-wrapper';
  const table = document.createElement('table');
  const thead = document.createElement('thead');
  const headerRow = document.createElement('tr');

  ['Time', 'Operation', 'Profile', 'Layout', 'Status', 'Duration'].forEach((title) => {
    const th = document.createElement('th');
    th.textContent = title;
    headerRow.appendChild(th);
  });

  thead.appendChild(headerRow);
  table.appendChild(thead);

  const tbody = document.createElement('tbody');
  const profileNames = new Map(state.profiles.map((profile) => [profile.id, profile.name]));

  for (const entry of state.history) {
    const row = document.createElement('tr');

    addCell(row, entry.timestamp ? new Date(entry.timestamp).toLocaleString() : '');
    addCell(row, entry.operation || '');
    addCell(row, profileNames.get(entry.profileId) || entry.profileId || '');
    addCell(row, entry.layout || '-');
    addCell(row, entry.success ? 'Success' : 'Failure');
    addCell(row, `${entry.durationMs || 0} ms`);

    tbody.appendChild(row);
  }

  table.appendChild(tbody);
  wrapper.appendChild(table);
  historyContainer.replaceChildren(wrapper);
}

function addCell(row, text) {
  const td = document.createElement('td');
  td.textContent = text;
  row.appendChild(td);
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function createEmptyMessage(message) {
  const empty = document.createElement('p');
  empty.className = 'empty';
  empty.textContent = message;
  return empty;
}

function syncSelectOptions(select, items, getValue, getLabel, emptyLabel) {
  if (!Array.isArray(items) || items.length === 0) {
    const option = document.createElement('option');
    option.value = '';
    option.textContent = emptyLabel;
    select.replaceChildren(option);
    return false;
  }

  const existingOptions = new Map(Array.from(select.options).map((option) => [option.value, option]));

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

  queryBuilderSkeleton.classList.toggle('hidden', isVisible);
}

function revealQueryBuilder() {
  if (queryBuilderReady) {
    return;
  }

  queryBuilderReady = true;
  setElementsVisible(queryBuilderPanels, true);
}

/** Results from an older run (one that a newer Run superseded) are ignored. */
function isCurrentRun(runId) {
  return runId === undefined || runId === state.latestRunId;
}

function setRunning(isRunning) {
  state.running = isRunning;
  runButton.disabled = isRunning || state.savingQuery;
  listRecordsButton.disabled = isRunning || state.savingQuery;
  saveButton.disabled = isRunning || state.savingQuery;
  runButton.textContent = isRunning ? 'Running…' : 'Run';
  // Cancel is only offered while a run is in flight, and is ready again for the next one.
  cancelButton.classList.toggle('hidden', !isRunning);
  cancelButton.disabled = false;
}

function setStatus(message, isError = false, offerList = false) {
  listRecordsButton.classList.toggle('hidden', !offerList);
  status.textContent = message;
  status.classList.toggle('error', isError);
}

vscode.postMessage({ type: 'ready' });

function setQuerySaving(saving) {
  state.savingQuery = saving;
  runButton.disabled = saving || state.running;
  listRecordsButton.disabled = saving || state.running;
  saveButton.disabled = saving || state.running;
}
