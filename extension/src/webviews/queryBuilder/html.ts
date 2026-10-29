import * as vscode from 'vscode';
import { buildWebviewCsp, createNonce } from '../common/csp';
import { versionFooterHtml } from '../../about/runtimeVersion';

export function getHtmlForWebview(webview: vscode.Webview, extensionUri: vscode.Uri): string {
  const uiUri = (file: string): vscode.Uri =>
    webview.asWebviewUri(
      vscode.Uri.joinPath(extensionUri, 'dist', 'webviews', 'queryBuilder', 'ui', file)
    );
  const standardsStyleUri = uiUri('fieldStandards.css');
  const standardsScriptUri = uiUri('fieldStandards.js');
  const styleUri = uiUri('styles.css');
  const findFormUri = uiUri('findForm.js');
  const cellTextUri = uiUri('cellText.js');
  const scriptUri = uiUri('index.js');

  const nonce = createNonce();
  const csp = buildWebviewCsp(webview, {
    nonce
  });

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <title>FileMaker Query Builder</title>
  <link rel="stylesheet" href="${standardsStyleUri}" />
  <link rel="stylesheet" href="${styleUri}" />
</head>
<body>
  <div class="container">
    <header class="header">
      <h1>FileMaker Query Builder</h1>
      <p>Build a find request, run it, and open any record from the results.</p>
    </header>

    <section class="panel" aria-labelledby="queryHeading">
      <h2 id="queryHeading" class="visually-hidden">Query</h2>
      <div class="grid source-grid">
        <div>
          <label for="profileSelect">Profile</label>
          <select id="profileSelect"></select>
        </div>
        <div>
          <label for="layoutSelect">Layout</label>
          <select id="layoutSelect"></select>
        </div>
        <div>
          <label for="savedQueriesSelect">Saved query</label>
          <div class="inline-control">
            <select id="savedQueriesSelect"></select>
            <button id="loadSavedButton" type="button" class="secondary">Load</button>
          </div>
        </div>
      </div>

      <div class="tabs" role="tablist" aria-label="Query editor">
        <button id="formTab" type="button" role="tab" aria-selected="true" aria-controls="formEditor">Form</button>
        <button id="jsonTab" type="button" role="tab" aria-selected="false" aria-controls="jsonEditor" tabindex="-1">JSON</button>
      </div>

      <div id="formEditor" role="tabpanel" aria-labelledby="formTab">
        <datalist id="fieldNameOptions"></datalist>
        <div id="fieldNamesHint" class="hint"></div>
        <div id="requestList" class="request-list"></div>
        <button id="addRequestButton" type="button" class="secondary">Add request (OR)</button>
        <fieldset class="sort-editor">
          <legend>Sort</legend>
          <div id="sortList"></div>
          <button id="addSortButton" type="button" class="secondary">Add sort field</button>
        </fieldset>
      </div>

      <div id="jsonEditor" role="tabpanel" aria-labelledby="jsonTab" class="hidden">
        <div class="row">
          <label for="findJson">Find JSON (array of requests)</label>
          <textarea class="fm-code" id="findJson" rows="6" spellcheck="false">[{}]</textarea>
        </div>
        <div class="row">
          <label for="sortJson">Sort JSON (optional array)</label>
          <textarea class="fm-code" id="sortJson" rows="3" spellcheck="false"></textarea>
        </div>
      </div>

      <div class="grid paging-grid">
        <div>
          <label for="limitInput">Records per page</label>
          <input id="limitInput" type="number" min="1" placeholder="100" />
        </div>
        <div>
          <label for="offsetInput">Start at record</label>
          <input id="offsetInput" type="number" min="1" placeholder="1" />
        </div>
      </div>

      <div class="actions">
        <button id="runButton" type="button" title="Run query (Ctrl/Cmd+Enter)">Run</button>
        <button id="cancelButton" type="button" class="secondary hidden" title="Cancel the query in flight">Cancel</button>
        <button id="saveButton" type="button" class="secondary" title="Save this query (asks for a name)">Save…</button>
        <details class="menu" id="exportMenu">
          <summary class="secondary">Export</summary>
          <div class="menu-items">
            <button id="copyTableButton" type="button">Copy results as table</button>
            <button id="exportCsvButton" type="button">Save results as CSV…</button>
            <button id="exportJsonButton" type="button">Save results as JSON…</button>
            <button id="exportEditorButton" type="button">Open results in editor</button>
          </div>
        </details>
        <details class="menu" id="copyRequestMenu">
          <summary class="secondary">Copy request</summary>
          <div class="menu-items">
            <button id="copyCurlButton" type="button" data-copy-format="curl">Copy as curl</button>
            <button id="copyFetchButton" type="button" data-copy-format="fetch">Copy as fetch()</button>
            <button id="copyHttpButton" type="button" data-copy-format="http">Copy as .http (REST Client)</button>
            <button id="copyPostmanButton" type="button" data-copy-format="postman">Copy as Postman collection</button>
            <button id="copyTypeScriptButton" type="button" data-copy-format="typescript">Copy as TypeScript</button>
            <button id="saveHttpButton" type="button" data-copy-format="http" data-copy-destination="editor" title="Opens the request in a new editor. Save it where you want.">Save as .http file…</button>
            <label class="toggle menu-toggle"><input id="includeAuthCheckbox" type="checkbox" /> Include auth header</label>
          </div>
        </details>
        <button id="uploadContainerButton" type="button" class="secondary">Upload to container…</button>
      </div>
      <p id="status" class="status" role="status" aria-live="polite"></p>
      <button id="listRecordsButton" type="button" class="secondary hidden">List records instead</button>
    </section>

    <section class="panel" aria-labelledby="resultsHeading">
      <div class="results-header">
        <h2 id="resultsHeading">Results</h2>
        <div class="tabs compact" role="tablist" aria-label="Results view">
          <button id="tableViewTab" type="button" role="tab" aria-selected="true" aria-controls="tableContainer">Table</button>
          <button id="rawViewTab" type="button" role="tab" aria-selected="false" aria-controls="rawContainer" tabindex="-1">JSON</button>
        </div>
      </div>
      <div class="results-toolbar">
        <div id="resultSummary" class="summary" role="status" aria-live="polite"></div>
        <div class="pager">
          <button id="prevButton" type="button" class="secondary" disabled>Previous page</button>
          <button id="nextButton" type="button" class="secondary" disabled>Next page</button>
        </div>
      </div>
      <div id="tableContainer" class="table-wrap" role="tabpanel" aria-labelledby="tableViewTab"></div>
      <pre id="rawContainer" class="raw hidden" role="tabpanel" aria-labelledby="rawViewTab"></pre>
    </section>

    <details class="panel history-panel">
      <summary><h2>Request history</h2></summary>
      <div id="historyContainer" class="history"></div>
    </details>
  </div>

  ${versionFooterHtml()}
  <script nonce="${nonce}" src="${findFormUri}"></script>
  <script nonce="${nonce}" src="${cellTextUri}"></script>
  <script nonce="${nonce}" src="${standardsScriptUri}"></script>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}
