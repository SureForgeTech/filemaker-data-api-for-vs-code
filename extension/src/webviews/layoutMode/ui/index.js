(function () {
  const vscode = acquireVsCodeApi();

  window.addEventListener('message', function (event) {
    if (event.origin !== window.location.origin) { return; }
    const message = event.data;
    if (!message || typeof message !== 'object') {
      return;
    }

    if (message.type === 'init') {
      var root = document.getElementById('root');
      if (root) {
        root.textContent = 'Layout Mode UI bundle is missing. Build designer-ui to enable the React designer.';
      }
    }
  });

  vscode.postMessage({ type: 'ready' });
})();
