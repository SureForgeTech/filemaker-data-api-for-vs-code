// @ts-check
/// <reference lib="dom" />

const vscode = acquireVsCodeApi();

document.addEventListener('DOMContentLoaded', () => {
  if (window.__wizardWired) return; window.__wizardWired = true;
  // The page script can be evaluated more than once in the same window (a
  // reloaded webview keeps the old listeners). The guard above stops a second
  // pass from posting 'ready' twice and binding every button twice.

  // The HTML template wraps everything in <form id="wizardForm">. If that ever
  // gets refactored away (it did before — silent regression), fall back to
  // document.body so the input/change/submit listeners still install instead
  // of throwing on null and halting the rest of the script (which would skip
  // Save/Test/message bindings below).
  const form = /** @type {HTMLElement} */ (
    document.getElementById('wizardForm') || document.body
  );
  const directBtn = /** @type {HTMLButtonElement} */ (document.getElementById('modeDirectBtn'));
  const proxyBtn = /** @type {HTMLButtonElement} */ (document.getElementById('modeProxyBtn'));
  const directFields = /** @type {HTMLElement} */ (document.getElementById('directFields'));
  const proxyFields = /** @type {HTMLElement} */ (document.getElementById('proxyFields'));
  const saveBtn = /** @type {HTMLButtonElement} */ (document.getElementById('saveBtn'));
  const testBtn = /** @type {HTMLButtonElement} */ (document.getElementById('testBtn'));
  const statusEl = /** @type {HTMLElement} */ (document.getElementById('status'));
  const templateLockedFields = new Set();

  let authMode = 'direct';
  /** @type {'off'|'warn'|'block'} */
  let testPolicy = 'warn';
  /** @type {{state:'untested'|'success'|'failure'|'stale', message?:string, hash?:string}} */
  let testState = { state: 'untested' };
  let pendingConfirmedSave = false;
  let populatingForm = false;
  let savedPasswordIdentity;
  function passwordIdentity() {
    const origin = (value) => { try { return new URL(value).origin; } catch { return value; } };
    return JSON.stringify([authMode, origin(getValue('serverUrl')), authMode === 'proxy' ? origin(getValue('proxyEndpoint')) : '', authMode === 'direct' ? getValue('username') : '']);
  }

  // Mode toggle
  directBtn.addEventListener('click', () => {
    authMode = 'direct';
    directBtn.classList.add('active');
    proxyBtn.classList.remove('active');
    directBtn.setAttribute('aria-pressed', 'true');
    proxyBtn.setAttribute('aria-pressed', 'false');
    directFields.classList.add('visible');
    proxyFields.classList.remove('visible');
    onFormChanged();
  });

  proxyBtn.addEventListener('click', () => {
    authMode = 'proxy';
    proxyBtn.classList.add('active');
    directBtn.classList.remove('active');
    proxyBtn.setAttribute('aria-pressed', 'true');
    directBtn.setAttribute('aria-pressed', 'false');
    proxyFields.classList.add('visible');
    directFields.classList.remove('visible');
    onFormChanged();
  });

  // Initialize
  directBtn.classList.add('active');
  directFields.classList.add('visible');

  // Focus the first input so screen-reader + keyboard users land on
  // something actionable immediately, not at the document root.
  const firstInput = /** @type {HTMLInputElement|null} */ (document.getElementById('profileName'));
  if (firstInput) {
    firstInput.focus();
  }

  // Track every input edit
  form.addEventListener('input', onFormChanged);
  form.addEventListener('change', onFormChanged);

  // Pressing Enter inside an <input> in a <form> would otherwise trigger a
  // navigation/reload of the webview. The CSP blocks inline onsubmit, so we
  // attach the suppression here.
  form.addEventListener('submit', (event) => {
    event.preventDefault();
  });

  // Save
  saveBtn.addEventListener('click', () => {
    const data = collectFormData();
    if (!data) {
      return;
    }

    const currentHash = hashForm(data);
    const guard = evaluateSaveGuard(currentHash);

    if (guard === 'block') {
      showStatus(
        'error',
        'Save blocked by policy: please run a successful Test Connection on the current values first.'
      );
      return;
    }

    if (guard === 'warn' && !pendingConfirmedSave) {
      showConfirmation();
      return;
    }

    pendingConfirmedSave = false;
    saveBtn.disabled = true;
    saveBtn.textContent = 'Saving...';
    clearStatus();
    vscode.postMessage({ type: 'save', payload: data });
  });

  // Test connection
  testBtn.addEventListener('click', () => {
    const data = collectFormData();
    if (!data) {
      return;
    }

    testBtn.disabled = true;
    testBtn.textContent = 'Testing...';
    clearStatus();

    vscode.postMessage({ type: 'testConnection', payload: data });
  });

  // Message handling
  window.addEventListener('message', (event) => {
    if (event.origin !== window.location.origin) { return; }
    const message = event.data;
    if (!message || typeof message.type !== 'string') {
      return;
    }

    switch (message.type) {
      case 'init':
        if (message.testPolicy === 'off' || message.testPolicy === 'warn' || message.testPolicy === 'block') {
          testPolicy = message.testPolicy;
        }
        {
          const notice = document.getElementById('restrictedNotice');
          if (notice) {
            notice.classList.toggle('hidden', message.restricted !== true);
          }
        }
        renderTestState();
        break;

      case 'saveSuccess':
        showStatus('success', message.message || 'Profile saved successfully.');
        saveBtn.disabled = false;
        saveBtn.textContent = 'Save Profile';
        break;

      case 'saveError':
        showStatus('error', message.message || 'Failed to save profile.');
        saveBtn.disabled = false;
        saveBtn.textContent = 'Save Profile';
        break;

      case 'testStarted': {
        showTestProgress('Reaching server…', message.timeoutMs);
        break;
      }

      case 'testProgress': {
        showTestProgress(message.phase || 'Working…');
        break;
      }

      case 'testSuccess': {
        const data = collectFormData();
        const hash = data ? hashForm(data) : undefined;
        testState = { state: 'success', message: message.message, hash };
        showStatus('success', message.message || 'Connection successful.');
        hideTestProgress();
        renderTestState();
        testBtn.disabled = false;
        testBtn.textContent = 'Test Connection';
        break;
      }

      case 'testError': {
        const data = collectFormData();
        const hash = data ? hashForm(data) : undefined;
        testState = { state: 'failure', message: message.message, hash };
        showStatus('error', message.message || 'Connection failed.');
        if (message.trust) {
          // The actionable message is shown once, here, with the way to act on it.
          const trustBtn = document.createElement('button');
          trustBtn.type = 'button';
          trustBtn.id = 'trustCertFromErrorBtn';
          trustBtn.className = 'secondary';
          trustBtn.textContent = message.trust === 'retrust' ? 'Review and re-trust' : 'Trust this certificate…';
          trustBtn.addEventListener('click', () => reviewCertificate('reviewCertificate'));
          statusEl.appendChild(document.createElement('br'));
          statusEl.appendChild(trustBtn);
        }
        hideTestProgress();
        renderTestState();
        testBtn.disabled = false;
        testBtn.textContent = 'Test Connection';
        break;
      }

      case 'certificateNotice':
        showStatus('warning', message.message);
        break;
      case 'certificateState':
        renderCertificateState(message.payload);
        break;

      // The host picked a CA certificate file, or the user cancelled the dialog
      // and the answer is an empty path. Setting the value does not fire an
      // input event, so the form is told about it: the last test is stale now.
      case 'caBundlePicked': {
        const caBundlePath = /** @type {HTMLInputElement|null} */ (document.getElementById('caBundlePath'));
        if (caBundlePath) {
          caBundlePath.value = typeof message.path === 'string' ? message.path : '';
        }
        onFormChanged();
        break;
      }

      case 'loadProfile':
        clearTemplateState();
        populateForm(message.payload);
        document.getElementById('password').value = '';
        savedPasswordIdentity = message.hasPassword ? passwordIdentity() : undefined;
        document.getElementById('password').placeholder = message.hasPassword ? '••••••• (saved)' : '';
        break;

      case 'loadTemplate':
        populateForm(message.payload && message.payload.template);
        applyTemplateState(message.payload);
        break;

      case 'templateWarning':
        showStatus('warning', message.message || 'Profile template could not be used.');
        break;

      // A failure the host did not expect (the panel could not read the profiles, for
      // example). It is shown in the same status line as the save and test failures.
      case 'error':
        showStatus('error', message.message || 'Something went wrong.');
        break;
    }
  });

  const manageTrustBtn = document.getElementById('manageTrustBtn');
  if (manageTrustBtn) {
    manageTrustBtn.addEventListener('click', () => vscode.postMessage({ type: 'manageWorkspaceTrust' }));
  }

  // Certificate trust is kept by the extension host and changed only through its review dialog;
  // the page just shows it and asks for a review. It is never part of the form data.
  let certPin = undefined;
  let legacyTls = false;
  const certificateStatus = document.getElementById('certificateStatus');
  const reviewCertBtn = document.getElementById('reviewCertBtn');
  const forgetCertBtn = document.getElementById('forgetCertBtn');
  const legacyTlsWarning = document.getElementById('legacyTlsWarning');
  const convertCertBtn = document.getElementById('convertCertBtn');
  const stopSkippingBtn = document.getElementById('stopSkippingBtn');

  function renderCertificateState(state) {
    certPin = state && state.pin ? state.pin : undefined;
    legacyTls = Boolean(state && state.legacy);
    if (certificateStatus) {
      certificateStatus.textContent = certPin
        ? 'Trusted by you: the certificate with SHA-256 ' + certPin.sha256.toUpperCase().replace(/(..)(?=.)/g, '$1:') +
          (certPin.allowExpired ? ' (you accepted that it is expired or not yet valid).' : '.') +
          ' No VS Code setting change is needed. A trusted certificate requires a direct connection without a proxy.'
        : 'No certificate has been trusted by hand. The server\'s certificate is checked the normal way.';
    }
    if (forgetCertBtn) forgetCertBtn.classList.toggle('hidden', !certPin);
    if (legacyTlsWarning) legacyTlsWarning.classList.toggle('hidden', !legacyTls);
    if (certPin || legacyTls) {
      const certificates = document.getElementById('certificateOptions');
      if (certificates) certificates.open = true;
    }
    onFormChanged();
  }

  function reviewCertificate(type) {
    const data = collectFormData();
    if (!data) {
      return;
    }
    vscode.postMessage({ type, payload: data });
  }

  if (reviewCertBtn) reviewCertBtn.addEventListener('click', () => reviewCertificate('reviewCertificate'));
  if (convertCertBtn) convertCertBtn.addEventListener('click', () => reviewCertificate('convertLegacyCertificate'));
  if (forgetCertBtn) forgetCertBtn.addEventListener('click', () => vscode.postMessage({ type: 'forgetCertificate' }));
  if (stopSkippingBtn) stopSkippingBtn.addEventListener('click', () => vscode.postMessage({ type: 'stopSkippingCertificateChecks' }));

  // "Browse…" for the custom CA certificate file: the page cannot open a file
  // dialog itself, so it asks the host for the file and is told the path back.
  const pickCaBundleBtn = document.getElementById('pickCaBundle');
  if (pickCaBundleBtn) {
    pickCaBundleBtn.addEventListener('click', () => vscode.postMessage({ type: 'pickCaBundle' }));
  }

  function collectFormData() {
    const name = getValue('profileName');
    const serverUrl = getValue('serverUrl');
    const database = getValue('database');
    const apiBasePath = getValue('apiBasePath');
    const apiVersionPath = getValue('apiVersionPath');

    if (!name || !serverUrl || !database) {
      showStatus('error', 'Profile name, server URL, and database are required.');
      return null;
    }

    const data = {
      name,
      authMode,
      serverUrl,
      database,
      apiBasePath: apiBasePath || '/fmi/data',
      apiVersionPath: apiVersionPath || 'vLatest',
      caBundlePath: getValue('caBundlePath')
    };

    if (authMode === 'direct') {
      const username = getValue('username');
      const password = getValue('password');
      if (!username) {
        showStatus('error', 'Username is required for direct mode.');
        return null;
      }
      return { ...data, username, password };
    }

    const proxyEndpoint = getValue('proxyEndpoint');
    const proxyApiKey = getValue('proxyApiKey');
    if (!proxyEndpoint) {
      showStatus('error', 'Proxy endpoint is required for proxy mode.');
      return null;
    }
    return { ...data, proxyEndpoint, proxyApiKey };
  }

  function populateForm(profile) {
    if (!profile) return;
    populatingForm = true;
    setFieldValue('profileName', profile.name || '');
    setFieldValue('serverUrl', profile.serverUrl || '');
    setFieldValue('database', profile.database || '');
    const apiBasePath = profile.apiBasePath || '/fmi/data';
    const apiVersionPath = profile.apiVersionPath || 'vLatest';
    setFieldValue('apiBasePath', apiBasePath);
    setFieldValue('apiVersionPath', apiVersionPath);

    // The Advanced server options block is collapsed by default. If the saved
    // profile carries non-default values, open it so the user can see what they
    // previously set — otherwise editing an existing profile would look like
    // those values vanished.
    if (apiBasePath !== '/fmi/data' || apiVersionPath !== 'vLatest') {
      const advanced = /** @type {HTMLDetailsElement|null} */ (
        document.querySelector('.advanced-toggle')
      );
      if (advanced) advanced.open = true;
    }

    // Certificate options come from the saved profile only (never from the workspace template).
    // Open the section when either is set so a saved insecure choice is visible, not hidden.
    setFieldValue('caBundlePath', profile.caBundlePath || '');
    if (profile.caBundlePath || profile.pinnedCertSha256 || profile.allowSelfSigned === true) {
      const certificates = /** @type {HTMLDetailsElement|null} */ (document.getElementById('certificateOptions'));
      if (certificates) certificates.open = true;
    }

    if (profile.authMode === 'proxy') {
      proxyBtn.click();
      setFieldValue('proxyEndpoint', profile.proxyEndpoint || '');
    } else {
      directBtn.click();
      setFieldValue('username', profile.username || '');
    }
    populatingForm = false;
    onFormChanged();
  }

  function getValue(id) {
    const el = /** @type {HTMLInputElement|null} */ (document.getElementById(id));
    return el ? (id === 'password' || id === 'proxyApiKey' ? el.value : el.value.trim()) : '';
  }

  function setFieldValue(id, value) {
    const el = /** @type {HTMLInputElement|null} */ (document.getElementById(id));
    if (el) el.value = value;
  }

  function applyTemplateState(payload) {
    clearTemplateState();
    showTemplateBanner(Array.isArray(payload && payload.hosts) ? payload.hosts : []);

    const lockedFields = Array.isArray(payload && payload.lockedFields)
      ? payload.lockedFields
      : [];
    for (const field of lockedFields) {
      lockTemplateField(String(field));
    }
  }

  function clearTemplateState() {
    hideTemplateBanner();
    for (const field of templateLockedFields) {
      unlockTemplateField(String(field));
    }
    templateLockedFields.clear();
  }

  function showTemplateBanner(hosts) {
    let banner = document.getElementById('profileTemplateBanner');
    if (!banner) {
      banner = document.createElement('div');
      banner.id = 'profileTemplateBanner';
      banner.className = 'template-banner';
      banner.setAttribute('role', 'status');
      const subtitle = document.querySelector('.subtitle');
      if (subtitle?.parentElement) {
        subtitle.insertAdjacentElement('afterend', banner);
      } else {
        form.insertBefore(banner, form.firstChild);
      }
    }
    // The workspace file chose this address, not you. Name it so it can be checked.
    banner.textContent =
      'Using template from .filemaker/profile-template.json.' +
      (hosts.length > 0
        ? ' It points at ' + hosts.join(', ') + '. Check that this is your server before entering a password.'
        : '');
    banner.style.display = '';
  }

  function hideTemplateBanner() {
    const banner = document.getElementById('profileTemplateBanner');
    if (banner) {
      banner.style.display = 'none';
      banner.textContent = '';
    }
  }

  function lockTemplateField(id) {
    const el = /** @type {HTMLInputElement|null} */ (document.getElementById(id));
    if (!el) return;

    el.readOnly = true;
    el.setAttribute('aria-readonly', 'true');
    el.classList.add('template-locked-input');
    el.closest('.field')?.classList.add('template-locked');
    templateLockedFields.add(id);

    if (id === 'apiBasePath' || id === 'apiVersionPath') {
      const advanced = /** @type {HTMLDetailsElement|null} */ (
        document.querySelector('.advanced-toggle')
      );
      if (advanced) advanced.open = true;
    }
  }

  function unlockTemplateField(id) {
    const el = /** @type {HTMLInputElement|null} */ (document.getElementById(id));
    if (!el) return;

    el.readOnly = false;
    el.removeAttribute('aria-readonly');
    el.classList.remove('template-locked-input');
    el.closest('.field')?.classList.remove('template-locked');
  }

  function showStatus(type, message) {
    statusEl.className = 'status ' + type;
    statusEl.textContent = message;
  }

  function clearStatus() {
    statusEl.className = 'status';
    statusEl.textContent = '';
  }

  function onFormChanged() {
    if (populatingForm) return;
    if (savedPasswordIdentity) {
      document.getElementById('password').placeholder = passwordIdentity() === savedPasswordIdentity
        ? '••••••• (saved)' : 'Enter the password again';
    }
    vscode.postMessage({ type: 'addressChanged', payload: { authMode, serverUrl: getValue('serverUrl'), proxyEndpoint: getValue('proxyEndpoint') } });
    pendingConfirmedSave = false;
    if (testState.state === 'success' || testState.state === 'failure') {
      const data = collectFormData();
      const newHash = data ? hashForm(data) : undefined;
      if (newHash !== testState.hash) {
        testState = { state: 'stale', message: testState.message };
      }
    }
    renderTestState();
  }

  function showTestProgress(phase, timeoutMs) {
    let el = document.getElementById('testProgress');
    if (!el) {
      el = document.createElement('div');
      el.id = 'testProgress';
      el.className = 'test-progress';
      el.setAttribute('role', 'status');
      el.setAttribute('aria-live', 'polite');
      const buttonsContainer = saveBtn.parentElement;
      if (buttonsContainer) {
        buttonsContainer.insertBefore(el, saveBtn);
      } else {
        document.body.appendChild(el);
      }
    }
    const timeoutHint =
      typeof timeoutMs === 'number' && timeoutMs > 0
        ? ` (timeout ${Math.round(timeoutMs / 1000)}s)`
        : '';

    // Build the spinner + label via DOM APIs (textContent is safe; innerHTML with
    // a postMessage-sourced phase string trips CodeQL's client-side-XSS check).
    while (el.firstChild) {
      el.removeChild(el.firstChild);
    }
    const spinner = document.createElement('span');
    spinner.className = 'test-progress-spinner';
    spinner.setAttribute('aria-hidden', 'true');
    const text = document.createElement('span');
    text.className = 'test-progress-text';
    text.textContent = `${phase}${timeoutHint}`;
    el.appendChild(spinner);
    el.appendChild(text);
    el.style.display = '';
  }

  function hideTestProgress() {
    const el = document.getElementById('testProgress');
    if (el) {
      el.style.display = 'none';
      el.textContent = '';
    }
  }

  function renderTestState() {
    let badge = document.getElementById('testBadge');
    if (!badge) {
      badge = document.createElement('div');
      badge.id = 'testBadge';
      badge.className = 'test-badge';
      const buttonsContainer = saveBtn.parentElement;
      if (buttonsContainer) {
        buttonsContainer.insertBefore(badge, saveBtn);
      } else {
        document.body.appendChild(badge);
      }
    }

    let label = '';
    let cls = 'test-badge';
    switch (testState.state) {
      case 'untested':
        label = testPolicy === 'off' ? '' : '⚪ Connection not tested';
        cls += ' untested';
        break;
      case 'success':
        label = '🟢 Test passed';
        cls += ' success';
        break;
      case 'failure':
        // The reason is shown once, in the message box below; the badge only says the result.
        label = '🔴 Test failed';
        cls += ' failure';
        break;
      case 'stale':
        label = '🟡 Edits since last test';
        cls += ' stale';
        break;
    }
    badge.textContent = label;
    badge.className = cls;
    badge.style.display = label ? '' : 'none';
  }

  /**
   * @param {string} hash
   * @returns {'ok'|'warn'|'block'}
   */
  function evaluateSaveGuard(hash) {
    if (testPolicy === 'off') return 'ok';
    const passed = testState.state === 'success' && testState.hash === hash;
    if (passed) return 'ok';
    return testPolicy === 'block' ? 'block' : 'warn';
  }

  function showConfirmation() {
    showStatus('warning', 'Test the connection first, or choose Save anyway.');
    const button = document.createElement('button');
    button.id = 'saveAnywayBtn';
    button.type = 'button';
    button.textContent = 'Save anyway';
    button.addEventListener('click', () => {
      pendingConfirmedSave = true;
      saveBtn.click();
    });
    statusEl.appendChild(button);
  }

  /**
   * @param {Record<string, unknown>} data
   * @returns {string}
   */
  function hashForm(data) {
    // This comparison stays in page memory. Changing credentials also invalidates a test.
    const subset = {
      name: data.name,
      authMode: data.authMode,
      serverUrl: data.serverUrl,
      database: data.database,
      apiBasePath: data.apiBasePath,
      apiVersionPath: data.apiVersionPath,
      username: data.username,
      password: data.password,
      proxyApiKey: data.proxyApiKey,
      proxyEndpoint: data.proxyEndpoint,
      caBundlePath: data.caBundlePath,
      // Trusting a different certificate means the earlier test no longer proves the connection.
      pinnedCert: certPin ? certPin.sha256 : undefined,
      legacyTls: legacyTls
    };
    return JSON.stringify(subset);
  }

  // Tell the extension we're ready
  vscode.postMessage({ type: 'ready' });
});
