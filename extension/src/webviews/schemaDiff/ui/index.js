const vscode = acquireVsCodeApi();

const meta = document.getElementById('meta');
const summary = document.getElementById('summary');
const exportButton = document.getElementById('exportButton');
const sideBySideMode = document.getElementById('sideBySideMode');
const treeMode = document.getElementById('treeMode');
const changesOnly = document.getElementById('changesOnly');
const sideBySidePanel = document.getElementById('sideBySidePanel');
const treePanel = document.getElementById('treePanel');
const sideBySide = document.getElementById('sideBySide');
const tree = document.getElementById('tree');
const diffSections = Array.from(document.querySelectorAll('.container > section'));
const diffSkeleton = createLoadingSkeleton(['short', 'medium', 'long', 'medium']);

let currentDiff;
let currentMode = 'side-by-side';
let diffReady = false;

sideBySideMode.classList.add('active');

diffSections.forEach((section) => {
  section.classList.add('diff-section');
});

const diffHeader = document.querySelector('.container > header');
if (diffHeader && diffSections.length > 0) {
  diffHeader.insertAdjacentElement('afterend', diffSkeleton);
  setElementsVisible(diffSections, false);
}

window.addEventListener('message', (event) => {
  if (event.origin !== window.location.origin) { return; }
  const message = event.data;
  if (!message || typeof message.type !== 'string') {
    return;
  }

  if (message.type === 'error') {
    // The host could not do what the page asked for. Say so in the status line
    // instead of leaving the skeleton on screen forever.
    summary.textContent = message.message || 'Something went wrong.';
    setElementsVisible(diffSections, true);
    markDiffSectionsLoaded();
    return;
  }

  if (message.type !== 'diff') {
    return;
  }

  currentDiff = message.payload;
  renderDiff();
  revealDiff();
});

sideBySideMode.addEventListener('click', () => {
  setMode('side-by-side');
});

treeMode.addEventListener('click', () => {
  setMode('tree');
});

changesOnly.addEventListener('change', () => {
  renderDiff();
});

exportButton.addEventListener('click', () => {
  vscode.postMessage({ type: 'exportJson' });
});

function setMode(mode) {
  currentMode = mode;
  sideBySidePanel.hidden = mode !== 'side-by-side';
  treePanel.hidden = mode !== 'tree';
  sideBySideMode.setAttribute('aria-selected', String(mode === 'side-by-side'));
  treeMode.setAttribute('aria-selected', String(mode === 'tree'));
  sideBySideMode.classList.toggle('active', mode === 'side-by-side');
  treeMode.classList.toggle('active', mode === 'tree');
  renderDiff();
}

function renderDiff() {
  if (!currentDiff) {
    return;
  }

  const fieldRows = buildFieldRows(currentDiff);
  const visibleRows = changesOnly.checked
    ? fieldRows.filter((row) => row.status !== 'unchanged')
    : fieldRows;

  meta.textContent = `${currentDiff.profileId} • ${currentDiff.layout} • Compared ${currentDiff.comparedAt}`;
  summary.textContent = `Added ${currentDiff.summary.added}, Removed ${currentDiff.summary.removed}, Changed ${currentDiff.summary.changed}`;

  if (currentMode === 'side-by-side') {
    renderSideBySide(visibleRows);
  } else {
    renderTree(visibleRows);
  }

  diffSections.forEach((section) => {
    section.classList.remove('loaded');
  });

  requestAnimationFrame(() => {
    diffSections.forEach((section) => {
      section.classList.add('loaded');
    });
  });
}

function buildFieldRows(diff) {
  const rows = [];

  for (const field of diff.removed || []) {
    rows.push({
      name: field.name || '',
      status: 'removed',
      before: field,
      after: undefined,
      changes: []
    });
  }

  for (const item of diff.changed || []) {
    rows.push({
      name: item.fieldName,
      status: 'changed',
      before: item.before,
      after: item.after,
      changes: item.changes || []
    });
  }

  for (const field of diff.added || []) {
    rows.push({
      name: field.name || '',
      status: 'added',
      before: undefined,
      after: field,
      changes: []
    });
  }

  for (const field of diff.unchanged || []) {
    rows.push({
      name: field.name || '',
      status: 'unchanged',
      before: field,
      after: field,
      changes: []
    });
  }

  return rows.sort((left, right) => left.name.localeCompare(right.name));
}

function renderSideBySide(rows) {
  if (!rows.length) {
    sideBySide.replaceChildren(createEmptyMessage('No fields to show'));
    return;
  }

  const fragment = document.createDocumentFragment();
  const grid = document.createElement('div');
  grid.className = 'side-by-side-grid';
  grid.appendChild(createColumnHeader('Old schema'));
  grid.appendChild(createColumnHeader('New schema'));

  for (const row of rows) {
    grid.appendChild(createFieldCell(row.before, row.status, 'before', row.changes));
    grid.appendChild(createFieldCell(row.after, row.status, 'after', row.changes));
  }

  fragment.appendChild(grid);
  sideBySide.replaceChildren(fragment);
}

function createColumnHeader(label) {
  const header = document.createElement('div');
  header.className = 'column-header';
  header.textContent = label;
  return header;
}

function createFieldCell(field, status, side, changes) {
  const cell = document.createElement('article');
  cell.className = `field-cell ${status} ${side}`;

  if (!field) {
    cell.appendChild(createStatusBadge(status));
    cell.appendChild(createEmptyMessage(status === 'added' ? 'Added in new schema' : 'Removed from new schema'));
    return cell;
  }

  const title = document.createElement('div');
  title.className = 'field-title';
  title.textContent = field.name || '(unnamed field)';
  cell.appendChild(title);
  cell.appendChild(createStatusBadge(status));

  const metaList = document.createElement('dl');
  metaList.className = 'field-meta';
  appendMeta(metaList, 'Type', field.result ?? field.type ?? '');
  appendMeta(metaList, 'Kind', field.type ?? '');
  appendMeta(metaList, 'Reps', field.maxRepeat ?? field.repetitions ?? '');
  cell.appendChild(metaList);

  if (changes.length > 0) {
    cell.appendChild(renderChangeList(changes));
  }

  return cell;
}

function appendMeta(list, label, value) {
  const term = document.createElement('dt');
  term.textContent = label;
  const description = document.createElement('dd');
  description.textContent = String(value || '—');
  list.append(term, description);
}

function createStatusBadge(status) {
  const badge = document.createElement('span');
  badge.className = `status-badge ${status}`;
  badge.textContent = status;
  return badge;
}

function renderTree(rows) {
  if (!rows.length) {
    tree.replaceChildren(createEmptyMessage('No fields to show'));
    return;
  }

  const details = document.createElement('details');
  details.open = true;
  details.className = 'schema-tree-root';

  const rootSummary = document.createElement('summary');
  rootSummary.textContent = currentDiff.layout;
  const count = document.createElement('span');
  count.className = 'tree-count';
  count.textContent = `${rows.length} fields`;
  rootSummary.appendChild(count);
  details.appendChild(rootSummary);

  const list = document.createElement('ul');
  list.className = 'schema-tree';
  for (const row of rows) {
    list.appendChild(createTreeLeaf(row));
  }
  details.appendChild(list);

  tree.replaceChildren(details);
}

function createTreeLeaf(row) {
  const item = document.createElement('li');
  item.className = `tree-leaf ${row.status}`;

  const label = document.createElement('span');
  label.className = 'tree-field-name';
  label.textContent = row.name || '(unnamed field)';
  item.appendChild(label);
  item.appendChild(createStatusBadge(row.status));

  const field = row.after || row.before;
  if (field) {
    const type = document.createElement('span');
    type.className = 'tree-field-type';
    type.textContent = `${field.result ?? field.type ?? 'unknown'}${field.type ? ` • Kind: ${field.type}` : ''}`;
    item.appendChild(type);
  }

  if (row.changes.length > 0) {
    item.appendChild(renderChangeList(row.changes));
  }

  return item;
}

function renderChangeList(changes) {
  const list = document.createElement('ul');
  list.className = 'change-list';
  for (const change of changes) {
    const item = document.createElement('li');
    item.textContent = `${change.attribute}: ${JSON.stringify(change.before)} -> ${JSON.stringify(change.after)}`;
    list.appendChild(item);
  }
  return list;
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

  diffSkeleton.classList.toggle('hidden', isVisible);
}

function markDiffSectionsLoaded() {
  diffSections.forEach((section) => {
    section.classList.add('loaded');
  });
}

function revealDiff() {
  if (diffReady) {
    return;
  }

  diffReady = true;
  setElementsVisible(diffSections, true);
}

function createEmptyMessage(message) {
  const empty = document.createElement('p');
  empty.className = 'empty';
  empty.textContent = message;
  return empty;
}

vscode.postMessage({ type: 'ready' });
