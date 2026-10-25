import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildSync } from 'esbuild';
import postcss from 'postcss';
import { describe, expect, it } from 'vitest';
import { JSDOM, loadPage } from '../../helpers/jsdomPage';

const root = path.resolve(__dirname, '../../../..');
const read = (file: string) => readFileSync(path.join(root, file), 'utf8');
const pages = ['connectionWizard', 'queryBuilder', 'recordViewer', 'recordEditor', 'scriptRunner', 'schemaDiff', 'layoutMode'];
const inline = ['extension/src/diagnostics/diagnosticsDashboard.ts', 'extension/src/settings/effectiveSettings.ts', 'extension/src/webviews/environmentCompare/index.ts', 'extension/src/webviews/common/panelRestore.ts'];
function sharedCss(): string {
  const compiled = buildSync({ entryPoints: [path.join(root, 'shared/src/field-standards.ts')], bundle: true, format: 'cjs', write: false }).outputFiles[0]!.text;
  const module = { exports: {} as { standardFieldsCss: (webview?: boolean) => string } };
  new Function('module', compiled)(module);
  return module.exports.standardFieldsCss(true);
}

// Read individual rules so another selector mentioning focus/readonly cannot mask a regression.
function rule(css: string, selector: string): string {
  const matches = [...css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)];
  const match = matches.find(([, selectors]) => selectors!.split(',').some((item) => item.trim() === selector));
  expect(match, selector).toBeDefined();
  return match![2]!;
}
function declaration(body: string, name: string): string {
  const value = body.split(';').map((item) => item.split(':')).find(([key]) => key?.trim() === name)?.slice(1).join(':').trim();
  expect(value, name).toBeTruthy();
  return value!;
}
function fallbackColor(css: string, theme: string, token: string): string {
  const value = declaration(rule(css, theme), token);
  const fallback = value.match(/var\(--vscode-input-(?:background|foreground),\s*(#[0-9a-f]{6})\)/i)?.[1];
  expect(fallback, `${theme} ${token}`).toBeDefined();
  return fallback!;
}
function luminance(hex: string): number {
  const rgb = hex.slice(1).match(/../g)!.map((part) => parseInt(part, 16) / 255)
    .map((value) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  return rgb[0]! * 0.2126 + rgb[1]! * 0.7152 + rgb[2]! * 0.0722;
}

describe('one stylesheet for extension screens', () => {
  it.each([':root', '.vscode-dark'])('keeps read-only input text at AA contrast with %s fallbacks', (theme) => {
    const css = sharedCss();
    for (const selector of ['[readonly]', '.fm-readonly']) {
      const body = rule(css, selector);
      expect(declaration(body, 'color')).toBe('var(--fm-input-foreground)');
      expect(declaration(body, 'background')).toBe('var(--fm-input-background)');
      expect(body).not.toMatch(/disabledForeground|opacity/);
      expect(body).toContain('border-style: dashed');
      expect(body).toContain('cursor: default');
      expect(body).toContain('resize: none');
    }
    const foreground = luminance(fallbackColor(css, theme, '--fm-input-foreground'));
    const background = luminance(fallbackColor(css, theme, '--fm-input-background'));
    expect((Math.max(foreground, background) + 0.05) / (Math.min(foreground, background) + 0.05)).toBeGreaterThanOrEqual(4.5);
    expect(rule(css, 'input')).toContain('color: var(--fm-input-foreground)');
    expect(rule(css, 'input:disabled')).toContain('--vscode-disabledForeground');
  });

  it('pairs every hover background with an explicit text color in shared and designer styles', () => {
    for (const [file, css] of [['shared extension chrome', sharedCss()], ['designer-ui/src/styles.css', read('designer-ui/src/styles.css')]]) {
      postcss.parse(css!).walkRules((entry) => {
        if (!entry.selector.includes(':hover')) return;
        const declarations = new Map(entry.nodes.filter((node) => node.type === 'decl').map((node) => [node.prop, node.value]));
        if (declarations.has('background') || declarations.has('background-color')) {
          expect(declarations.has('color'), `${file}: ${entry.selector}`).toBe(true);
        }
      });
    }
  });

  it('pairs every secondary button family with hover, active and keyboard-focus paint', () => {
    const sheet = postcss.parse(sharedCss());
    const paint = sheet.nodes.find((node) => node.type === 'rule' && node.selector.includes('.tool-grid button'));
    expect(paint?.type).toBe('rule');
    if (paint?.type !== 'rule') throw new Error('Missing secondary button paint');
    for (const selector of paint.selectors) {
      const state = `${selector}:is(:hover, :active, :focus-visible):not(:disabled)`;
      let found = false;
      sheet.walkRules((entry) => {
        if (!entry.selectors.includes(state)) return;
        found = true;
        expect(declaration(entry.nodes.map((node) => node.toString()).join(';'), 'background'), state).toBe('var(--secondary-hover)');
        expect(declaration(entry.nodes.map((node) => node.toString()).join(';'), 'color'), state).toBe('var(--secondary-text)');
      });
      expect(found, state).toBe(true);
    }
  });

  it('puts Effective Settings inside the shared page wrapper and reserves room for single-line settings buttons', () => {
    const source = read('extension/src/settings/effectiveSettings.ts');
    expect(source).toContain('<body>\n<main class="fm-page">');
    expect(source).toContain('</main>\n<script');
    expect(rule(sharedCss(), '.fm-page')).toContain('padding: 16px');
    expect(rule(source, 'th:last-child')).toContain('width: 240px');
    expect(rule(source, 'button[data-open]')).toContain('white-space: nowrap');
    expect(rule(source, 'button[data-open]')).toContain('word-break: normal');
    expect(rule(source, 'button[data-open]')).toContain('overflow-wrap: normal');
    expect(rule(sharedCss(), 'button')).toContain('min-height: 32px');
    expect(source).toContain('table, thead, tbody, tr, td { display: block; width: 100%; }');
  });

  it('sizes standalone disclosures and compact tabs like shared controls, keeping joined tab strips', () => {
    const css = sharedCss();
    expect(rule(css, 'summary')).toContain('min-height: 32px');
    expect(rule(css, 'summary')).toContain('border-radius: var(--fm-control-radius)');
    expect(rule(css, 'summary')).toContain('font: inherit');
    const wizard = read('extension/src/webviews/connectionWizard/ui/styles.css');
    expect(rule(wizard, '.advanced-toggle > summary')).not.toMatch(/font-size:|padding:/);
    const query = read('extension/src/webviews/queryBuilder/ui/styles.css');
    expect(rule(query, '.history-panel > summary')).not.toContain('min-height: 24px');
    expect(rule(query, ".tabs [role='tab']")).toContain('padding: 5px 12px');
    expect(rule(query, ".tabs [role='tab']")).toContain('border-radius: 0');
    expect(rule(query, ".tabs.compact [role='tab']")).toContain('border-radius: var(--fm-control-radius)');
    expect(rule(read('extension/src/webviews/recordViewer/ui/styles.css'), '.related-block summary')).not.toMatch(/min-height:|padding:/);
  });

  it('uses system colors and lets forced colors adjust read-only fields', () => {
    const forced = sharedCss().match(/@media \(forced-colors: active\)\s*\{([\s\S]*?)\n\}/)?.[1];
    expect(forced).toBeDefined();
    for (const selector of ['[readonly]', '.fm-readonly']) {
      const body = rule(forced!, selector);
      expect(body).toContain('color: CanvasText');
      expect(body).toContain('background: Canvas');
      expect(body).toContain('border-color: CanvasText');
      expect(body).toContain('forced-color-adjust: auto');
    }
  });

  it('keeps empty status live regions rendered before their first message', () => {
    const css = sharedCss();
    for (const selector of ['.status:empty', '.summary:empty', '.fm-banner:empty']) {
      const body = rule(css, selector);
      expect(body).not.toMatch(/display:\s*none|visibility:\s*hidden/);
      expect(body).toContain('min-height: 0');
      expect(body).toContain('padding: 0');
      expect(body).toContain('border: 0');
    }
    for (const page of pages.filter((name) => name !== 'layoutMode')) {
      const css = read(`extension/src/webviews/${page}/ui/styles.css`);
      for (const [, selectors, body] of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
        if (selectors!.split(',').some((selector) => /^\.status(?::empty)?$/.test(selector.trim()))) {
          expect(body, page).not.toMatch(/display:\s*none|visibility:\s*hidden/);
        }
      }
    }
  });

  it('keeps a visible keyboard ring specifically on buttons and summaries', () => {
    const css = sharedCss();
    for (const selector of ['button:focus-visible', 'summary:focus-visible']) {
      expect(rule(css, selector)).toMatch(/outline:\s*2px solid var\(--vscode-contrastActiveBorder, var\(--vscode-focusBorder/);
    }
    const files = [...pages.map((page) => `extension/src/webviews/${page}/ui/${page === 'layoutMode' ? 'index' : 'styles'}.css`), ...inline];
    for (const file of files) {
      for (const [, selector, body] of read(file).matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
        if (/button|\[role=['"](?:button|tab)['"]\]/.test(selector!)) expect(body, `${file}: ${selector}`).not.toMatch(/outline(?:-style|-width)?:\s*(?:none|0)(?:[;\s]|$)/);
      }
    }
  });

  it('gives primary and secondary buttons the same height even outside actions and in grids', () => {
    const body = rule(sharedCss(), 'button');
    expect(body).toContain('min-height: 32px');
    expect(body).toContain('align-self: center');
  });

  it('uses the 34px field height token for page inputs and standard record fields', () => {
    const css = sharedCss();
    expect(css).toContain('--fm-control-height: 34px');
    expect(rule(css, 'select')).toContain('font: inherit');
    expect(css).toMatch(/input:not\(\[type=["']checkbox["']\]\):not\(\[type=["']radio["']\]\)[^{}]*,\s*select\s*\{[^}]*height: var\(--fm-control-height\)/);
    expect(rule(css, '[data-fm-height="34"]')).toContain('--fm-field-height: var(--fm-control-height)');
    expect(rule(css, '.fm-field-control')).toContain('height: var(--fm-field-height)');
    expect(read('extension/src/webviews/scriptRunner/ui/styles.css')).not.toMatch(/min-height: 36px/);
  });

  it.skipIf(!JSDOM)('keeps every page title above bordered content and gives Wizard and Settings a content panel', () => {
    const builders = [...pages.filter((page) => page !== 'layoutMode').map((page) => `extension/src/webviews/${page}/${page === 'queryBuilder' ? 'html' : 'index'}.ts`), ...inline.slice(0, 2)];
    for (const file of builders) {
      const source = read(file);
      const body = source.slice(source.indexOf('<body'), source.indexOf('</body>') + 7);
      const page = loadPage(body, '');
      expect(page.document.querySelectorAll('h1'), file).toHaveLength(1);
      expect(page.document.querySelectorAll('.fm-panel h1, .panel h1, .form-section h1, .card h1'), file).toHaveLength(0);
      expect(page.document.querySelectorAll('.container > h1, .container > header > h1, .wrap > h1, .fm-page > h1'), file).toHaveLength(1);
      expect(page.document.querySelectorAll('.container > .fm-panel, .container > .panel, .fm-page > .fm-panel, .wrap > .card, .container > section'), file).not.toHaveLength(0);
      if (file.includes('connectionWizard')) expect(page.document.querySelectorAll('#wizardForm > .fm-panel #saveBtn')).toHaveLength(1);
      if (file.includes('effectiveSettings')) expect(page.document.querySelectorAll('.fm-panel table')).toHaveLength(1);
    }
  });

  it('owns font, size, panels, controls, headings, buttons, read-only fields, banners, tables and links', () => {
    const css = sharedCss();
    for (const token of ['--vscode-font-family', '--vscode-font-size, 13px', '--fm-page-width: 1200px', '--fm-control-radius: 4px', '--fm-panel-radius: 8px', '--fm-panel-padding: 16px', '--vscode-disabledForeground', '--vscode-input-background', '--vscode-contrastBorder', '--vscode-focusBorder', '--vscode-button-secondaryBackground', '--vscode-textLink-foreground', '--vscode-inputValidation-errorBackground', '--vscode-inputValidation-warningBackground', '--vscode-inputValidation-infoBackground']) expect(css).toContain(token);
    expect(css).toMatch(/h1\s*\{[^}]*font-size: 1\.6em/);
    expect(css).toMatch(/h2\s*\{[^}]*font-size: 1\.2em/);
    expect(css).toMatch(/input, select, textarea\s*\{[^}]*font: inherit/);
    expect(css).toMatch(/\.fm-code\s*\{[^}]*font-family: var\(--vscode-editor-font-family/);
    expect(css).toMatch(/\[readonly\], \.fm-readonly\s*\{[^}]*resize: none/);
    expect(css).toContain('button.secondary');
    expect(css).toContain('button:disabled');
    expect(css).toContain(':focus-visible');
    expect(css).toContain('.fm-banner');
    expect(css).toContain('table {');
    const module = { exports: {} as { standardFieldsCss: () => string } };
    new Function('module', buildSync({ entryPoints: [path.join(root, 'shared/src/field-standards.ts')], bundle: true, write: false, format: 'cjs' }).outputFiles[0]!.text)(module);
    expect(module.exports.standardFieldsCss()).not.toContain('body {');
  });

  it('loads the shared sheet in every HTML builder and ships it beside every page', () => {
    for (const page of pages) {
      const builder = `extension/src/webviews/${page}/${page === 'queryBuilder' ? 'html' : page === 'layoutMode' ? 'panel' : 'index'}.ts`;
      const source = read(builder);
      expect(source, builder).toContain("'fieldStandards.css'");
      expect(source, builder).toContain('<link rel="stylesheet" href="${standardsStyleUri}"');
    }
    for (const builder of inline) {
      expect(read(builder), builder).toContain('<style nonce="${nonce}">${standardFieldsCss(true)}</style>');
    }
    const dir = mkdtempSync(path.join(tmpdir(), 'fm-screen-styles-'));
    try {
      execFileSync(process.execPath, [path.join(root, 'extension/scripts/copy-webviews.mjs'), dir]);
      for (const page of pages) expect(readFileSync(path.join(dir, 'webviews', page, 'ui', 'fieldStandards.css'), 'utf8'), page).toBe(sharedCss());
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('removes competing fonts, button paint, heading scales and banner paint from screen CSS', () => {
    // Canvas handles/selection and Schema Diff status cells are authored graphics, not page controls.
    // Menu hover/selection and sort-header hover are contextual table/menu state, not button defaults.
    // Table-cell badges (including ignored settings) retain their semantic state colors.
    const allowedButtonPaint = /(?:resize-handle|object-list button.selected|sort-header|menu-items button)/;
    const files = [...pages.map((page) => `extension/src/webviews/${page}/ui/${page === 'layoutMode' ? 'index' : 'styles'}.css`), 'designer-ui/src/styles.css', ...inline];
    for (const file of files) {
      const source = read(file);
      const css = file.endsWith('.css') ? source : [...source.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map((m) => m[1]).join('\n');
      expect(css, file).not.toMatch(/font-family\s*:/);
      for (const match of css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
        const [, selector = '', body = ''] = match;
        if (/button|summary\.secondary|\.actions \.(?:primary|secondary)/.test(selector) && !allowedButtonPaint.test(selector)) expect(body, `${file}: ${selector}`).not.toMatch(/background(?:-color)?\s*:/);
        if (/\.status\.(?:error|warning|success)|\.fm-banner|\.template-banner|\.restricted-notice|\.conflict\s*$/.test(selector)) expect(body, `${file}: ${selector}`).not.toMatch(/background|border:|color:/);
        if (/(?:^|[\s,])h[12](?:\s|,|$)/.test(selector)) expect(body, `${file}: ${selector}`).not.toMatch(/font-size:/);
      }
    }
  });

  it('gives Diagnostics and Effective Settings one page title and keeps editor and result polish in CSS', () => {
    expect(read(inline[0]!)).toContain('<h1>FileMaker Diagnostics Dashboard</h1>');
    expect(read(inline[1]!)).toContain('<h1>Effective settings</h1>');
    const editor = read('extension/src/webviews/recordEditor/index.ts');
    for (const id of ['loadButton', 'validateButton', 'previewButton', 'discardButton', 'exportButton']) expect(editor).toContain(`class="secondary" id="${id}"`);
    expect(sharedCss()).toContain('min-height: 32px');
    expect(read('extension/src/webviews/queryBuilder/html.ts')).toContain('<textarea class="fm-code" id="findJson"');
    expect(read('extension/src/webviews/scriptRunner/ui/index.js')).toContain("'builder-json-value fm-code'");
    expect(read('extension/src/webviews/recordEditor/ui/styles.css')).toMatch(/#hiddenNote\s*\{[^}]*margin-bottom: 16px/);
    expect(read('extension/src/webviews/recordEditor/ui/styles.css')).toMatch(/#patchPreview:empty\s*\{[^}]*display: none/);
    expect(read('extension/src/webviews/queryBuilder/ui/styles.css')).toMatch(/\.actions-col a\s*\{[^}]*white-space: nowrap[^}]*overflow-wrap: normal/);
    expect(read('extension/src/webviews/queryBuilder/ui/styles.css')).toMatch(/\.sort-header\s*\{[^}]*min-height: 0[^}]*white-space: nowrap/);
  });
});

// Keep the existing filter and its exact IDs: only the opening selection changes.
describe.skipIf(!JSDOM)('Schema Diff opening selection', () => {
  it('starts with changes and lets the owner show unchanged fields', () => {
    const source = read('extension/src/webviews/schemaDiff/index.ts');
    const body = source.slice(source.indexOf('<main class="container">'), source.indexOf('</main>') + 7);
    const page = loadPage(`<body>${body}</body>`, 'window.requestAnimationFrame = (callback) => callback();\n' + read('extension/src/webviews/schemaDiff/ui/index.js')); 
    page.send({ type: 'diff', payload: { summary: { added: 1, removed: 0, changed: 0 }, added: [{ name: 'Added', type: 'text' }], removed: [], changed: [], unchanged: [{ name: 'Same', type: 'text' }] } });
    expect(page.document.getElementById('changesOnly')?.getAttribute('checked')).not.toBeNull();
    expect(page.document.getElementById('sideBySide')?.textContent).not.toContain('Same');
    const toggle = page.document.getElementById('changesOnly')!;
    toggle.click();
    expect(page.document.getElementById('sideBySide')?.textContent).toContain('Same');
  });
});

it('documents every contributed command in the user guide reference table', () => {
  const manifest = JSON.parse(read('extension/package.json')) as { contributes: { commands: { title: string }[] } };
  const guide = read('extension/docs/USER_GUIDE.md');
  const table = guide.slice(guide.indexOf('## Command reference'), guide.indexOf('\n## ', guide.indexOf('## Command reference') + 4));
  for (const command of manifest.contributes.commands) expect(table).toContain(`| ${command.title.replace(/^FileMaker: /, '')} |`);
});

it('explains the Schema Diff opening filter and readable read-only fields in plain words', () => {
  for (const file of ['CHANGELOG.md', 'extension/CHANGELOG.md']) {
    const shipped = read(file).split('\n## 1.8.0')[1]!.split('\n## ')[0]!;
    expect(shipped).toContain('All screens now share the same fonts, buttons, messages and read-only look.');
    expect(shipped).toContain('**Show only changes** ticked');
  }
  for (const file of ['extension/docs/USER_GUIDE.md', 'docs/FILEMAKER_FAILURE_MODES.md']) {
    expect(read(file), file).toContain('**Show only changes** ticked');
    expect(read(file), file).toContain('dashed border');
    expect(read(file), file).not.toContain('dimmed text');
  }
});
