const vscode = acquireVsCodeApi();

const state = {
  profiles: [],
  activeProfileId: undefined,
  defaults: undefined,
  layoutsByProfile: new Map(),
  lastRecord: undefined
};

const profileSelect = document.getElementById('profileSelect');
const layoutSelect = document.getElementById('layoutSelect');
const recordIdInput = document.getElementById('recordIdInput');
const loadButton = document.getElementById('loadButton');
const exportButton = document.getElementById('exportButton');
const status = document.getElementById('status');
const fieldDataContainer = document.getElementById('fieldDataContainer');
const relatedDataContainer = document.getElementById('relatedDataContainer');
const rawJson = document.getElementById('rawJson');
const fieldCellRefs = new Map();
let presentationFields = [];
const portalSectionRefs = new Map();
const recordViewerPanel = fieldDataContainer.closest('.panel');
const recordViewerHeading = recordViewerPanel ? recordViewerPanel.querySelector('h2') : null;
const recordViewerContent = recordViewerPanel
  ? Array.from(recordViewerPanel.children).filter((element) => element.tagName !== 'H2')
  : [fieldDataContainer, relatedDataContainer, rawJson];
const recordViewerSkeleton = createLoadingSkeleton(['short', 'long', 'medium', 'long']);
let recordViewerReady = false;

if (recordViewerPanel) {
  if (recordViewerHeading) {
    recordViewerHeading.insertAdjacentElement('afterend', recordViewerSkeleton);
  } else {
    recordViewerPanel.prepend(recordViewerSkeleton);
  }

  setElementsVisible(recordViewerContent, false);
}

window.addEventListener('message', (event) => {
  if (event.origin !== window.location.origin) { return; }
  const message = event.data;
  if (!message || typeof message.type !== 'string') {
    return;
  }

  switch (message.type) {
    case 'init': {
      applyInit(message.payload);
      break;
    }
    case 'layoutsLoaded': {
      applyLayouts(message.payload);
      break;
    }
    case 'recordLoaded': {
      loadButton.disabled = false;
      renderRecord(message.payload);
      revealRecordViewer();
      break;
    }
    case 'error': {
      loadButton.disabled = false;
      for (const section of portalSectionRefs.values()) {
        for (const button of section.summary.querySelectorAll('button')) button.disabled = false;
      }
      // Show the form with the error rather than leaving the loading skeleton up.
      revealRecordViewer();
      setStatus(message.message || 'Unknown error.', true);
      break;
    }
    default:
      break;
  }
});

profileSelect.addEventListener('change', () => {
  requestLayouts(profileSelect.value);
});

loadButton.addEventListener('click', () => {
  const payload = collectPayload();
  if (!payload) {
    return;
  }

  loadButton.disabled = true;
  setStatus('Loading record...');
  vscode.postMessage({
    type: 'loadRecord',
    payload
  });
});

exportButton.addEventListener('click', () => {
  vscode.postMessage({ type: 'exportRecord' });
});


// "Copy request for this record": the two selects pick the request and the format, the host builds it.
const copyRecordMenu = document.getElementById('copyRecordMenu');
const copyOperationSelect = document.getElementById('copyOperationSelect');
const copyFormatSelect = document.getElementById('copyFormatSelect');

function postRecordRequest(destination) {
  const payload = collectPayload();
  if (!payload) {
    return;
  }

  vscode.postMessage({
    type: 'copyRecordRequest',
    payload: {
      ...payload,
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

function applyInit(payload) {
  state.profiles = Array.isArray(payload.profiles) ? payload.profiles : [];
  state.activeProfileId = payload.activeProfileId;
  state.defaults = payload.defaults;

  renderProfiles();

  if (state.defaults && state.defaults.recordId) {
    recordIdInput.value = state.defaults.recordId;
  }

  if (state.defaults && state.defaults.recordId && state.defaults.layout) {
    state.autoLoad = true;
    setStatus('Loading record...');
  } else {
    // Nothing to load yet: show the form with an explicit hint instead of an endless loading skeleton.
    revealRecordViewer();
    setStatus('Enter a record ID and select Load Record.');
  }
}

function renderProfiles() {
  profileSelect.innerHTML = '';

  if (state.profiles.length === 0) {
    const option = document.createElement('option');
    option.value = '';
    option.textContent = 'No profiles configured';
    profileSelect.appendChild(option);
    return;
  }

  for (const profile of state.profiles) {
    const option = document.createElement('option');
    option.value = profile.id;
    option.textContent = `${profile.name} (${profile.database})`;
    profileSelect.appendChild(option);
  }

  let profileId = state.defaults && state.defaults.profileId;
  if (!profileId) {
    profileId = state.activeProfileId || state.profiles[0].id;
  }

  profileSelect.value = profileId;
  requestLayouts(profileId, state.defaults && state.defaults.layout);
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
    const wanted = state.defaults && state.defaults.layout;
    renderLayouts(payload.layouts, wanted);
    state.defaults = undefined;

    // Opened for a particular record (from a results row, say): load it now instead of waiting for a click.
    if (state.autoLoad && wanted && layoutSelect.value === wanted && recordIdInput.value.trim()) {
      state.autoLoad = false;
      loadButton.click();
    }
  }
}

function renderLayouts(layouts, preferredLayout) {
  layoutSelect.innerHTML = '';

  if (!Array.isArray(layouts) || layouts.length === 0) {
    const option = document.createElement('option');
    option.value = '';
    option.textContent = 'No layouts available';
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
}

function collectPayload() {
  const profileId = profileSelect.value;
  const layout = layoutSelect.value;
  const recordId = recordIdInput.value.trim();

  if (!profileId) {
    setStatus('Select a profile.', true);
    return undefined;
  }

  if (!layout) {
    setStatus('Select a layout.', true);
    return undefined;
  }

  if (!recordId) {
    setStatus('Enter a record ID.', true);
    return undefined;
  }

  return {
    profileId,
    layout,
    recordId
  };
}

function renderRecord(payload) {
  state.lastRecord = payload;

  const record = payload.record || {};
  const fieldData = record.fieldData && typeof record.fieldData === 'object' ? record.fieldData : {};
  const relatedData = record.portalData && typeof record.portalData === 'object' ? record.portalData : {};

  presentationFields = payload.presentationFields || [];
  renderFieldData(fieldData);
  renderPortalData(relatedData);

  rawJson.textContent = JSON.stringify(payload, null, 2);
  setStatus(`Loaded record ${record.recordId || ''}.`);
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

  recordViewerSkeleton.classList.toggle('hidden', isVisible);
}

function revealRecordViewer() {
  if (recordViewerReady) {
    return;
  }

  recordViewerReady = true;
  setElementsVisible(recordViewerContent, true);
}

function renderFieldData(fieldData) {
  const fieldKeys = typeof FieldStandards !== 'undefined'
    ? FieldStandards.orderFields({ fields: presentationFields }, fieldData) : Object.keys(fieldData);
  if (!fieldKeys.length) {
    fieldCellRefs.clear();
    fieldDataContainer.replaceChildren(createEmptyMessage('No field data.'));
    return;
  }

  buildFieldTable(fieldData, fieldKeys);
}

function buildFieldTable(fieldData, fieldKeys) {
  fieldCellRefs.clear();

  const wrapper = document.createElement('div');
  wrapper.className = 'table-scroll-wrapper';

  const table = document.createElement('table');
  if (typeof FieldStandards !== 'undefined') table.className = 'fm-field-table';

  const thead = document.createElement('thead');
  thead.className = 'visually-hidden';
  const headRow = document.createElement('tr');

  const fieldHeader = document.createElement('th');
  fieldHeader.textContent = 'Field';
  headRow.appendChild(fieldHeader);

  const valueHeader = document.createElement('th');
  valueHeader.textContent = 'Value';
  headRow.appendChild(valueHeader);

  const copyHeader = document.createElement('th');
  copyHeader.textContent = 'Copy';
  headRow.appendChild(copyHeader);

  thead.appendChild(headRow);
  table.appendChild(thead);

  const tbody = document.createElement('tbody');
  if (typeof FieldStandards !== 'undefined') tbody.className = 'fm-fields';

  for (const field of fieldKeys) {
    const row = document.createElement('tr');
    if (typeof FieldStandards !== 'undefined') {
      row.className = 'fm-field';
      FieldStandards.applyStandardField(row, fieldPresentation(field, fieldData[field]));
    }

    const fieldCell = document.createElement('td');
    if (typeof FieldStandards !== 'undefined') fieldCell.className = 'fm-field-label';
    fieldCell.id = `viewer-field-label-${fieldCellRefs.size}`;
    fieldCell.textContent = field;
    row.appendChild(fieldCell);

    const valueCell = document.createElement('td');
    const standard = typeof FieldStandards !== 'undefined';
    valueCell.className = standard ? 'fm-field-control viewer-value' : '';
    const valueControl = standard
      ? FieldStandards.createStandardControl(document, fieldPresentation(field, fieldData[field]), toText(fieldData[field]), () => {}, true)
      : document.createElement('span');
    if (standard) {
      valueControl.setAttribute('aria-label', field);
      valueControl.setAttribute('aria-labelledby', fieldCell.id);
    } else valueControl.textContent = toText(fieldData[field]);
    valueCell.appendChild(valueControl);
    fieldCellRefs.set(field, valueControl);
    row.appendChild(valueCell);

    const copyCell = document.createElement('td');
    const copyButton = document.createElement('button');
    copyButton.textContent = 'Copy';
    copyButton.addEventListener('click', async () => {
      await navigator.clipboard.writeText(toText(state.lastRecord.record.fieldData[field]));
      setStatus(`Copied ${field}.`);
    });
    if (standard) {
      copyButton.className = 'field-copy icon';
      copyButton.textContent = '⧉';
      copyButton.setAttribute('aria-label', `Copy ${field}`);
      copyButton.title = `Copy ${field}`;
      fieldCell.appendChild(copyButton);
    } else {
      copyCell.appendChild(copyButton);
      row.appendChild(copyCell);
    }

    tbody.appendChild(row);
  }

  table.appendChild(tbody);
  wrapper.appendChild(table);
  fieldDataContainer.replaceChildren(wrapper);
}

function fieldPresentation(name, value) {
  const metadata = presentationFields.find((entry) => entry.name === name)
    || presentationFields.find((entry) => entry.name === name.replace(/\(\d+\)$/, '')) || {};
  return { ...metadata, name, value: toText(value) };
}

function renderPortalData(relatedData) {
  const portalKeys = Object.keys(relatedData);
  if (!portalKeys.length) {
    portalSectionRefs.clear();
    relatedDataContainer.replaceChildren(createEmptyMessage('No related rows.'));
    return;
  }

  if (!hasMatchingPortalSections(portalKeys)) {
    buildPortalSections(relatedData, portalKeys);
    return;
  }

  updatePortalSections(relatedData, portalKeys);
}

function hasMatchingPortalSections(portalKeys) {
  return portalSectionRefs.size === portalKeys.length && portalKeys.every((portalKey) => portalSectionRefs.has(portalKey));
}

function buildPortalSections(relatedData, portalKeys) {
  portalSectionRefs.clear();
  relatedDataContainer.replaceChildren();

  portalKeys.forEach((portalKey) => {
    const details = document.createElement('details');
    details.className = 'related-block';

    const summary = document.createElement('summary');
    details.appendChild(summary);

    const content = renderRelatedRows(Array.isArray(relatedData[portalKey]) ? relatedData[portalKey] : []);
    details.appendChild(content);

    portalSectionRefs.set(portalKey, { details, summary, content });
    relatedDataContainer.appendChild(details);
  });

  updatePortalSections(relatedData, portalKeys);
}

function updatePortalSections(relatedData, portalKeys) {
  portalKeys.forEach((portalKey) => {
    const section = portalSectionRefs.get(portalKey);
    if (!section) {
      return;
    }

    const entries = Array.isArray(relatedData[portalKey]) ? relatedData[portalKey] : [];
    const info = (state.lastRecord?.record?.portalDataInfo || []).find((item) => (item.portalObjectName || item.table) === portalKey);
    section.summary.textContent = info
      ? `${portalKey}: showing ${entries.length} of ${info.foundCount}`
      : `${portalKey} (${entries.length})`;
    if (info && entries.length < info.foundCount) {
      const more = document.createElement('button');
      more.type = 'button';
      more.textContent = 'Load more';
      more.addEventListener('click', (event) => {
        event.preventDefault();
        more.disabled = true;
        vscode.postMessage({ type: 'loadRecord', payload: {
          profileId: state.lastRecord.profileId, layout: state.lastRecord.layout,
          recordId: state.lastRecord.record.recordId, portal: portalKey,
          portalLimit: Math.min(entries.length + 50, info.foundCount)
        } });
      });
      section.summary.appendChild(more);
    }
    section.content.textContent = entries.length ? JSON.stringify(entries, null, 2) : 'No related rows.';
  });
}

function renderRelatedRows(rows) {
  if (!Array.isArray(rows) || rows.length === 0) {
    const empty = document.createElement('p');
    empty.textContent = 'No related rows.';
    return empty;
  }

  const pre = document.createElement('pre');
  pre.className = 'raw-small';
  pre.textContent = JSON.stringify(rows, null, 2);
  return pre;
}

function toText(value) {
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

function setStatus(message, isError = false) {
  status.textContent = message;
  status.classList.toggle('error', isError);
}

function createEmptyMessage(message) {
  const empty = document.createElement('p');
  empty.className = 'empty';
  empty.textContent = message;
  return empty;
}

vscode.postMessage({ type: 'ready' });
